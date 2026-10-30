import { Catalog } from "./catalog.js";
import {
  canonical,
  PipelineError,
  validate,
  verify,
  type Plan,
  type RemoteSnapshot,
  type Row,
} from "./model.js";
import { remoteProductState } from "./remote-status.js";
import { assertHzRunning } from "./platform-availability.js";
import { Store } from "./store.js";

export interface RejectionRepairAdapter {
  checkShop(shop: string): Promise<void>;
  read(itemId: string): Promise<RemoteSnapshot>;
  repairRejected(args: {
    itemId: string;
    sku: string;
    before: RemoteSnapshot;
    plan: Plan;
  }): Promise<RemoteSnapshot>;
}

function unchangedPlan(oldPlan: Plan, nextPlan: Plan) {
  const strip = (plan: Plan) => {
    const copy = structuredClone(plan) as Plan;
    delete copy.displayTitle;
    delete copy.specs["规格"];
    return copy;
  };
  return canonical(strip(oldPlan)) === canonical(strip(nextPlan));
}

function assertIdentity(
  row: Row,
  snapshot: Pick<RemoteSnapshot, "itemId" | "shop" | "sku">,
) {
  if (
    snapshot.itemId !== row.remoteId ||
    snapshot.shop !== row.shop ||
    snapshot.sku !== row.sku
  )
    throw new PipelineError(
      "UNKNOWN_OUTCOME",
      "驳回修订读回的商品身份不一致",
      snapshot,
    );
}

/** One controlled same-item repair. It never retries or recreates remote media. */
export async function repairRejected(
  store: Store,
  adapter: RejectionRepairAdapter,
  id: string,
  nextPlan: Plan,
  options: { allowReadyForSale?: boolean } = {},
): Promise<Row> {
  const unlock = store.lock("publisher");
  try {
    let row = store.get(id);
    if (
      (!["REJECTED", "SUBMITTED"].includes(row.state) &&
        !options.allowReadyForSale) ||
      !row.remoteId ||
      !row.product ||
      !row.plan ||
      !row.mediaReferences
    )
      throw new PipelineError(
        "BUSINESS_BLOCKED",
        "只有已绑定、已核验图片的驳回商品可修订",
      );
    if (store.pending(id))
      throw new PipelineError("UNKNOWN_OUTCOME", "必须先对账未完成操作");
    if (nextPlan.shop !== row.shop || !unchangedPlan(row.plan, nextPlan))
      throw new PipelineError(
        "BUSINESS_BLOCKED",
        "驳回修订只允许变更显示标题和规格字段",
      );

    assertHzRunning(store, row.shop);
    await adapter.checkShop(row.shop);
    const before = await adapter.read(row.remoteId);
    assertIdentity(row, before);

    const oldIssues = verify(
      before,
      row.product,
      row.plan,
      row.mediaReferences,
    );
    const remoteState = remoteProductState(before.status);
    const validateNextPlan = () => {
      const nextIssues = validate(row.product!, nextPlan);
      if (nextIssues.length)
        throw new PipelineError(
          "VALIDATION_MISSING",
          "驳回修订计划未通过校验",
          nextIssues,
        );
      new Catalog(store).authorize(nextPlan);
    };

    if (remoteState === "SUBMITTED") {
      validateNextPlan();
      const issues = verify(before, row.product, nextPlan, row.mediaReferences);
      if (issues.length)
        throw new PipelineError(
          "BUSINESS_BLOCKED",
          "远端已待审，但尚未完整持久化本次修订",
          issues,
        );
      store.setPlan(id, nextPlan);
      row = store.get(id);
      store.verified(id, row.dataHash);
      store.state(id, "SUBMITTED");
      store.event(id, "REJECTION_REPAIR_ALREADY_SUBMITTED", {
        itemId: row.remoteId,
      });
      return store.get(id);
    }

    const explicitlyReadyForSale =
      options.allowReadyForSale === true && before.status.trim() === "待上架";
    if (remoteState !== "REJECTED" && !explicitlyReadyForSale)
      throw new PipelineError(
        "BUSINESS_BLOCKED",
        "远端商品不在明确驳回状态，也未显式允许修订待上架商品",
        { status: before.status },
      );
    if (oldIssues.length)
      throw new PipelineError(
        "VALIDATION_MISSING",
        "驳回商品旧计划读回不完整",
        oldIssues,
      );
    validateNextPlan();

    store.setPlan(id, nextPlan);
    row = store.get(id);
    assertHzRunning(store, row.shop);
    const op = store.intent(id, "submit");
    store.event(id, "REJECTION_REPAIR_REQUESTED", {
      itemId: row.remoteId,
      operationId: op,
      changed: ["displayTitle", "specs.规格"],
      ...(explicitlyReadyForSale ? { allowReadyForSale: true } : {}),
    });
    try {
      const after = await adapter.repairRejected({
        itemId: row.remoteId!,
        sku: row.sku,
        before,
        plan: nextPlan,
      });
      assertIdentity(row, after);
      if (remoteProductState(after.status) !== "SUBMITTED")
        throw new PipelineError(
          "UNKNOWN_OUTCOME",
          "组合修订后未观察到待审或审核中状态",
          after,
        );
      const issues = verify(after, row.product!, nextPlan, row.mediaReferences);
      if (issues.length)
        throw new PipelineError(
          "UNKNOWN_OUTCOME",
          "组合修订后全字段读回未通过",
          issues,
        );
      store.receipt(op, after);
      store.verified(id, row.dataHash);
      store.state(id, "SUBMITTED");
      return store.get(id);
    } catch (error) {
      store.state(id, "UNKNOWN_OUTCOME", {
        code: "UNKNOWN_OUTCOME",
        message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  } finally {
    unlock();
  }
}
