import { randomUUID } from "node:crypto";
import { z } from "zod";
import { calculateCompetitivePrice } from "./competitive-price.js";
import { mergeFreshPrice } from "./collection-needs.js";
import { JdCaptureStore } from "./jd-capture.js";
import { MarketDetails } from "./market-details.js";
import {
  digest,
  money,
  parseSku,
  PipelineError,
  type Product,
} from "./model.js";
import { normalizeProduct } from "./normalization.js";
import { compareMarketSource } from "./opportunity-source-match.js";
import { OpportunityExecution } from "./opportunity-execution.js";
import { OpportunitySources } from "./opportunity-source.js";
import { prepareSaleText } from "./sale-text.js";
import type { Store } from "./store.js";

const policySchema = z.object({
  version: z.literal(1),
  cohortKey: z.string().min(1),
  targetDiscountBps: z.literal(100),
  maxJdDiscountBps: z.literal(1500),
  approvedAt: z.string().datetime(),
  approval: z.string().trim().min(1),
});

type CompetitivePlan = {
  shop: string;
  categoryPath?: string;
  categoryId?: string;
  catalogBinding?: { categoryId: string };
  unit: string;
  competitivePricingReviewId?: string;
  price: { value: string; basis?: string };
};

function fail(message: string): never {
  throw new PipelineError("NEEDS_INPUT", message);
}

function productIdentity(product: Product) {
  return digest({
    sku: product.sku,
    variant: product.variant,
    title: product.title,
    specs: product.specs,
    price: product.price,
  });
}

function cents(value: string) {
  const normalized = money(value);
  if (!normalized) return fail("价格必须是明确的人民币金额");
  const [yuan, fraction] = normalized.split(".");
  const result = Number(yuan) * 100 + Number(fraction);
  if (!Number.isSafeInteger(result) || result <= 0)
    return fail("价格超出安全范围");
  return result;
}

function amount(value: number) {
  return `${Math.floor(value / 100)}.${String(value % 100).padStart(2, "0")}`;
}

export class CompetitivePricing {
  readonly details: MarketDetails;

  constructor(readonly store: Store) {
    this.details = new MarketDetails(store);
    new JdCaptureStore(store);
    store.db.exec(`CREATE TABLE IF NOT EXISTS competitive_price_reviews(
      id TEXT PRIMARY KEY,shop TEXT NOT NULL,sku TEXT NOT NULL,identity_hash TEXT NOT NULL,
      payload TEXT NOT NULL,created_at TEXT NOT NULL
    ); CREATE INDEX IF NOT EXISTS competitive_price_reviews_lookup
      ON competitive_price_reviews(shop,sku,created_at);`);
  }

  private policy(shop: string) {
    const raw = this.store.meta("competitive-price-policy:" + shop);
    if (raw === null || raw === undefined) return null;
    const parsed = policySchema.safeParse(raw);
    if (!parsed.success) fail("竞品定价政策无效");
    const approved = Date.parse(parsed.data.approvedAt);
    if (!Number.isFinite(approved) || approved > Date.now() + 60_000)
      fail("竞品定价政策批准时间无效");
    return parsed.data;
  }

