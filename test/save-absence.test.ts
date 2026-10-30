import test from "node:test";
import assert from "node:assert/strict";
import { example } from "../src/demo.js";
import { expectedFields } from "../src/model.js";
import {
  confirmDisabledTitleSaveNotApplied,
  confirmSaveNotApplied,
  confirmUploadFailureSaveNotApplied,
} from "../src/save-absence.js";
import { Jobs } from "../src/jobs.js";
import { SourceIndex } from "../src/source-index.js";
import { Store } from "../src/store.js";

const NOW = Date.parse("2026-09-12T00:00:00.000Z");
const emptyCoverage = [
  "visible-normal",
  "visible-draft",
  "hidden-normal",
  "hidden-draft",
].map((partition) => ({ partition, expected: 0, seen: 0 }));

function setup(
  failure: { code: string; message: string } = {
    code: "VALIDATION_MISSING",
    message: "包装名称超过页面长度限制",
  },
) {
  const store = new Store(":memory:");
  const { product, plan } = example();
  plan.shop = "shop";
  const row = store.put("shop", product);
  store.setPlan(row.id, plan);
  const operationId = store.intent(row.id, "save");
  store.state(row.id, "UNKNOWN_OUTCOME", failure);
  store.db
    .prepare("UPDATE operations SET created_at=? WHERE id=?")
    .run("2026-09-11T10:00:00.000Z", operationId);
  store.db
    .prepare("UPDATE products SET updated_at=? WHERE id=?")
    .run("2026-09-11T10:01:00.000Z", row.id);
  return { store, id: row.id, operationId };
}

function scan(
  store: Store,
  options: { sku?: string; resolved?: boolean; partial?: boolean } = {},
) {
  const index = new SourceIndex(store);
  const scanId = index.begin("shop");
  let coverage = emptyCoverage;
  if (options.sku || options.resolved === false) {
    index.put(
      scanId,
      "shop",
      {
        itemId: "123",
        code: "123",
        title: "observed",
        shop: "shop",
        status: "待提交",
        sku: "",
      },
      "revision",
      options.sku ? [options.sku] : [],
      options.resolved !== false,
    );
    coverage = emptyCoverage.map((entry) =>
      entry.partition === "visible-normal"
        ? { ...entry, expected: 1, seen: 1 }
        : entry,
    );
  }
  index.finish(scanId, coverage, options.partial);
  store.db
    .prepare("UPDATE source_scans SET started_at=?,finished_at=? WHERE id=?")
    .run("2026-09-11T10:02:00.000Z", "2026-09-11T10:03:00.000Z", scanId);
  return scanId;
}

test("fresh complete zero-match scan atomically closes only the known pre-save failure", () => {
  const s = setup();
  try {
    const scanId = scan(s.store);
    const result = confirmSaveNotApplied(s.store, s.id, scanId, NOW);
    assert.equal(result.row.state, "NEEDS_INPUT");
    assert.equal(result.proof.scanId, scanId);
    assert.equal(result.proof.itemCount, 0);
    assert.equal(s.store.pending(s.id), undefined);
    const operation: any = s.store.db
      .prepare("SELECT * FROM operations WHERE id=?")
      .get(s.operationId);
    assert.equal(operation.status, "not_applied");
    assert.equal(JSON.parse(operation.receipt).sourceScan.scanId, scanId);
    assert.ok(
      s.store.db
        .prepare(
          "SELECT 1 FROM events WHERE product_id=? AND event='SAVE_CONFIRMED_NOT_APPLIED'",
        )
        .get(s.id),
    );
  } finally {
    s.store.close();
  }
});

const disabledTitleMessage = `${"JavaScript evaluation failed at line 0, column 0: Error: Field rejects value: title"}\n    at formBatch (<anonymous>:59:23)\n    at __egoPageEvaluate (<anonymous>:95:3); expression: async function formBatch(args) {`;

function disabledTitleSetup() {
  const s = setup({ code: "UI_CHANGED", message: disabledTitleMessage });
  const row = s.store.get(s.id);
  const jobs = new Jobs(s.store, "shop");
  const job = jobs.enqueue([row.sku], {
    source: "browser",
    brandId: "brand",
    categoryId: "category",
    policyId: "policy",
    unit: "件",
    through: "draft",
  }).items[0];
  s.store.db
    .prepare(
      "UPDATE jobs SET product_id=?,status='UNKNOWN_OUTCOME',stage='save',error=?,updated_at=? WHERE id=?",
    )
    .run(
      s.id,
      disabledTitleMessage.split("\n")[0],
      "2026-09-11T10:01:00.000Z",
      job.id,
    );
  return { ...s, jobId: job.id };
}

