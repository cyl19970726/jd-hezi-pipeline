import { z } from "zod";
import { Jobs } from "./jobs.js";
import { Planner } from "./planner.js";
import { money, PipelineError } from "./model.js";
import {
  bindCanonicalBrowserSource,
  canonicalSourceBinding,
} from "./jd-source-fallback.js";
export const factsInput = z.object({
  values: z.record(z.string(), z.string().max(2000)),
  mediaReviewed: z.boolean().default(false),
  sourceUrl: z.string().url(),
  packingDisplayName: z.string().trim().min(1).max(2000).optional(),
});
export function updateJobFacts(jobs: Jobs, id: string, input: unknown) {
  const data = factsInput.parse(input),
    j = jobs.get(id);
  if (!j.productId || !["NEEDS_INPUT", "CANCELLED"].includes(j.status))
    throw new PipelineError("NEEDS_INPUT", "当前任务状态不能补充资料");
  const row = jobs.store.get(j.productId);
  if (!row.product) throw new PipelineError("NEEDS_INPUT", "请先采集商品");
  const sourceBindingKey = `jd-product-source:${row.shop}:${row.product.sku}`;
  const preserveBrowserSource =
    j.recipe.source === "android" &&
    j.sku === row.product.sku &&
    row.shop === jobs.shop &&
    !row.remoteId &&
    !jobs.store.pending(row.id)
      ? canonicalSourceBinding(jobs.store.meta(sourceBindingKey), {
          sku: row.product.sku,
          url: row.product.url,
          dataHash: row.dataHash,
        })
      : null;
  const p = structuredClone(row.product);
  const now = new Date().toISOString();
  const regularPreferred =
    jobs.store.meta("listing-price:" + row.shop) === "jd-regular-preferred";
  if (regularPreferred) {
    const regular = ["日常价", "京东价"]
      .map((label) => ({ label, value: data.values[label]?.trim() }))
      .filter((entry): entry is { label: string; value: string } =>
        Boolean(entry.value),
      );
    const regularValues = new Set(
      regular.map((entry) => money(entry.value) ?? "invalid:" + entry.value),
    );
    if (regularValues.size > 1)
      throw new PipelineError(
        "NEEDS_INPUT",
        "同一次补充的日常价与京东价不一致，不能猜测",
      );
    const selected = regular[0];
    const subsidy = data.values["补贴价"]?.trim();
    if (selected)
      p.price = {
        value: selected.value,
        sourceUrl: data.sourceUrl,
        capturedAt: now,
        evidence: "用户通过工作台明确确认的" + selected.label,
        basis: "jd-price",
      };
    else if (subsidy && p.price?.basis !== "jd-price")
      p.price = {
        value: subsidy,
        sourceUrl: data.sourceUrl,
        capturedAt: now,
        evidence: "用户通过工作台明确确认的补贴价",
        basis: "subsidy",
      };
  }
  for (const [key, value] of Object.entries(data.values)) {
    if (!value.trim()) continue;
    if (regularPreferred && ["日常价", "京东价", "补贴价"].includes(key))
      continue;
    const existing = ["补贴价", "京东价"].includes(key)
      ? p.price
      : p.specs[key];
    if (
      existing?.value === value &&
      (!["补贴价", "京东价"].includes(key) ||
        p.price?.basis === (key === "京东价" ? "jd-price" : "subsidy"))
    )
      continue;
    const fact = {
      value,
      sourceUrl: data.sourceUrl,
      capturedAt: now,
      evidence: "工作台补充并确认的来源事实",
    };
    if (key === "售价")
      throw new PipelineError(
        "NEEDS_INPUT",
        "请明确填写补贴价，不能使用旧售价字段",
      );
    if (key === "京东价" && p.price?.basis === "subsidy")
      throw new PipelineError("NEEDS_INPUT", "已有明确补贴价，不用京东价覆盖");
    if (
      key === "京东价" &&
      jobs.store.meta("listing-price:" + row.shop) === "jd-subsidy"
    )
      throw new PipelineError("NEEDS_INPUT", "当前策略不允许京东价备用");
    if (["补贴价", "京东价"].includes(key))
      p.price = {
        ...fact,
        basis: key === "京东价" ? "jd-price" : "subsidy",
        evidence: "用户通过工作台明确确认的" + key,
      };
    else p.specs[key] = fact;
  }
  const plan = new Planner(jobs.store).build(
    row.shop,
    p,
    j.recipe.brandId,
    j.recipe.categoryId,
    j.recipe.policyId,
    j.recipe.unit,
  );
  if (data.packingDisplayName) {
    const sourcePackingName = p.specs["包装名称"];
    if (!sourcePackingName)
      throw new PipelineError("NEEDS_INPUT", "缺少完整包装名称来源事实");
    plan.fields.packingName = {
      value: data.packingDisplayName,
      sourceUrl: sourcePackingName.sourceUrl,
      capturedAt: sourcePackingName.capturedAt,
      evidence: `由完整包装名称“${sourcePackingName.value}”生成的平台显示名称；仅用于包装清单显示`,
    };
  }
  plan.mediaReviewed = data.mediaReviewed;
  jobs.store.put(row.shop, p);
  jobs.store.setPlan(row.id, plan);
  const updated = jobs.store.get(row.id);
  if (
    preserveBrowserSource &&
    updated.product?.sku === row.product.sku &&
    updated.product.url === row.product.url
  )
    jobs.store.setMeta(
      sourceBindingKey,
      bindCanonicalBrowserSource({
        sku: updated.product.sku,
        url: updated.product.url,
        dataHash: updated.dataHash,
      }),
    );
  jobs.event(id, "plan", "updated", null, {
    fields: Object.keys(data.values),
    mediaReviewed: data.mediaReviewed,
    packingDisplayName: Boolean(data.packingDisplayName),
  });
  return { ok: true };
}
export function requiredFacts(jobs: Jobs, id: string) {
  const j = jobs.get(id),
    t = jobs.store.db
      .prepare(
        "SELECT template FROM category_templates WHERE shop=? AND category_id=?",
      )
      .get(jobs.shop, j.recipe.categoryId);
  return [
    ...new Set([
      "品牌",
      ...(j.productId &&
      jobs.store.get(j.productId).plan?.price.basis === "competitor-minus-cent"
        ? []
        : [
            j.productId &&
            jobs.store.get(j.productId).product?.price?.basis === "jd-price"
              ? "京东价"
              : "补贴价",
          ]),
      "商品毛重",
      "包装名称",
      "包装数量",
      ...(t ? JSON.parse(String(t.template)).specs : []),
    ]),
  ];
}