  private evaluate(
    shop: string,
    product: Product,
    categoryId: string,
    unit: string,
    expected?: any,
  ) {
    const policy = this.policy(shop);
    if (!policy) return null;
    const rows = this.store.db
      .prepare(
        `SELECT r.*,c.shop FROM opportunity_rows r
         JOIN opportunity_cohorts c ON c.cohort_key=r.cohort_key
         WHERE r.cohort_key=? AND c.shop=? AND r.target_sku=?`,
      )
      .all(policy.cohortKey, shop, product.sku) as any[];
    if (!rows.length) return null;
    if (rows.length !== 1) fail("同一京东SKU在授权机会批次中不唯一");
    const row = rows[0];
    const latest: any = this.store.db
      .prepare(
        `SELECT kind,payload,observed_at FROM opportunity_evidence
         WHERE row_id=? AND kind IN ('source-product-verified','source-product-rejected')
         ORDER BY observed_at DESC,rowid DESC LIMIT 1`,
      )
      .get(row.id);
    if (!latest || latest.kind !== "source-product-verified")
      fail("最新机会证据未确认京东与竞品为精确同款");
    const verified = JSON.parse(String(latest.payload));
    const observation: any = this.store.db
      .prepare(
        `SELECT * FROM opportunity_source_observations
         WHERE row_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1`,
      )
      .get(row.id);
    if (
      !observation ||
      verified.sourceSku !== product.sku ||
      verified.detailReceiptId !== observation.detail_receipt_id
    )
      fail("京东规格核对证据与最新来源观察不一致");
    const observedProduct = JSON.parse(String(observation.product)) as Product;
    const preparedObserved = prepareSaleText(observedProduct);
    const normalizedObserved = normalizeProduct(
      preparedObserved,
      Object.keys(product.specs)
        .filter((name) => !preparedObserved.specs[name])
        .map((name) => ({ name, required: true })),
      { categoryId },
    );
    if (normalizedObserved.blockingReasons.length)
      fail("准备后商品包含无法从原始京东事实重建的规格");
    if (
      productIdentity({
        ...normalizedObserved.product,
        price: product.price,
      }) !== productIdentity(product)
    )
      fail("准备后商品事实不是受支持的当前SKU归一化结果");
    const detailRow: any = this.store.db
      .prepare(
        "SELECT * FROM market_details WHERE id=? AND shop=? AND item_id=?",
      )
      .get(observation.detail_receipt_id, shop, row.market_item_id);
    if (!detailRow) fail("竞品详情回执缺失或身份不一致");
    const raw = JSON.parse(String(detailRow.payload));
    const comparison = compareMarketSource(
      {
        marketPayload: raw,
        marketItemId: String(row.market_item_id),
        marketSkuId: String(row.market_sku_id),
        marketShopId: String(row.market_shop_id),
        source: product,
        detailReceiptId: String(observation.detail_receipt_id),
        marketCheckedAt: String(detailRow.checked_at),
      },
      Date.now(),
    );
    if (!comparison.matched) fail("最新规格复核未证明京东与竞品为精确同款");
    if (
      comparison.sourceSku !== product.sku ||
      comparison.detailReceiptId !== observation.detail_receipt_id
    )
      fail("精确同款复核身份不一致");

    if (
      !product.price ||
      !["jd-price", "subsidy"].includes(product.price.basis ?? "") ||
      parseSku(product.price.sourceUrl) !== product.sku
    )
      fail("竞品定价缺少当前京东SKU的明确基准价");
    const jdAt = Date.parse(product.price.capturedAt);
    const now = Date.now();
    if (!Number.isFinite(jdAt) || jdAt > now + 60_000 || now - jdAt > 1_800_000)
      fail("京东基准价已过期，需重新核价");
    const quoteRows = this.store.db
      .prepare(
        `SELECT source,basis,value,source_url,evidence,observed_at
         FROM jd_price_snapshots WHERE shop=? AND sku=?`,
      )
      .all(shop, product.sku) as any[];
    if (
      !quoteRows.some(
        (quote) =>
          quote.source !== "legacy-unknown" &&
          quote.basis === product.price!.basis &&
          quote.value === product.price!.value &&
          quote.source_url === product.price!.sourceUrl &&
          quote.evidence === product.price!.evidence &&
          quote.observed_at === product.price!.capturedAt,
      )
    )
      fail("京东基准价没有当前SKU实际采集快照，不能使用手工报价");

    const detail = this.details.get(String(observation.detail_receipt_id));
    const selected = detail.skus.filter(
      (candidate) => candidate.id === row.market_sku_id,
    );
    if (selected.length !== 1 || !selected[0].available)
      fail("对应竞品销售SKU不唯一或当前不可购买");
    if (selected[0].unit !== unit) fail("竞品销售单位与计划单位不一致");
    const rawSelected = (raw.data?.itemSkuInfoList ?? []).filter(
      (candidate: any) => String(candidate?.id) === String(row.market_sku_id),
    );
    if (rawSelected.length !== 1) fail("竞品原始销售SKU不唯一");
    const conditions = rawSelected[0];
    const minimumPurchase = conditions.minimumPurchase ?? 1;
    if (
      !Number.isFinite(Number(minimumPurchase)) ||
      Number(minimumPurchase) <= 0 ||
      Number(minimumPurchase) > 1 ||
      (Array.isArray(conditions.areaPriceList) &&
        conditions.areaPriceList.length) ||
      conditions.itemSkuPriceResultVo != null ||
      conditions.thirdSalePrice != null ||
      raw.data?.priceBenefitFlag === 1
    )
      fail("竞品存在起购量或明确条件价，不能作为直接比价基准");
    const decision = calculateCompetitivePrice({
      sourceJdCents: cents(product.price.value),
      competitorCents: cents(selected[0].price),
    });
    if (!decision.advantageAchieved) fail("15%降幅上限内无法实现竞品低1%");
    const policyHash = digest(policy);
    const payload = {
      version: 1,
      policy,
      policyHash,
      rowId: String(row.id),
      cohortKey: String(row.cohort_key),
      marketItemId: String(row.market_item_id),
      marketShopId: String(row.market_shop_id),
      marketSkuId: String(row.market_sku_id),
      detailReceiptId: String(observation.detail_receipt_id),
      observationId: String(observation.id),
      categoryId,
      unit,
      identityHash: productIdentity(product),
      rawObservationIdentityHash: productIdentity(observedProduct),
      preparedIdentityHash: productIdentity(product),
      comparison,
      sourceJdPrice: product.price,
      competitorPrice: selected[0].price,
      marketCheckedAt: String(detail.checkedAt),
      decision,
    };
    if (expected && digest(payload) !== expected.payloadHash)
      fail("竞品定价复核事实已变化");
    return payload;
  }

