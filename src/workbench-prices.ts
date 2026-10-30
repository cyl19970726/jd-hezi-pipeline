import { digest, money, type Product, type Row } from "./model.js";
import type { Store } from "./store.js";

export interface WorkbenchPrices {
  jd: {
    value: string;
    basis: string;
    capturedAt: string;
    sourceUrl: string;
  } | null;
  competitor: { value: string; capturedAt: string; sourceUrl: string } | null;
  listing: { value: string; basis: string } | null;
  unit: string;
  minimum: string | null;
  deltaVsJd: string | null;
  deltaVsCompetitor: string | null;
  reviewed: boolean;
  stale: boolean;
  note: string;
}

function table(store: Store, name: string) {
  return !!store.db
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
    .get(name);
}

function identity(product: Product) {
  return digest({
    sku: product.sku,
    variant: product.variant,
    title: product.title,
    specs: product.specs,
    price: product.price,
  });
}

function price(value: unknown) {
  return typeof value === "string" ? money(value) : money(String(value ?? ""));
}

function delta(finalValue: string | null, baseValue: string | null) {
  if (!finalValue || !baseValue) return null;
  const result = Math.round((Number(finalValue) - Number(baseValue)) * 100);
  return `${result < 0 ? "-" : ""}${Math.floor(Math.abs(result) / 100)}.${String(Math.abs(result) % 100).padStart(2, "0")}`;
}

function staleAt(value: string, maxAge: number, now: number) {
  const at = Date.parse(value);
  return !Number.isFinite(at) || at > now + 60_000 || now - at > maxAge;
}

function empty(row: Row | null, note: string): WorkbenchPrices {
  const listingValue = row?.plan ? price(row.plan.price.value) : null;
  return {
    jd: null,
    competitor: null,
    listing: listingValue
      ? { value: listingValue, basis: row!.plan!.price.basis ?? "unknown" }
      : null,
    unit: row?.plan?.unit ?? "",
    minimum: null,
    deltaVsJd: null,
    deltaVsCompetitor: null,
    reviewed: false,
    stale: false,
    note,
  };
}