test("exact disabled-title pre-save failure plus a later nonempty absence scan closes its bound save", () => {
  const s = disabledTitleSetup();
  try {
    const scanId = scan(s.store, { sku: "999999999999" });
    const result = confirmDisabledTitleSaveNotApplied(
      s.store,
      s.id,
      scanId,
      NOW,
    );
    assert.equal(result.row.state, "NEEDS_INPUT");
    assert.equal(result.proof.itemCount, 1);
    const operation: any = s.store.db
      .prepare("SELECT status,receipt FROM operations WHERE id=?")
      .get(s.operationId);
    assert.equal(operation.status, "not_applied");
    const receipt = JSON.parse(operation.receipt);
    assert.equal(receipt.sourceScan.scanId, scanId);
    assert.match(receipt.codePathReason, /保存按钮之前/u);
    assert.equal(receipt.originalFailure.message, disabledTitleMessage);
  } finally {
    s.store.close();
  }
});

for (const scenario of [
  "wrong message",
  "wrong job stage",
  "other operation",
  "remote binding",
  "prior observed save",
  "stale scan",
  "partial scan",
  "SKU match",
  "empty scan",
] as const) {
  test(`disabled-title recovery rejects ${scenario}`, () => {
    const s = disabledTitleSetup();
    try {
      if (scenario === "wrong message")
        s.store.db.prepare("UPDATE products SET error=? WHERE id=?").run(
          JSON.stringify({
            code: "UI_CHANGED",
            message: disabledTitleMessage.replace("title", "model"),
          }),
          s.id,
        );
      if (scenario === "wrong job stage")
        s.store.db
          .prepare("UPDATE jobs SET stage='assets' WHERE id=?")
          .run(s.jobId);
      if (scenario === "other operation")
        s.store.db
          .prepare("UPDATE operations SET kind='submit' WHERE id=?")
          .run(s.operationId);
      if (scenario === "remote binding")
        s.store.db
          .prepare("UPDATE products SET remote_id='remote' WHERE id=?")
          .run(s.id);
      if (scenario === "prior observed save")
        s.store.db
          .prepare(
            "INSERT INTO operations VALUES('old-save',?,'save',?,'observed','{}',?)",
          )
          .run(s.id, s.store.get(s.id).dataHash, "2026-09-11T09:00:00.000Z");
      const scanId = scan(s.store, {
        sku:
          scenario === "empty scan"
            ? undefined
            : scenario === "SKU match"
              ? s.store.get(s.id).sku
              : "999999999999",
        partial: scenario === "partial scan",
      });
      if (scenario === "stale scan")
        s.store.db
          .prepare("UPDATE source_scans SET started_at=? WHERE id=?")
          .run("2026-09-11T10:00:30.000Z", scanId);
      assert.throws(
        () => confirmDisabledTitleSaveNotApplied(s.store, s.id, scanId, NOW),
        /禁用标题|扫描|SKU|空店铺/u,
      );
      assert.equal(s.store.pending(s.id)?.id, s.operationId);
      assert.equal(s.store.get(s.id).state, "UNKNOWN_OUTCOME");
    } finally {
      s.store.close();
    }
  });
}

for (const scenario of [
  "old scan",
  "scan before failure",
  "future scan",
  "partial scan",
  "unresolved item",
  "SKU match",
  "remote binding",
  "changed hash",
  "ordinary unknown",
  "submit intent",
] as const) {
  test(`${scenario} cannot clear a pending save`, () => {
    const s = setup(
      scenario === "ordinary unknown"
        ? {
            code: "UNKNOWN_OUTCOME",
            message: "Ego 调用超时；页面操作可能已经生效",
          }
        : undefined,
    );
    try {
      const scanId = scan(s.store, {
        sku: scenario === "SKU match" ? "100000000001" : undefined,
        resolved: scenario === "unresolved item" ? false : undefined,
        partial: scenario === "partial scan",
      });
      if (scenario === "old scan")
        s.store.db
          .prepare("UPDATE source_scans SET started_at=? WHERE id=?")
          .run("2026-09-11T09:59:00.000Z", scanId);
      if (scenario === "scan before failure")
        s.store.db
          .prepare("UPDATE source_scans SET started_at=? WHERE id=?")
          .run("2026-09-11T10:00:30.000Z", scanId);
      if (scenario === "future scan")
        s.store.db
          .prepare("UPDATE source_scans SET finished_at=? WHERE id=?")
          .run("2026-09-13T10:03:00.000Z", scanId);
      if (scenario === "unresolved item")
        s.store.db
          .prepare("UPDATE source_scans SET status='complete' WHERE id=?")
          .run(scanId);
      if (scenario === "remote binding")
        s.store.db
          .prepare(
            "UPDATE products SET remote_id='999',remote_code='999' WHERE id=?",
          )
          .run(s.id);
      if (scenario === "changed hash")
        s.store.db
          .prepare("UPDATE operations SET data_hash='changed' WHERE id=?")
          .run(s.operationId);
      if (scenario === "submit intent")
        s.store.db
          .prepare("UPDATE operations SET kind='submit' WHERE id=?")
          .run(s.operationId);
      assert.throws(
        () => confirmSaveNotApplied(s.store, s.id, scanId, NOW),
        /未决|扫描|按钮前/,
      );
      assert.equal(s.store.pending(s.id)?.id, s.operationId);
      assert.equal(s.store.get(s.id).state, "UNKNOWN_OUTCOME");
    } finally {
      s.store.close();
    }
  });
}

