import { assertHzRunning } from "./platform-availability.js";
import { PricingStore } from "./pricing-store.js";
import { Store } from "./store.js";
import { Catalog } from "./catalog.js";
import { Engine } from "./engine.js";
import { EgoAdapter, EgoBridge } from "./browser/bridge.js";
import type { BrowserConfig } from "./browser/runtime.js";
import { PipelineError, expectedFields, validate } from "./model.js";
import { verifyLocalAssets } from "./assets.js";

export function replacementReason(
  fields: Record<string, string>,
  categoryPath: string,
  clearFields: string[] = [],
) {
  const dirty = clearFields.filter((key) => fields[key]?.trim());
  const reasons: string[] = [];
  if (dirty.length) reasons.push(`平台不能清除旧值：${dirty.join(",")}`);
  const oldCategory = fields.category?.trim();
  const newCategory = categoryPath.trim();
  const normalizeCategory = (value: string) => value.replace(/\s/g, "");
  if (
    oldCategory &&
    newCategory &&
    normalizeCategory(oldCategory) !== normalizeCategory(newCategory)
  )
    reasons.push(`修复平台类目：${oldCategory} → ${newCategory}`);
  return reasons.length ? reasons.join("；") : null;
}

/** Intentional repair, distinct from absence-based creation. Old platform record is retained. */
export async function replaceLegacy(
  store: Store,
  bridge: EgoBridge,
  config: BrowserConfig,
  id: string,
) {
  const unlock = store.lock("publisher");
  try {
    const row = store.get(id);
    assertHzRunning(store, row.shop);
    if (
      !row.remoteId ||
      !row.product ||
      !row.plan ||
      store.pending(id) ||
      store.replacement(id)
    )
      throw new PipelineError(
        "UNKNOWN_OUTCOME",
        "替代已有记录或未完成，请先对账，不再新建",
      );
    new Catalog(store).authorize(row.plan);
    await verifyLocalAssets(row.product);
    const issues = validate(row.product, row.plan);
    if (issues.length)
      throw new PipelineError("VALIDATION_MISSING", "计划不完整", issues);
    new PricingStore(store).verify(row.shop, row.product, row.plan);
    const adapter = new EgoAdapter(bridge, config, true);
    await adapter.checkShop(row.shop);
    const before = await adapter.read(row.remoteId);
    if (
      before.sku !== row.sku ||
      before.shop !== row.shop ||
      before.logistics?.hasOrderInfo !== 0 ||
      !["草稿", "待提交"].includes(before.status)
    )
      throw new PipelineError(
        "BUSINESS_BLOCKED",
        "只替代同一SKU且无订单的草稿或待提交记录",
      );
    const reason = replacementReason(
      before.fields,
      row.plan.categoryPath,
      row.plan.clearFields,
    );
    if (!reason)
      throw new PipelineError(
        "NEEDS_INPUT",
        "不存在需隔离的继承字段或明确类目错误，应继续原商品流程",
      );
    const prepared = await bridge.call("save", {
      config,
      product: row.product,
      plan: { ...row.plan, replaceMedia: true },
      itemId: null,
      write: true,
      prepareOnly: true,
      expected: expectedFields(row.product, row.plan),
    });
    new PricingStore(store).verify(row.shop, row.product, row.plan);
    const op = store.beginReplacement(id, {
      itemId: row.remoteId,
      hasOrderInfo: 0,
      status: before.status,
      reason,
    });
    try {
      const receipt = await bridge.call("save-prepared", {
        config,
        write: true,
        sku: row.sku,
      });
      store.completeReplacement(id, op, {
        ...receipt,
        mediaReferences: prepared.mediaReferences,
      });
    } catch (e) {
      store.state(id, "UNKNOWN_OUTCOME", {
        error: String(e),
        receipt: e instanceof PipelineError ? e.details : null,
      });
      throw e;
    }
  } finally {
    unlock();
  }
  return new Engine(store, new EgoAdapter(bridge, config, true)).reconcile(id);
}
