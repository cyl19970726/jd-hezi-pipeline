import { expectedFields, PipelineError, type Row } from "./model.js";
import { SourceIndex, type SourceAbsenceProof } from "./source-index.js";
import { Store } from "./store.js";

const KNOWN_PRE_SAVE_FAILURE = "包装名称超过页面长度限制";
const UPLOAD_FAILURE_EVENT = "SAVE_UPLOAD_FAILURE_OBSERVED";
const DISABLED_TITLE_FAILURE =
  "JavaScript evaluation failed at line 0, column 0: Error: Field rejects value: title";

type UploadFailureWitness = {
  url?: unknown;
  at?: unknown;
  selectedTab?: unknown;
  inputs?: unknown;
  main?: unknown;
  detail?: unknown;
  requests?: unknown;
};

function validUploadFailureWitness(
  witness: UploadFailureWitness,
  sku: string,
  title: string,
  operationAt: number,
  expectedMainCount: number,
) {
  let url: URL;
  try {
    url = new URL(String(witness.url));
  } catch {
    return false;
  }
  const observedAt = Date.parse(String(witness.at));
  const tabs = witness.selectedTab;
  const inputs = witness.inputs;
  const main = witness.main;
  const detail = witness.detail;
  const requests = witness.requests;
  if (
    url.origin !== "https://b.csgmall.com.cn" ||
    url.hash !== "#/shop-view/goods/publish?new=1" ||
    !Number.isFinite(observedAt) ||
    !Array.isArray(tabs) ||
    !["商品详情", "上传图片"].includes(String(tabs.at(-1))) ||
    !Array.isArray(inputs) ||
    !Array.isArray(detail) ||
    !Array.isArray(requests) ||
    requests.length === 0 ||
    requests.length >= 200
  )
    return false;
  const links = inputs.filter(
    (input: any) => input?.id === "form_item_linkList_0_goodsLink",
  );
  const titles = inputs.filter(
    (input: any) => input?.id === "form_item_itemName",
  );
  if (
    links.length !== 1 ||
    links[0].value !== `https://item.jd.com/${sku}.html` ||
    titles.length !== 1 ||
    titles[0].value !== title
  )
    return false;
  const invalidImages = detail.filter((image: any) => {
    try {
      const imageUrl = new URL(String(image?.src));
      return (
        imageUrl.pathname.endsWith("/undefined") &&
        image?.complete === true &&
        image?.width === 0
      );
    } catch {
      return false;
    }
  });
  const legacyDetailFailure =
    tabs.at(-1) === "商品详情" &&
    invalidImages.length === 1 &&
    detail.length >= 2 &&
    !detail.some(
      (image: any) =>
        image !== invalidImages[0] &&
        (image?.complete !== true ||
          typeof image?.width !== "number" ||
          image.width <= 0),
    );
  const mainMissingFailure =
    tabs.at(-1) === "上传图片" &&
    Number.isInteger(expectedMainCount) &&
    expectedMainCount > 0 &&
    Array.isArray(main) &&
    main.length >= 1 &&
    main.length < expectedMainCount &&
    detail.length === 0 &&
    main.every((image: any) => {
      try {
        const imageUrl = new URL(String(image?.src));
        return (
          /^https?:$/u.test(imageUrl.protocol) &&
          image?.complete === true &&
          typeof image?.width === "number" &&
          image.width > 0
        );
      } catch {
        return false;
      }
    });
  if (!legacyDetailFailure && !mainMissingFailure) return false;
  const first = requests[0] as any;
  if (
    first?.method !== "GET" ||
    first?.path !== "/proxy/platform/mall/encrypt/enSwitch"
  )
    return false;
  const readOnlyPosts = new Set([
    "/proxy/item/seller/deliveryAddress/queryPage",
    "/proxy/item/shop/itemTmplPublish/queryNameRuleAttributeList",
  ]);
  let uploads = 0;
  let previousStartedAt = -Infinity;
  let previousFinishedAt = -Infinity;
  for (const request of requests as any[]) {
    if (
      typeof request?.path !== "string" ||
      request.finalPath !== request.path ||
      !Number.isFinite(request.startedAt) ||
      !Number.isFinite(request.finishedAt) ||
      request.startedAt < operationAt ||
      request.finishedAt > observedAt ||
      request.finishedAt < request.startedAt ||
      request.startedAt < previousStartedAt ||
      request.finishedAt < previousFinishedAt ||
      !Number.isInteger(request.status)
    )
      return false;
    previousStartedAt = request.startedAt;
    previousFinishedAt = request.finishedAt;
    if (request.method === "GET") continue;
    if (request.method !== "POST") return false;
    if (/\/attachment\/upload$/.test(request.path)) {
      uploads++;
      continue;
    }
    if (!readOnlyPosts.has(request.path)) return false;
  }
  return mainMissingFailure
    ? uploads === main.length + 1 && uploads <= expectedMainCount
    : uploads > 0;
}

