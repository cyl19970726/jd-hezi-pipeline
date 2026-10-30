import { z } from "zod";
import {
  digest,
  factSchema,
  parseSku,
  PipelineError,
  type Product,
} from "./model.js";
import type { NormalizationResult } from "./normalization.js";
import { Store } from "./store.js";
export const CAPTURE_REGIONS = [
  "summarySpecs",
  "detailSpecs",
  "packaging",
] as const;
export const TARGETED_CAPTURE_RULES_VERSION = "targeted-facts/1";
export type CaptureRegion = (typeof CAPTURE_REGIONS)[number];
export const productPatchSchema = z.object({
  sku: z.string().regex(/^\d+$/),
  url: z.string().url(),
  variant: z.string(),
  selectedVariant: z.string().optional(),
  specs: z.record(z.string(), factSchema),
  observedAt: z.string().datetime(),
  regions: z.array(z.enum(CAPTURE_REGIONS)).min(1),
  completeRegions: z.array(z.enum(CAPTURE_REGIONS)),
});
export type ProductPatch = z.infer<typeof productPatchSchema>;
export function fieldRegion(field: string): CaptureRegion {
  if (
    ["商品毛重", "品牌", "京东销售规格", "京东质保", "商品条码"].includes(field)
  )
    return "summarySpecs";
  if (["包装名称", "包装数量", "加热器数量"].includes(field))
    return "packaging";
  return "detailSpecs";
}
export function targetedPlan(
  result: NormalizationResult,
  required: string[],
  attempted: CaptureRegion[] = [],
) {
  const fields: string[] = [],
    blocked: string[] = [];
  for (const name of required) {
    const resolution = result.resolutions[name];
    if (
      resolution?.status === "resolved" ||
      resolution?.status === "not_applicable"
    )
      continue;
    const region = fieldRegion(name);
    // Ambiguous selection text may be clarified by a not-yet-read packaging list.
    const newPackingEvidence =
      resolution?.status === "unparsed" &&
      region === "packaging" &&
      !result.product.specs["包装清单"];
    if (
      (resolution?.status === "not_observed" || newPackingEvidence) &&
      !attempted.includes(region)
    )
      fields.push(name);
    else blocked.push(name);
  }
  return { fields, regions: [...new Set(fields.map(fieldRegion))], blocked };
}
export function mergeProductPatch(
  product: Product,
  input: unknown,
  requested: { fields: string[]; regions: CaptureRegion[] },
  now = Date.now(),
): Product {
  const patch = productPatchSchema.parse(input);
  if (
    patch.sku !== product.sku ||
    parseSku(patch.url) !== product.sku ||
    parseSku(product.url) !== product.sku ||
    patch.variant !== product.variant
  )
    throw new PipelineError("VALIDATION_MISSING", "补采SKU或销售变体不一致");
  const selected = product.specs["京东销售规格"]?.value;
  if (selected && patch.selectedVariant !== selected)
    throw new PipelineError("VALIDATION_MISSING", "补采未证明当前销售规格");
  if (
    Date.parse(patch.observedAt) > now ||
    now - Date.parse(patch.observedAt) > 10 * 60_000
  )
    throw new PipelineError("VALIDATION_MISSING", "补采观测时间无效或过期");
  if (
    patch.regions.some((r) => !requested.regions.includes(r)) ||
    requested.regions.some((r) => !patch.regions.includes(r)) ||
    patch.completeRegions.some((r) => !patch.regions.includes(r))
  )
    throw new PipelineError("VALIDATION_MISSING", "补采区域回执不匹配");
  const allowed = new Set([
    ...requested.fields,
    "京东销售规格",
    ...(requested.regions.includes("summarySpecs")
      ? ["毛重", "包装毛重", "含包装重量"]
      : []),
    ...(requested.regions.includes("packaging")
      ? ["包装清单", "销售数量", "装数", "加热器个数"]
      : []),
  ]);
  const out = structuredClone(product);
  for (const [name, fact] of Object.entries(patch.specs)) {
    if (!allowed.has(name))
      throw new PipelineError(
        "VALIDATION_MISSING",
        "补采返回未请求字段：" + name,
      );
    if (
      parseSku(fact.sourceUrl) !== product.sku ||
      Date.parse(fact.capturedAt) > now ||
      Date.parse(fact.capturedAt) !== Date.parse(patch.observedAt)
    )
      throw new PipelineError(
        "VALIDATION_MISSING",
        "补采字段来源或时间不一致：" + name,
      );
    if (out.specs[name] && out.specs[name].value !== fact.value)
      throw new PipelineError(
        "VALIDATION_MISSING",
        "补采字段与已有事实冲突：" + name,
      );
    if (!out.specs[name]) out.specs[name] = fact;
  }
  return out;
}
/** Persist attempts as well as completeness, so a retry cannot silently repeat the same visit. */
export class TargetedCaptures {
  constructor(readonly store: Store) {
    store.db.exec(
      `CREATE TABLE IF NOT EXISTS targeted_captures(shop TEXT NOT NULL,sku TEXT NOT NULL,source TEXT NOT NULL,scope TEXT NOT NULL,region TEXT NOT NULL,status TEXT NOT NULL,receipt TEXT,at TEXT NOT NULL,PRIMARY KEY(shop,sku,source,scope,region))`,
    );
  }
  scope(product: Product, required: string[]) {
    return digest({
      rulesVersion: TARGETED_CAPTURE_RULES_VERSION,
      sku: product.sku,
      variant: product.variant,
      selected: product.specs["京东销售规格"]?.value,
      sourceCapturedAt: product.capturedAt,
      required: [...required].sort(),
    });
  }
  attempted(
    shop: string,
    product: Product,
    source: string,
    required: string[],
  ): CaptureRegion[] {
    return this.store.db
      .prepare(
        "SELECT region FROM targeted_captures WHERE shop=? AND sku=? AND source=? AND scope=? AND status IN ('observed','incomplete')",
      )
      .all(shop, product.sku, source, this.scope(product, required))
      .map((r) => String(r.region) as CaptureRegion);
  }
  begin(
    shop: string,
    product: Product,
    source: string,
    required: string[],
    regions: CaptureRegion[],
  ) {
    this.store.tx(() => {
      for (const region of regions)
        this.store.db
          .prepare(
            "INSERT INTO targeted_captures VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(shop,sku,source,scope,region) DO UPDATE SET at=excluded.at WHERE targeted_captures.status='attempted'",
          )
          .run(
            shop,
            product.sku,
            source,
            this.scope(product, required),
            region,
            "attempted",
            null,
            new Date().toISOString(),
          );
    });
  }
  finish(
    shop: string,
    product: Product,
    source: string,
    required: string[],
    patch: ProductPatch,
  ) {
    this.store.tx(() => {
      for (const region of patch.regions)
        this.store.db
          .prepare(
            "UPDATE targeted_captures SET status=?,receipt=? WHERE shop=? AND sku=? AND source=? AND scope=? AND region=?",
          )
          .run(
            patch.completeRegions.includes(region) ? "observed" : "incomplete",
            JSON.stringify(patch),
            shop,
            product.sku,
            source,
            this.scope(product, required),
            region,
          );
    });
  }
}