/** Read-only workbench projection. It never refreshes or authorizes a price. */
export function workbenchPrices(
  store: Store,
  row: Row | null,
  now = Date.now(),
): WorkbenchPrices {
  if (!row?.product) return empty(row, "尚无商品价格事实");
  const reviewId = (row.plan as any)?.competitivePricingReviewId;
  if (reviewId && table(store, "competitive_price_reviews")) {
    const saved: any = store.db
      .prepare(
        "SELECT * FROM competitive_price_reviews WHERE id=? AND shop=? AND sku=?",
      )
      .get(reviewId, row.shop, row.sku);
    if (saved) {
      try {
        const payload = JSON.parse(String(saved.payload));
        const jdValue = price(payload?.sourceJdPrice?.value);
        const competitorValue = price(payload?.competitorPrice);
        const listingValue = row.plan ? price(row.plan.price.value) : null;
        const expectedListing = payload?.decision?.offerCents;
        const storedHash = payload?.payloadHash;
        const unhashed = { ...payload };
        delete unhashed.payloadHash;
        const proofMatches =
          saved.identity_hash === identity(row.product) &&
          payload?.preparedIdentityHash === identity(row.product) &&
          storedHash === digest(unhashed) &&
          payload?.unit === row.plan?.unit &&
          payload?.categoryId === row.plan?.catalogBinding?.categoryId &&
          Number.isSafeInteger(expectedListing) &&
          listingValue ===
            `${Math.floor(expectedListing / 100)}.${String(expectedListing % 100).padStart(2, "0")}` &&
          row.plan?.price.basis === "competitor-bounded" &&
          jdValue &&
          competitorValue;
        if (proofMatches) {
          const jd = {
            value: jdValue,
            basis: String(payload.sourceJdPrice.basis ?? "jd-price"),
            capturedAt: String(payload.sourceJdPrice.capturedAt),
            sourceUrl: String(payload.sourceJdPrice.sourceUrl),
          };
          const competitor = {
            value: competitorValue,
            capturedAt: String(payload.marketCheckedAt),
            sourceUrl: `https://b.csgmall.com.cn/mall-view/product/detail?itemId=${encodeURIComponent(String(payload.marketItemId))}&skuId=${encodeURIComponent(String(payload.marketSkuId))}`,
          };
          const stale =
            staleAt(jd.capturedAt, 1_800_000, now) ||
            staleAt(competitor.capturedAt, 3_600_000, now);
          return {
            jd,
            competitor,
            listing: {
              value: listingValue!,
              basis: String(row.plan!.price.basis),
            },
            unit: String(payload.unit ?? row.plan?.unit ?? ""),
            minimum:
              Number.isSafeInteger(payload?.decision?.minimumCents) &&
              payload.decision.minimumCents > 0
                ? `${Math.floor(payload.decision.minimumCents / 100)}.${String(payload.decision.minimumCents % 100).padStart(2, "0")}`
                : null,
            deltaVsJd: delta(listingValue, jdValue),
            deltaVsCompetitor: delta(listingValue, competitorValue),
            reviewed: true,
            stale,
            note: stale
              ? "已复核的历史决策；报价证据已过期，写入前需重新核价"
              : "已绑定精确同款复核；竞品价为对应商品展示单价，不表示全网最低或含运价",
          };
        }
      } catch {
        // Invalid private review data is represented as unavailable below.
      }
    }
    return empty(row, "竞品定价复核缺失或与当前商品身份不一致");
  }

  const jdValue = price(row.product.price?.value);
  const jd =
    row.product.price && jdValue
      ? {
          value: jdValue,
          basis: row.product.price.basis ?? "unknown",
          capturedAt: row.product.price.capturedAt,
          sourceUrl: row.product.price.sourceUrl,
        }
      : null;
  let competitor: WorkbenchPrices["competitor"] = null;
  let unit = row.plan?.unit ?? "";
  if (
    table(store, "opportunity_rows") &&
    table(store, "opportunity_cohorts") &&
    table(store, "opportunity_evidence") &&
    table(store, "opportunity_source_observations") &&
    table(store, "market_details")
  ) {
    const opportunities = store.db
      .prepare(
        `SELECT r.* FROM opportunity_rows r
         JOIN opportunity_cohorts c ON c.cohort_key=r.cohort_key
         WHERE r.target_sku=? AND c.shop=?`,
      )
      .all(row.sku, row.shop) as any[];
    if (opportunities.length === 1) {
      const opportunity = opportunities[0];
      const latest: any = store.db
        .prepare(
          `SELECT kind,payload FROM opportunity_evidence WHERE row_id=?
           AND kind IN ('source-product-verified','source-product-rejected')
           ORDER BY observed_at DESC,rowid DESC LIMIT 1`,
        )
        .get(opportunity.id);
      const observation: any = store.db
        .prepare(
          "SELECT * FROM opportunity_source_observations WHERE row_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1",
        )
        .get(opportunity.id);
      if (latest?.kind === "source-product-verified" && observation) {
        try {
          const verification = JSON.parse(String(latest.payload));
          const details: any = store.db
            .prepare("SELECT * FROM market_details WHERE id=?")
            .get(observation.detail_receipt_id);
          const raw = details ? JSON.parse(String(details.payload)) : null;
          const selected = (raw?.data?.itemSkuInfoList ?? []).filter(
            (candidate: any) =>
              String(candidate?.id) === String(opportunity.market_sku_id) &&
              String(candidate?.itemId) ===
                String(opportunity.market_item_id) &&
              String(candidate?.shopId) === String(opportunity.market_shop_id),
          );
          const candidateValue =
            selected.length === 1 ? price(selected[0].sellPrice) : null;
          const verifiedFields = new Set(
            Array.isArray(verification.fields)
              ? verification.fields.map((field: any) => field?.field)
              : [],
          );
          if (
            verification.detailReceiptId === observation.detail_receipt_id &&
            verification.sourceSku === row.sku &&
            ["brand", "model", "packaging"].every((field) =>
              verifiedFields.has(field),
            ) &&
            details?.shop === row.shop &&
            String(details.item_id) === String(opportunity.market_item_id) &&
            candidateValue &&
            (!row.plan?.unit || selected[0].skuUnit === row.plan.unit)
          ) {
            competitor = {
              value: candidateValue,
              capturedAt: String(details.checked_at),
              sourceUrl: `https://b.csgmall.com.cn/mall-view/product/detail?itemId=${encodeURIComponent(String(opportunity.market_item_id))}&skuId=${encodeURIComponent(String(opportunity.market_sku_id))}`,
            };
            unit = row.plan?.unit ?? String(selected[0].skuUnit ?? "");
          }
        } catch {
          competitor = null;
        }
      }
    }
  }
  const listingValue = row.plan ? price(row.plan.price.value) : null;
  const stale =
    (jd ? staleAt(jd.capturedAt, 1_800_000, now) : false) ||
    (competitor ? staleAt(competitor.capturedAt, 3_600_000, now) : false);
  return {
    jd,
    competitor,
    listing: listingValue
      ? { value: listingValue, basis: row.plan!.price.basis ?? "unknown" }
      : null,
    unit,
    minimum: null,
    deltaVsJd: delta(listingValue, jd?.value ?? null),
    deltaVsCompetitor: delta(listingValue, competitor?.value ?? null),
    reviewed: false,
    stale,
    note: competitor
      ? "精确同款机会的参考展示单价；尚未形成最终竞品定价复核，不表示全网最低或含运价"
      : "尚无可唯一绑定的精确同款竞品价",
  };
}
