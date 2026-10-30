import { money, parseSku, PipelineError, type Product } from "./model.js";

export const COLLECTION_PRICE_FRESH_MS = 30 * 60 * 1000;
export type CollectionNeed = "full" | "price" | "none" | "local";
export type CollectionSource = "browser" | "android";

function freshExplicitPrice(product: Product, now: number) {
  const price = product.price;
  if (
    !price ||
    !money(price.value) ||
    Number(price.value) <= 0 ||
    (price.basis !== "subsidy" && price.basis !== "jd-price")
  )
    return false;
  try {
    if (parseSku(price.sourceUrl) !== product.sku) return false;
  } catch {
    return false;
  }
  const captured = Date.parse(price.capturedAt);
  const age = now - captured;
  return (
    Number.isFinite(captured) && age >= 0 && age <= COLLECTION_PRICE_FRESH_MS
  );
}

/** Decide the smallest safe JD collection without consulting mutable state. */
export function collectionNeed(
  product: Product | null,
  source: CollectionSource,
  now = Date.now(),
  observation?: { previouslyObserved: boolean },
): CollectionNeed {
  if (!product) return "full";
  try {
    if (parseSku(product.url) !== product.sku) return "full";
  } catch {
    return "full";
  }
  const sourceReady =
    source === "android"
      ? !!product.specs["手机原图完整性"]
      : !!product.specs["商品毛重"];
  if (!sourceReady) return observation?.previouslyObserved ? "local" : "full";
  try {
    return freshExplicitPrice(product, now) ? "none" : "price";
  } catch {
    return "price";
  }
}

/** Merge one freshly observed quote while preserving every existing product fact and asset. */
export function mergeFreshPrice(
  existingProduct: Product,
  quoteProduct: Product,
  now = Date.now(),
): Product {
  let invalidIdentity =
    existingProduct.sku !== quoteProduct.sku ||
    existingProduct.variant !== quoteProduct.variant;
  try {
    invalidIdentity ||=
      parseSku(existingProduct.url) !== existingProduct.sku ||
      parseSku(quoteProduct.url) !== quoteProduct.sku;
  } catch {
    invalidIdentity = true;
  }
  if (invalidIdentity)
    throw new PipelineError("NEEDS_INPUT", "补价商品身份或销售变体不一致");
  const selected = existingProduct.specs["京东销售规格"]?.value;
  if (
    selected !== undefined &&
    quoteProduct.specs["京东销售规格"]?.value !== selected
  )
    throw new PipelineError("NEEDS_INPUT", "补价时京东销售规格不一致");
  if (!freshExplicitPrice(quoteProduct, now))
    throw new PipelineError(
      "NEEDS_INPUT",
      "补价缺少当前SKU的明确、有效京东报价",
    );
  return { ...existingProduct, price: { ...quoteProduct.price! } };
}