  build(shop: string, product: Product, categoryId: string, unit: string) {
    const payload = this.evaluate(shop, product, categoryId, unit);
    if (!payload) return null;
    const existing: any = this.store.db
      .prepare("SELECT remote_id FROM products WHERE shop=? AND sku=?")
      .all(shop, product.sku)
      .find((row: any) => row.remote_id);
    if (existing) fail("竞品优势价仅授权新品，已有远端商品不能新建复核");
    const id = randomUUID();
    const stored = { ...payload, payloadHash: digest(payload) };
    this.store.db
      .prepare("INSERT INTO competitive_price_reviews VALUES(?,?,?,?,?,?)")
      .run(
        id,
        shop,
        product.sku,
        payload.identityHash,
        JSON.stringify(stored),
        new Date().toISOString(),
      );
    const marketUrl = `https://b.csgmall.com.cn/mall-view/product/detail?itemId=${encodeURIComponent(payload.marketItemId)}&skuId=${encodeURIComponent(payload.marketSkuId)}`;
    return {
      rulesVersion: "catalog-competitive-v1" as const,
      competitivePricingReviewId: id,
      price: {
        value: amount(payload.decision.offerCents),
        basis: "competitor-bounded" as const,
        sourceUrl: marketUrl,
        capturedAt: new Date(
          Math.min(
            Date.parse(payload.sourceJdPrice.capturedAt),
            Date.parse(payload.marketCheckedAt),
          ),
        ).toISOString(),
        evidence: `竞品定价复核 ${id}；对应商品展示单价，不表示全网最低或含运价`,
      },
    };
  }

