import { randomUUID } from "node:crypto";
import { Store } from "./store.js";
import { digest, PipelineError, type Product, type Plan } from "./model.js";
import { decidePrice, priceReviewSchema, type PriceReview } from "./pricing.js";
import { CompetitivePricing } from "./competitive-pricing.js";
export function pricingIdentity(product: Product) {
  return digest({
    sku: product.sku,
    variant: product.variant,
    title: product.title,
    specs: product.specs,
  });
}
export class PricingStore {
  constructor(readonly store: Store) {
    store.db.exec(
      "CREATE TABLE IF NOT EXISTS price_reviews(id TEXT PRIMARY KEY,shop TEXT NOT NULL,sku TEXT NOT NULL,identity_hash TEXT NOT NULL,review TEXT NOT NULL,created_at TEXT NOT NULL); CREATE INDEX IF NOT EXISTS price_reviews_lookup ON price_reviews(shop,sku,created_at);",
    );
  }
  save(shop: string, product: Product, input: PriceReview) {
    const review = priceReviewSchema.parse(input);
    if (
      review.sourceSku !== product.sku ||
      review.sourceIdentityHash !== pricingIdentity(product)
    )
      throw new PipelineError("NEEDS_INPUT", "比价证据与来源商品不一致");
    const id = randomUUID();
    this.store.db
      .prepare("INSERT INTO price_reviews VALUES(?,?,?,?,?,?)")
      .run(
        id,
        shop,
        product.sku,
        review.sourceIdentityHash,
        JSON.stringify(review),
        new Date().toISOString(),
      );
    return id;
  }
  resolve(shop: string, product: Product, id?: string) {
    const row = id
      ? this.store.db
          .prepare(
            "SELECT * FROM price_reviews WHERE id=? AND shop=? AND sku=?",
          )
          .get(id, shop, product.sku)
      : this.store.db
          .prepare(
            "SELECT * FROM price_reviews WHERE shop=? AND sku=? AND identity_hash=? ORDER BY created_at DESC,rowid DESC LIMIT 1",
          )
          .get(shop, product.sku, pricingIdentity(product));
    if (!row) return null;
    if (row.identity_hash !== pricingIdentity(product))
      throw new PipelineError("NEEDS_INPUT", "商品资料已变化，需重新比价");
    const review = priceReviewSchema.parse(JSON.parse(String(row.review)));
    return {
      id: String(row.id),
      review,
      decision: decidePrice(review, product.price),
    };
  }
  verify(shop: string, product: Product, plan: Plan) {
    new CompetitivePricing(this.store).verify(shop, product, plan);
    if (!plan.pricingReviewId) return;
    const result = this.resolve(shop, product, plan.pricingReviewId);
    if (!result) throw new PipelineError("NEEDS_INPUT", "比价记录不存在");
    if (
      result.decision.value !== plan.price.value ||
      result.decision.basis !== plan.price.basis
    )
      throw new PipelineError("NEEDS_INPUT", "计划价格与数据库比价决策不一致");
  }
}
