import { cleanSaleLabel } from "./sale-text.js";
import type { Product } from "./model.js";

export function isClockListingCategory(categoryPath: string) {
  return /(?:挂钟|闹钟|钟表|时钟)/.test(categoryPath);
}

function withoutLeadingModel(variant: string, model: string) {
  const escaped = model.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return variant.replace(new RegExp(`^${escaped}\\s*`, "i"), "").trim();
}

/** Current SKU selected label + authorized category + sourced clock model. */
export function listingTitle(p: Product, brand: string, categoryPath: string) {
  const selected = p.specs["京东销售规格"];
  if (!selected || selected.sourceUrl !== p.url) return null;
  const text = cleanSaleLabel(selected.value);
  const leaf = categoryPath
    .split(/\s*(?:>|\/|→)\s*/)
    .at(-1)
    ?.trim();
  const clock = isClockListingCategory(categoryPath);
  const model = p.specs["型号"];
  // Clock models identify the variant.  They are only usable when already
  // observed for this SKU; never extract or manufacture one while titling.
  if (clock && (!model?.value.trim() || model.sourceUrl !== p.url)) return null;
  const value = [
    brand,
    leaf,
    clock ? model!.value.trim() : "",
    clock ? withoutLeadingModel(text, model!.value.trim()) : text,
  ]
    .filter(Boolean)
    .join(" ");
  if (
    !text ||
    !leaf ||
    value.length > 80 ||
    /免费|限时|第一|基孔肯雅/.test(text)
  )
    return null;
  return {
    ...selected,
    value,
    evidence:
      selected.evidence +
      (clock
        ? "；固定标题模板：品牌+授权类目+当前SKU型号+所选规格 listing-title/2"
        : "；固定标题模板：品牌+授权类目+所选规格 listing-title/2"),
  };
}