  /**
   * Rebuild an unpublished competitive review after a real same-price quote.
   * The caller must persist the quote snapshot in the surrounding transaction
   * before calling this method because evaluate() verifies that exact snapshot.
   */
  refreshUnpublishedSamePrice(
    shop: string,
    previousProduct: Product,
    refreshedProduct: Product,
    freshQuote: Product,
    plan: CompetitivePlan,
    now = Date.now(),
  ) {
    if (!plan.competitivePricingReviewId)
      fail("原计划缺少竞品定价复核，不能自动恢复");
    const productRow: any = this.store.db
      .prepare("SELECT * FROM products WHERE shop=? AND sku=? AND variant=?")
      .get(shop, previousProduct.sku, previousProduct.variant);
    if (
      !productRow ||
      productRow.remote_id ||
      [
        "DRAFT_SAVED",
        "DRAFT_VERIFIED",
        "SUBMIT_REQUESTED",
        "SUBMITTED",
        "APPROVED",
        "ON_SALE",
        "UNKNOWN_OUTCOME",
      ].includes(String(productRow.state)) ||
      this.store.pending(String(productRow.id))
    )
      fail("仅未保存且无未决写入的新品可自动恢复竞品核价");
    const storedProduct = JSON.parse(String(productRow.product)) as Product;
    if (productIdentity(storedProduct) !== productIdentity(previousProduct))
      fail("原计划商品与当前未发布记录不一致");
    const reviewRow: any = this.store.db
      .prepare(
        "SELECT * FROM competitive_price_reviews WHERE id=? AND shop=? AND sku=?",
      )
      .get(plan.competitivePricingReviewId, shop, previousProduct.sku);
    if (
      !reviewRow ||
      reviewRow.identity_hash !== productIdentity(previousProduct)
    )
      fail("原竞品定价复核与当前商品身份不一致");
    const saved = JSON.parse(String(reviewRow.payload));
    const categoryId = plan.catalogBinding?.categoryId ?? plan.categoryId;
    if (
      !categoryId ||
      saved.categoryId !== categoryId ||
      saved.unit !== plan.unit
    )
      fail("原竞品定价复核与计划类目或单位不一致");
    const refreshedPrice = refreshedProduct.price;
    if (
      !refreshedPrice ||
      refreshedPrice.value !== saved.sourceJdPrice?.value ||
      refreshedPrice.basis !== saved.sourceJdPrice?.basis ||
      refreshedPrice.sourceUrl !== saved.sourceJdPrice?.sourceUrl
    )
      fail("京东核价与原竞品定价基准不同，需明确重建价格计划");
    const observation: any = this.store.db
      .prepare(
        `SELECT * FROM opportunity_source_observations
         WHERE row_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1`,
      )
      .get(saved.rowId);
    if (!observation) fail("原竞品定价复核缺少来源观察");
    const rawObserved = JSON.parse(String(observation.product)) as Product;
    const refreshedObserved = mergeFreshPrice(rawObserved, freshQuote, now);
    new OpportunitySources(
      this.store,
      new OpportunityExecution(this.store),
    ).record(String(saved.rowId), refreshedObserved, now);
    const rebuilt = this.build(shop, refreshedProduct, categoryId, plan.unit);
    if (
      !rebuilt ||
      rebuilt.price.value !== plan.price.value ||
      rebuilt.price.basis !== plan.price.basis
    )
      fail("当前竞品核价结果与原计划售价不同，需明确重建价格计划");
    return rebuilt;
  }

  verify(shop: string, product: Product, plan: CompetitivePlan) {
    if (!plan.competitivePricingReviewId) return;
    const row: any = this.store.db
      .prepare(
        "SELECT * FROM competitive_price_reviews WHERE id=? AND shop=? AND sku=?",
      )
      .get(plan.competitivePricingReviewId, shop, product.sku);
    if (!row || row.identity_hash !== productIdentity(product))
      fail("竞品定价复核不存在或商品身份已变化");
    const saved = JSON.parse(String(row.payload));
    const categoryId = plan.catalogBinding?.categoryId ?? plan.categoryId;
    if (
      !categoryId ||
      categoryId !== saved.categoryId ||
      plan.unit !== saved.unit
    )
      fail("计划类目或单位与竞品定价复核不一致");
    const current = this.evaluate(shop, product, categoryId, plan.unit, saved);
    if (!current || digest(current) !== saved.payloadHash)
      fail("竞品定价复核已失效");
    if (
      plan.price.basis !== "competitor-bounded" ||
      plan.price.value !== amount(current.decision.offerCents)
    )
      fail("计划价格与竞品定价复核不一致");
  }
}