/**
 * Narrow recovery for a fully observed detail-image upload timeout before any
 * product save request. This deliberately does not broaden the legacy wrapper
 * validation recovery in confirmSaveNotApplied.
 */
export function confirmUploadFailureSaveNotApplied(
  store: Store,
  productId: string,
  scanId: number,
  now = Date.now(),
): { row: Row; proof: SourceAbsenceProof } {
  const unlock = store.lock("publisher");
  try {
    return store.tx(() => {
      const row = store.get(productId);
      const productRecord: any = store.db
        .prepare("SELECT updated_at,error FROM products WHERE id=?")
        .get(productId);
      const operation: any = store.pending(productId);
      const replacement: any = store.replacement(productId);
      let failure: any = null;
      try {
        failure = JSON.parse(String(productRecord?.error));
      } catch {}
      if (
        row.state !== "UNKNOWN_OUTCOME" ||
        row.remoteId ||
        !operation ||
        operation.kind !== "save" ||
        operation.data_hash !== row.dataHash ||
        replacement?.status === "pending" ||
        failure?.code !== "UI_CHANGED" ||
        !(
          (/waitForFunction timed out/i.test(String(failure?.message)) &&
            /new=1/.test(String(failure?.message))) ||
          (failure?.message === "平台图片上传等待超时，已在保存前停止" &&
            failure?.details?.phase === "media-upload" &&
            failure?.details?.saveDispatched === false &&
            failure?.details?.sku === row.sku &&
            failure?.details?.shop === row.shop)
        )
      )
        throw new PipelineError(
          "UNKNOWN_OUTCOME",
          "该未决操作不属于完整观测的商品详情上传超时",
        );

      const evidenceRows = store.db
        .prepare(
          "SELECT detail,at FROM events WHERE product_id=? AND event=? ORDER BY seq",
        )
        .all(productId, UPLOAD_FAILURE_EVENT) as any[];
      const expectedTitle =
        row.product && row.plan
          ? expectedFields(row.product, row.plan).title
          : null;
      const failureAt = Date.parse(String(productRecord.updated_at));
      const operationAt = Date.parse(String(operation.created_at));
      const matching = evidenceRows.flatMap((event) => {
        try {
          const detail = JSON.parse(String(event.detail));
          const witnessAt = Date.parse(String(detail?.witness?.at));
          return detail?.opId === operation.id &&
            detail?.dataHash === row.dataHash &&
            detail?.sku === row.sku &&
            detail?.shop === row.shop &&
            !!expectedTitle &&
            Number.isFinite(failureAt) &&
            Number.isFinite(operationAt) &&
            witnessAt > failureAt &&
            validUploadFailureWitness(
              detail?.witness ?? {},
              row.sku,
              expectedTitle,
              operationAt,
              row.product?.assets.filter((asset) => asset.role === "main")
                .length ?? 0,
            ) &&
            witnessAt <= Date.parse(String(event.at))
            ? [{ event, detail }]
            : [];
        } catch {
          return [];
        }
      });
      if (matching.length !== 1)
        throw new PipelineError(
          "UNKNOWN_OUTCOME",
          "缺少与未决操作、数据版本和SKU绑定的完整上传失败证据",
        );
      const evidence = matching[0];
      const after = [
        operation.created_at,
        productRecord.updated_at,
        evidence.event.at,
        evidence.detail.witness.at,
      ]
        .map(String)
        .sort((a, b) => Date.parse(b) - Date.parse(a))[0];
      const proof = new SourceIndex(store).proveAbsent(
        scanId,
        row.shop,
        row.sku,
        after,
        now,
      );
      const receipt = {
        outcome: "not-applied",
        reason: "商品详情上传阶段超时，完整请求见证未发生商品保存",
        originalFailure: failure,
        uploadFailureObservation: {
          event: UPLOAD_FAILURE_EVENT,
          observedAt: evidence.event.at,
          witnessAt: evidence.detail.witness.at,
        },
        sourceScan: proof,
      };
      const changed = store.db
        .prepare(
          "UPDATE operations SET status='not_applied',receipt=? WHERE id=? AND status='pending' AND kind='save' AND data_hash=?",
        )
        .run(JSON.stringify(receipt), operation.id, row.dataHash).changes;
      if (changed !== 1)
        throw new PipelineError("UNKNOWN_OUTCOME", "未决保存操作已发生变化");
      const productChanged = store.db
        .prepare(
          "UPDATE products SET state='NEEDS_INPUT',error=?,revision=revision+1,updated_at=? WHERE id=? AND state='UNKNOWN_OUTCOME' AND remote_id IS NULL AND data_hash=?",
        )
        .run(
          JSON.stringify({
            code: "UI_CHANGED",
            message: "商品详情上传超时已证实未触发保存，可安全修复后重试",
            recovery: { outcome: "not-applied", scanId },
          }),
          new Date(now).toISOString(),
          productId,
          row.dataHash,
        ).changes;
      if (productChanged !== 1)
        throw new PipelineError("UNKNOWN_OUTCOME", "商品状态已发生变化");
      store.event(productId, "SAVE_CONFIRMED_NOT_APPLIED", receipt);
      return { row: store.get(productId), proof };
    });
  } finally {
    unlock();
  }
}

