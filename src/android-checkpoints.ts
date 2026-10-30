export const ANDROID_CHECKPOINT_FRESH_MS = 24 * 60 * 60 * 1000;

export type AndroidShopFact = {
  version: 1;
  shop: string;
  sku: string;
  variant: string;
  shopName: string;
  sourceUrl: string;
  observedAt: string;
  evidence: string;
};

export function freshCheckpointTime(
  value: unknown,
  now = Date.now(),
  maxAgeMs = ANDROID_CHECKPOINT_FRESH_MS,
) {
  if (typeof value !== "string") return false;
  const observed = Date.parse(value),
    age = now - observed;
  return Number.isFinite(observed) && age >= 0 && age <= maxAgeMs;
}

export function reusableAndroidShopFact(
  value: unknown,
  expected: {
    shop: string;
    sku: string;
    variant: string;
    sourceUrl: string;
  },
  now = Date.now(),
): AndroidShopFact | null {
  if (!value || typeof value !== "object") return null;
  const fact = value as Partial<AndroidShopFact>;
  if (
    fact.version !== 1 ||
    fact.shop !== expected.shop ||
    fact.sku !== expected.sku ||
    fact.variant !== expected.variant ||
    typeof fact.shopName !== "string" ||
    !fact.shopName ||
    fact.sourceUrl !== expected.sourceUrl ||
    typeof fact.evidence !== "string" ||
    !fact.evidence ||
    !freshCheckpointTime(fact.observedAt, now)
  )
    return null;
  return fact as AndroidShopFact;
}