test("a complete scan is rejected once a newer scan exists", () => {
  const s = setup();
  try {
    const candidate = scan(s.store);
    new SourceIndex(s.store).begin("shop");
    assert.throws(
      () => confirmSaveNotApplied(s.store, s.id, candidate, NOW),
      /最新完整观察/,
    );
    assert.ok(s.store.pending(s.id));
  } finally {
    s.store.close();
  }
});

function uploadWitness(sku = "100000000001", title = "商品标题") {
  const operationAt = Date.parse("2026-09-11T10:00:00.000Z");
  const request = (path: string, method = "GET", n = 1) => ({
    path,
    finalPath: path,
    method,
    status: 200,
    startedAt: operationAt + n * 100,
    finishedAt: operationAt + n * 100 + 50,
  });
  const requests = [
    request("/proxy/platform/mall/encrypt/enSwitch", "GET", 1),
    ...Array.from({ length: 42 }, (_, index) =>
      request(`/readonly/${index}`, "GET", index + 2),
    ),
    request("/proxy/item/seller/deliveryAddress/queryPage", "POST", 44),
    request(
      "/proxy/item/shop/itemTmplPublish/queryNameRuleAttributeList",
      "POST",
      45,
    ),
    request("/proxy/item-service/attachment/upload", "POST", 46),
  ];
  return {
    url: "https://b.csgmall.com.cn/shop-view/#/shop-view/goods/publish?new=1",
    at: "2026-09-11T10:01:30.000Z",
    selectedTab: ["商品信息编辑", "商品详情"],
    inputs: [
      { id: "form_item_itemName", value: title },
      {
        id: "form_item_linkList_0_goodsLink",
        value: `https://item.jd.com/${sku}.html`,
      },
    ],
    main: [] as Array<{
      src: string;
      complete: boolean;
      width: number;
    }>,
    detail: [
      {
        src: "https://b.csgmall.com.cn/shop-view/undefined",
        complete: true,
        width: 0,
      },
      {
        src: "https://cdn.example.com/detail.jpg",
        complete: true,
        width: 790,
      },
    ],
    requests,
  };
}

function uploadRecovery(
  mutate?: (witness: ReturnType<typeof uploadWitness>) => void,
) {
  const s = setup({
    code: "UI_CHANGED",
    message:
      "Error: waitForFunction timed out on goods publish?new=1 during detail upload",
  });
  const row = s.store.get(s.id);
  const witness = uploadWitness(
    row.sku,
    expectedFields(row.product!, row.plan!).title,
  );
  mutate?.(witness);
  s.store.event(s.id, "SAVE_UPLOAD_FAILURE_OBSERVED", {
    opId: s.operationId,
    dataHash: row.dataHash,
    sku: row.sku,
    shop: row.shop,
    witness,
  });
  s.store.db
    .prepare(
      "UPDATE events SET at=? WHERE product_id=? AND event='SAVE_UPLOAD_FAILURE_OBSERVED'",
    )
    .run("2026-09-11T10:02:00.000Z", s.id);
  const scanId = scan(s.store);
  s.store.db
    .prepare("UPDATE source_scans SET started_at=?,finished_at=? WHERE id=?")
    .run("2026-09-11T10:03:00.000Z", "2026-09-11T10:04:00.000Z", scanId);
  return { ...s, scanId };
}

