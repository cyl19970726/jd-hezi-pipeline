import { parseSku, PipelineError, type Product } from "./model.js";

export interface UnsupportedMediaDetails {
  reason: "discovery-story";
  stage: "main-gallery";
  sku: string;
  variant: string;
  parserVersion: string;
  observedAt: string;
}

export interface CanonicalSourceBinding {
  source: "browser";
  sku: string;
  url: string;
  dataHash: string;
  recordedAt: string;
}

export function canonicalSourceBinding(
  value: unknown,
  product: { sku: string; url: string; dataHash: string },
): CanonicalSourceBinding | null {
  const binding = value as Partial<CanonicalSourceBinding> | null;
  if (
    binding?.source !== "browser" ||
    binding.sku !== product.sku ||
    binding.url !== product.url ||
    binding.dataHash !== product.dataHash ||
    !Number.isFinite(Date.parse(String(binding.recordedAt)))
  )
    return null;
  try {
    if (parseSku(binding.url) !== product.sku) return null;
  } catch {
    return null;
  }
  return binding as CanonicalSourceBinding;
}

export function bindCanonicalBrowserSource(product: {
  sku: string;
  url: string;
  dataHash: string;
}): CanonicalSourceBinding {
  if (parseSku(product.url) !== product.sku)
    throw new PipelineError("NEEDS_INPUT", "正式商品URL与SKU不一致");
  return {
    source: "browser",
    ...product,
    recordedAt: new Date().toISOString(),
  };
}

export function unsupportedMediaFallback(
  error: unknown,
  expected: { sku: string; parserVersion: string },
): UnsupportedMediaDetails | null {
  if (!(error instanceof PipelineError) || error.code !== "UNSUPPORTED_MEDIA")
    return null;
  const value = error.details as Partial<UnsupportedMediaDetails> | null;
  const observedAt = Date.parse(String(value?.observedAt));
  const age = Date.now() - observedAt;
  if (
    value?.reason !== "discovery-story" ||
    value.stage !== "main-gallery" ||
    value.sku !== expected.sku ||
    value.parserVersion !== expected.parserVersion ||
    !value.variant ||
    !Number.isFinite(observedAt) ||
    age < 0 ||
    age > 5 * 60 * 1000
  )
    return null;
  return value as UnsupportedMediaDetails;
}

export function requireCollectedSku(product: Product, sku: string) {
  if (product.sku !== sku)
    throw new PipelineError("NEEDS_INPUT", "采集的SKU不一致");
  try {
    if (parseSku(product.url) !== sku) throw new Error("mismatch");
  } catch {
    throw new PipelineError("NEEDS_INPUT", "采集商品URL与任务SKU不一致");
  }
  return product;
}
