import { z } from "zod";
import { digest, PipelineError } from "./model.js";
const offerSchema = z.object({
  id: z.string().min(1),
  shopId: z.string().min(1),
  url: z.string().url(),
  price: z.string(),
  checkedAt: z.string().datetime(),
  match: z.enum(["exact", "different", "unknown"]),
  evidence: z.array(z.string().min(1)).min(1),
  available: z.boolean(),
  unconditional: z.boolean(),
  minimum: z.number().int().positive(),
  shippingKnown: z.boolean(),
});
export const priceReviewSchema = z.object({
  shopId: z.string().min(1),
  sourceSku: z.string().min(1),
  sourceIdentityHash: z.string().min(1),
  checkedAt: z.string().datetime(),
  complete: z.boolean(),
  searchUrls: z.array(z.string().url()).min(1),
  offers: z.array(offerSchema),
});
export type PriceReview = z.infer<typeof priceReviewSchema>;
export interface PriceDecision {
  value: string;
  basis: "competitor-minus-cent" | "subsidy";
  reviewHash: string;
  sourceIdentityHash: string;
  sourceSku: string;
  selectedOfferId: string | null;
  checkedAt: string;
  expiresAt: string;
}
const fail = (message: string): never => {
  throw new PipelineError("NEEDS_INPUT", message);
};
function cents(value: string) {
  if (!/^\d+(\.\d{1,2})?$/.test(value)) return fail("价格必须为有效人民币金额");
  const [yuan, fraction = ""] = value.split(".");
  const result = Number(yuan) * 100 + Number(fraction.padEnd(2, "0"));
  if (!Number.isSafeInteger(result) || result <= 0)
    return fail("价格必须大于零且在安全范围内");
  return result;
}
function fresh(at: string, now: number) {
  const t = Date.parse(at);
  if (!Number.isFinite(t) || t > now + 60000 || now - t > 3600000)
    fail("比价证据时间异常或已过期，需重新核验");
  return t;
}
/** A review is complete only within its recorded search scope, never the whole marketplace. */
export function decidePrice(
  input: PriceReview,
  subsidy: { value: string; basis?: string } | null,
  now = Date.now(),
): PriceDecision {
  const r = priceReviewSchema.parse(input);
  if (!r.complete) fail("竞品搜索未完整核验");
  const times = [fresh(r.checkedAt, now)];
  const ids = new Set<string>();
  const eligible: typeof r.offers = [];
  for (const o of r.offers) {
    if (ids.has(o.id)) fail("竞品记录重复");
    ids.add(o.id);
    if (o.shopId === r.shopId) continue;
    times.push(fresh(o.checkedAt, now));
    if (o.match === "different") continue;
    if (o.match === "unknown") fail("存在尚未排除的同款候选");
    if (!o.available) continue;
    if (!o.unconditional || o.minimum !== 1 || !o.shippingKnown)
      fail("同款购买条件或运费尚未核清");
    cents(o.price);
    eligible.push(o);
  }
  eligible.sort(
    (a, b) => cents(a.price) - cents(b.price) || a.id.localeCompare(b.id),
  );
  const selected = eligible[0];
  let amount: number;
  if (selected) {
    amount = cents(selected.price) - 1;
    if (amount <= 0) fail("减一分钱后价格为零或负数");
  } else {
    if (!subsidy || subsidy.basis !== "subsidy")
      return fail("没有有效同款时必须有明确补贴价");
    amount = cents(subsidy.value);
  }
  return {
    value: `${Math.floor(amount / 100)}.${String(amount % 100).padStart(2, "0")}`,
    basis: selected ? "competitor-minus-cent" : "subsidy",
    reviewHash: digest(r),
    sourceIdentityHash: r.sourceIdentityHash,
    sourceSku: r.sourceSku,
    selectedOfferId: selected?.id ?? null,
    checkedAt: new Date(now).toISOString(),
    expiresAt: new Date(Math.min(...times) + 3600000).toISOString(),
  };
}