/**
 * Recovery for the exact new-product title control rejection raised by
 * formBatch before it mutates any input or reaches the save button.
 */
export function confirmDisabledTitleSaveNotApplied(
  store: Store,
  productId: string,
  scanId: number,
  now = Date.now(),
): { row: Row; proof: SourceAbsenceProof } {
  const unlock = store.lock("publisher");
  try {
    return store.tx(() => {
      const row = store.get(productId);
      const productRecord: any = store.db
        .prepare("SELECT updated_at,error FROM products WHERE id=?")
        .get(productId);
      const operation: any = store.pending(productId);
      const replacement: any = store.replacement(productId);
      const jobs: any[] = store.db
        .prepare(
          "SELECT status,stage,error,updated_at FROM jobs WHERE product_id=? AND shop=? AND sku=?",
        )
        .all(productId, row.shop, row.sku);
      const priorSave: any = store.db
        .prepare(
          "SELECT id FROM operations WHERE product_id=? AND id<>? AND kind IN ('save','create') AND status='observed' LIMIT 1",
        )
        .get(productId, operation?.id ?? "");
      let failure: any = null;
      try {
        failure = JSON.parse(String(productRecord?.error));
      } catch {}
      const matchingJobs = jobs.filter(
        (job) =>
          job.status === "UNKNOWN_OUTCOME" &&
          job.stage === "save" &&
          job.error === DISABLED_TITLE_FAILURE,
      );
      const exactFailure =
        failure?.code === "UI_CHANGED" &&
        typeof failure?.message === "string" &&
        failure.message.startsWith(`${DISABLED_TITLE_FAILURE}\n`) &&
        /\n\s+at formBatch \(<anonymous>:\d+:\d+\)/u.test(failure.message) &&
        /expression: async function formBatch\(args\) \{/u.test(
          failure.message,
        );
      if (
        row.state !== "UNKNOWN_OUTCOME" ||
        row.remoteId ||
        !operation ||
        operation.kind !== "save" ||
        operation.data_hash !== row.dataHash ||
        replacement?.status === "pending" ||
        priorSave ||
        !exactFailure ||
        matchingJobs.length !== 1
      )
        throw new PipelineError(
          "UNKNOWN_OUTCOME",
          "该未决操作不属于已证实的禁用标题字段保存前失败",
        );

      const after = [
        operation.created_at,
        productRecord.updated_at,
        matchingJobs[0].updated_at,
      ]
        .map(String)
        .sort((a, b) => Date.parse(b) - Date.parse(a))[0];
      const proof = new SourceIndex(store).proveAbsent(
        scanId,
        row.shop,
        row.sku,
        after,
        now,
      );
      if (proof.itemCount === 0)
        throw new PipelineError(
          "UNKNOWN_OUTCOME",
          "空店铺扫描不能单独证明禁用标题字段保存未发生",
        );
      const receipt = {
        outcome: "not-applied",
        reason: "新建商品自动命名类目的标题控件在formBatch解析阶段拒绝写入",
        codePathReason:
          "formBatch先解析并校验全部字段；标题控件拒绝发生在输入修改和保存按钮之前",
        originalFailure: failure,
        sourceScan: proof,
      };
      const changed = store.db
        .prepare(
          "UPDATE operations SET status='not_applied',receipt=? WHERE id=? AND status='pending' AND kind='save' AND data_hash=?",
        )
        .run(JSON.stringify(receipt), operation.id, row.dataHash).changes;
      if (changed !== 1)
        throw new PipelineError("UNKNOWN_OUTCOME", "未决保存操作已发生变化");
      const productChanged = store.db
        .prepare(
          "UPDATE products SET state='NEEDS_INPUT',error=?,revision=revision+1,updated_at=? WHERE id=? AND state='UNKNOWN_OUTCOME' AND remote_id IS NULL AND data_hash=?",
        )
        .run(
          JSON.stringify({
            code: "UI_CHANGED",
            message:
              "标题控件保存前拒绝已证实未触发保存，可按自动命名规则修复后重试",
            recovery: { outcome: "not-applied", scanId },
          }),
          new Date(now).toISOString(),
          productId,
          row.dataHash,
        ).changes;
      if (productChanged !== 1)
        throw new PipelineError("UNKNOWN_OUTCOME", "商品状态已发生变化");
      store.event(productId, "SAVE_CONFIRMED_NOT_APPLIED", receipt);
      return { row: store.get(productId), proof };
    });
  } finally {
    unlock();
  }
}

export function confirmSaveNotApplied(
  store: Store,
  productId: string,
  scanId: number,
  now = Date.now(),
): { row: Row; proof: SourceAbsenceProof } {
  const unlock = store.lock("publisher");
  try {
    return store.tx(() => {
      const row = store.get(productId);
      const productRecord: any = store.db
        .prepare("SELECT updated_at,error FROM products WHERE id=?")
        .get(productId);
      const operation: any = store.pending(productId);
      const replacement: any = store.replacement(productId);
      let failure: any = null;
      try {
        failure = JSON.parse(String(productRecord?.error));
      } catch {
        // The exact structured failure is mandatory.
      }
      if (
        row.state !== "UNKNOWN_OUTCOME" ||
        row.remoteId ||
        !operation ||
        operation.kind !== "save" ||
        operation.data_hash !== row.dataHash ||
        replacement?.status === "pending" ||
        failure?.code !== "VALIDATION_MISSING" ||
        failure?.message !== KNOWN_PRE_SAVE_FAILURE
      )
        throw new PipelineError(
          "UNKNOWN_OUTCOME",
          "该未决操作不属于已证实的保存按钮前包装长度失败",
        );
      const after = [operation.created_at, productRecord.updated_at]
        .map(String)
        .sort((a, b) => Date.parse(b) - Date.parse(a))[0];
      const proof = new SourceIndex(store).proveAbsent(
        scanId,
        row.shop,
        row.sku,
        after,
        now,
      );
      const receipt = {
        outcome: "not-applied",
        reason: KNOWN_PRE_SAVE_FAILURE,
        originalFailure: failure,
        sourceScan: proof,
      };
      const changed = store.db
        .prepare(
          "UPDATE operations SET status='not_applied',receipt=? WHERE id=? AND status='pending' AND kind='save' AND data_hash=?",
        )
        .run(JSON.stringify(receipt), operation.id, row.dataHash).changes;
      if (changed !== 1)
        throw new PipelineError("UNKNOWN_OUTCOME", "未决保存操作已发生变化");
      const productChanged = store.db
        .prepare(
          "UPDATE products SET state='NEEDS_INPUT',error=?,revision=revision+1,updated_at=? WHERE id=? AND state='UNKNOWN_OUTCOME' AND remote_id IS NULL AND data_hash=?",
        )
        .run(
          JSON.stringify({
            code: "VALIDATION_MISSING",
            message: KNOWN_PRE_SAVE_FAILURE,
            recovery: { outcome: "not-applied", scanId },
          }),
          new Date(now).toISOString(),
          productId,
          row.dataHash,
        ).changes;
      if (productChanged !== 1)
        throw new PipelineError("UNKNOWN_OUTCOME", "商品状态已发生变化");
      store.event(productId, "SAVE_CONFIRMED_NOT_APPLIED", receipt);
      return { row: store.get(productId), proof };
    });
  } finally {
    unlock();
  }
}
