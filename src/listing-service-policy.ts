import { z } from "zod";
import type { Product } from "./model.js";
import type { Store } from "./store.js";

const policySchema = z.object({
  version: z.literal(1),
  scope: z.literal("office-stationery"),
  value: z.literal("不可定制"),
  approvedAt: z.string().datetime(),
  approval: z.string().trim().min(1),
});

const policyUrl = "http://127.0.0.1:4317/opportunity-execution";

function officeStationeryPath(path: string) {
  const parts = path.split(/\s*>\s*/).map((part) => part.trim());
  return (
    parts.length >= 3 && parts[0] === "办公用品" && parts[1] === "办公文具"
  );
}

/**
 * Returns only a user-approved shop policy. It is not a source-product fact
 * and must never be attached to, or used to rewrite, JD observations.
 */
export function listingCustomizationPolicy(
  store: Store,
  shop: string,
  categoryId: string,
): Product["title"] | null {
  const category = store.db
    .prepare("SELECT path FROM catalog_categories WHERE shop=? AND id=?")
    .get(shop, categoryId) as { path?: unknown } | undefined;
  if (
    !category ||
    typeof category.path !== "string" ||
    !officeStationeryPath(category.path)
  )
    return null;
  const parsed = policySchema.safeParse(
    store.meta("listing-customization-policy:" + shop),
  );
  if (!parsed.success) return null;
  return {
    value: parsed.data.value,
    sourceUrl: policyUrl,
    capturedAt: parsed.data.approvedAt,
    evidence: `本店用户授权销售政策：${parsed.data.approval}；适用范围：办公用品>办公文具子类；listing-customization-policy/1`,
  };
}