test("complete upload-stage witness plus a later absence scan closes only its bound save", () => {
  const s = uploadRecovery();
  try {
    const result = confirmUploadFailureSaveNotApplied(
      s.store,
      s.id,
      s.scanId,
      NOW,
    );
    assert.equal(result.row.state, "NEEDS_INPUT");
    const operation: any = s.store.db
      .prepare("SELECT * FROM operations WHERE id=?")
      .get(s.operationId);
    assert.equal(operation.status, "not_applied");
    const receipt = JSON.parse(operation.receipt);
    assert.equal(receipt.sourceScan.scanId, s.scanId);
    assert.equal(
      receipt.uploadFailureObservation.event,
      "SAVE_UPLOAD_FAILURE_OBSERVED",
    );
  } finally {
    s.store.close();
  }
});

function asMissingMainWitness(
  witness: ReturnType<typeof uploadWitness>,
  wrongTitle = false,
) {
  witness.selectedTab = ["商品信息编辑", "上传图片"];
  witness.main = [
    { src: "https://cdn.example.com/main-1.jpg", complete: true, width: 800 },
    { src: "https://cdn.example.com/main-2.jpg", complete: true, width: 800 },
  ];
  witness.detail = [];
  if (wrongTitle)
    witness.inputs.find((input) => input.id === "form_item_itemName")!.value =
      "错误标题";
  const last = witness.requests.at(-1)!;
  witness.requests.push(
    {
      ...last,
      startedAt: last.startedAt + 100,
      finishedAt: last.finishedAt + 100,
    },
    {
      ...last,
      startedAt: last.startedAt + 200,
      finishedAt: last.finishedAt + 200,
    },
  );
}

test("complete main-image missing witness plus a later scan closes its bound save", () => {
  const s = uploadRecovery((witness) => asMissingMainWitness(witness));
  try {
    const result = confirmUploadFailureSaveNotApplied(
      s.store,
      s.id,
      s.scanId,
      NOW,
    );
    assert.equal(result.row.state, "NEEDS_INPUT");
    assert.equal(result.proof.scanId, s.scanId);
    assert.equal(s.store.pending(s.id), undefined);
  } finally {
    s.store.close();
  }
});

test("main-image missing witness rejects a wrong title", () => {
  const s = uploadRecovery((witness) => asMissingMainWitness(witness, true));
  try {
    assert.throws(
      () => confirmUploadFailureSaveNotApplied(s.store, s.id, s.scanId, NOW),
      /证据/u,
    );
    assert.ok(s.store.pending(s.id));
  } finally {
    s.store.close();
  }
});

for (const scenario of [
  "missing SKU",
  "save request",
  "truncated requests",
  "missing startup",
  "request before operation",
  "request after witness",
  "requests out of order",
  "witness before failure",
  "stale scan",
] as const) {
  test(`upload timeout recovery rejects ${scenario}`, () => {
    const s = uploadRecovery((witness) => {
      if (scenario === "missing SKU") witness.inputs = [];
      if (scenario === "save request")
        witness.requests[10] = {
          ...witness.requests[10],
          method: "POST",
          path: "/proxy/item/seller/item/save",
          finalPath: "/proxy/item/seller/item/save",
        };
      if (scenario === "truncated requests")
        while (witness.requests.length < 200)
          witness.requests.push({
            ...witness.requests[1],
            path: `/readonly/capped-${witness.requests.length}`,
            finalPath: `/readonly/capped-${witness.requests.length}`,
          });
      if (scenario === "missing startup")
        witness.requests[0] = {
          ...witness.requests[0],
          path: "/readonly/start",
          finalPath: "/readonly/start",
        };
      if (scenario === "request before operation")
        witness.requests[1].startedAt = Date.parse("2026-09-11T09:59:59.999Z");
      if (scenario === "request after witness")
        witness.requests[1].finishedAt = Date.parse("2026-09-11T10:01:30.001Z");
      if (scenario === "requests out of order") {
        witness.requests[2].startedAt = witness.requests[1].startedAt - 1;
        witness.requests[2].finishedAt = witness.requests[1].finishedAt - 1;
      }
      if (scenario === "witness before failure")
        witness.at = "2026-09-11T10:00:59.999Z";
    });
    try {
      if (scenario === "stale scan")
        s.store.db
          .prepare("UPDATE source_scans SET started_at=? WHERE id=?")
          .run("2026-09-11T10:01:59.000Z", s.scanId);
      assert.throws(
        () => confirmUploadFailureSaveNotApplied(s.store, s.id, s.scanId, NOW),
        /证据|扫描/,
      );
      assert.equal(s.store.pending(s.id)?.id, s.operationId);
      assert.equal(s.store.get(s.id).state, "UNKNOWN_OUTCOME");
    } finally {
      s.store.close();
    }
  });
}
