import { randomUUID } from "node:crypto";
import { z } from "zod";
import { Store } from "./store.js";
import { digest } from "./model.js";
import { MarketScan } from "./market-scan.js";
import { MarketDetails } from "./market-details.js";
import { PricingStore, pricingIdentity } from "./pricing-store.js";
import { decidePrice, type PriceReview } from "./pricing.js";
const judgment = z.object({
  match: z.enum(["exact", "different"]),
  evidence: z.array(z.string().min(1)).min(1),
  receiptId: z.string().optional(),
  unconditional: z.boolean().optional(),
  shippingKnown: z.boolean().optional(),
});
export class PricingTasks {
  constructor(readonly store: Store) {
    store.db.exec(
      `CREATE TABLE IF NOT EXISTS pricing_tasks(id TEXT PRIMARY KEY,request_key TEXT NOT NULL UNIQUE,shop TEXT NOT NULL,product_id TEXT NOT NULL,identity_hash TEXT NOT NULL,own_shop_id TEXT NOT NULL,market_runs TEXT NOT NULL,status TEXT NOT NULL,review_id TEXT,error TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);CREATE TABLE IF NOT EXISTS pricing_candidates(task_id TEXT REFERENCES pricing_tasks(id),offer_id TEXT,candidate TEXT NOT NULL,judgment TEXT,PRIMARY KEY(task_id,offer_id));`,
    );
    new MarketDetails(store);
    new PricingStore(store);
  }
  private get(id: string): any {
    const r = this.store.db
      .prepare("SELECT * FROM pricing_tasks WHERE id=?")
      .get(id);
    if (!r) throw Error("比价审查任务不存在");
    return r;
  }
  private product(task: any) {
    const row = this.store.get(task.product_id);
    if (
      row.shop !== task.shop ||
      !row.product ||
      pricingIdentity(row.product) !== task.identity_hash
    )
      throw Error("商品资料已变化，需重新建立比价任务");
    return row.product;
  }
  start(shop: string, productId: string, ownShopId: string, runIds: string[]) {
    const row = this.store.get(productId);
    if (row.shop !== shop || !row.product || !ownShopId || !runIds.length)
      throw Error("比价任务缺少来源、店铺或搜索范围");
    const market = new MarketScan(this.store),
      runs = [...new Set(runIds)].sort();
    const pages = runs.flatMap((id) => {
      const r = market.get(id);
      if (r.shop !== shop || r.status !== "complete")
        throw Error("商城搜索未完成或店铺不符");
      return market.pages(id);
    });
    const hash = pricingIdentity(row.product),
      key = digest({ shop, productId, ownShopId, runs, hash });
    const exists = this.store.db
      .prepare("SELECT id FROM pricing_tasks WHERE request_key=?")
      .get(key);
    if (exists) return String(exists.id);
    const candidates = new Map<string, any>();
    for (const p of pages)
      for (const r of p.rows)
        for (const sku of r.skus) {
          const old = candidates.get(sku.skuId);
          if (old && (old.itemId !== r.itemId || old.shopId !== r.shopId))
            throw Error("同一竞品SKU身份冲突");
          candidates.set(sku.skuId, { ...r, sku, checkedAt: p.checkedAt });
        }
    return this.store.tx(() => {
      const id = randomUUID(),
        at = new Date().toISOString();
      this.store.db
        .prepare(
          "INSERT INTO pricing_tasks VALUES(?,?,?,?,?,?,?,'reviewing',NULL,NULL,?,?)",
        )
        .run(
          id,
          key,
          shop,
          productId,
          hash,
          ownShopId,
          JSON.stringify(runs),
          at,
          at,
        );
      for (const [offerId, candidate] of candidates)
        this.store.db
          .prepare("INSERT INTO pricing_candidates VALUES(?,?,?,?)")
          .run(
            id,
            offerId,
            JSON.stringify(candidate),
            candidate.shopId === ownShopId
              ? JSON.stringify({
                  match: "different",
                  evidence: ["本店商品，不参加竞品定价"],
                })
              : null,
          );
      return id;
    });
  }
  candidates(id: string) {
    this.get(id);
    return this.store.db
      .prepare(
        "SELECT * FROM pricing_candidates WHERE task_id=? ORDER BY offer_id",
      )
      .all(id)
      .map((r) => ({
        offerId: String(r.offer_id),
        candidate: JSON.parse(String(r.candidate)),
        judgment: r.judgment ? JSON.parse(String(r.judgment)) : null,
      }));
  }
  private offer(task: any, candidate: any, input: z.infer<typeof judgment>) {
    let price = candidate.sku.price,
      checkedAt = candidate.checkedAt,
      available = true;
    if (input.match === "exact") {
      if (!input.receiptId) throw Error("同款候选缺少详情回执");
      const d = new MarketDetails(this.store).get(input.receiptId),
        sku = d.skus.find((s) => s.id === candidate.sku.skuId);
      if (
        d.shop !== task.shop ||
        d.itemId !== candidate.itemId ||
        d.shopId !== candidate.shopId ||
        !sku
      )
        throw Error("详情回执与竞品身份不符");
      price = sku.price;
      available = sku.available;
      checkedAt = new Date(
        Math.min(Date.parse(d.checkedAt), Date.parse(candidate.checkedAt)),
      ).toISOString();
      if (
        typeof input.unconditional !== "boolean" ||
        typeof input.shippingKnown !== "boolean"
      )
        throw Error("同款购买条件尚未核对");
    }
    return {
      id: candidate.sku.skuId,
      shopId: candidate.shopId,
      url: candidate.url,
      price,
      checkedAt,
      available,
      match: input.match,
      evidence: [
        ...input.evidence,
        ...(input.receiptId ? ["详情回执 " + input.receiptId] : []),
      ],
      unconditional: input.unconditional ?? false,
      minimum: Number(candidate.minimum),
      shippingKnown: input.shippingKnown ?? false,
    };
  }
  update(id: string, offerId: string, input: unknown) {
    const task = this.get(id);
    if (task.status === "finalized")
      throw Error("已完成审查不可改写，请建立新搜索范围");
    this.product(task);
    const data = judgment.parse(input),
      row = this.candidates(id).find((r) => r.offerId === offerId);
    if (!row) throw Error("候选不属于本次搜索范围");
    this.offer(task, row.candidate, data);
    this.store.tx(() => {
      this.store.db
        .prepare(
          "UPDATE pricing_candidates SET judgment=? WHERE task_id=? AND offer_id=?",
        )
        .run(JSON.stringify(data), id, offerId);
      this.store.db
        .prepare("UPDATE pricing_tasks SET error=NULL,updated_at=? WHERE id=?")
        .run(new Date().toISOString(), id);
      this.store.event(task.product_id, "PRICING_CANDIDATE_REVIEW", {
        taskId: id,
        offerId,
        ...data,
      });
    });
    return this.status(id);
  }
  status(id: string) {
    const task = this.get(id),
      rows = this.candidates(id);
    const productRow = this.store.get(task.product_id);
    const reviewRow = task.review_id
      ? this.store.db
          .prepare("SELECT review FROM price_reviews WHERE id=?")
          .get(task.review_id)
      : null;
    const review: PriceReview | null = reviewRow
      ? JSON.parse(String(reviewRow.review))
      : null;
    const expiresAt = review
      ? new Date(
          Math.min(
            Date.parse(review.checkedAt),
            ...review.offers
              .filter((o) => o.shopId !== review.shopId)
              .map((o) => Date.parse(o.checkedAt)),
          ) + 3600000,
        ).toISOString()
      : null;
    return {
      id,
      sku: productRow.sku,
      title: productRow.product?.title.value ?? productRow.sku,
      expiresAt,
      evidenceExpired: expiresAt ? Date.parse(expiresAt) < Date.now() : false,
      identityChanged:
        !!productRow.product &&
        pricingIdentity(productRow.product) !== task.identity_hash,
      productId: String(task.product_id),
      shop: String(task.shop),
      status: String(task.status),
      reviewId: task.review_id ? String(task.review_id) : null,
      total: rows.length,
      reviewed: rows.filter((r) => r.judgment).length,
      pending: rows.filter((r) => !r.judgment).length,
      error: task.error ? String(task.error) : null,
      updatedAt: String(task.updated_at),
    };
  }
  list(shop: string) {
    return this.store.db
      .prepare(
        "SELECT id FROM pricing_tasks WHERE shop=? ORDER BY updated_at DESC",
      )
      .all(shop)
      .map((r) => this.status(String(r.id)));
  }
  finalize(id: string) {
    const task = this.get(id);
    const product = this.product(task);
    if (task.review_id)
      return { reviewId: String(task.review_id), reused: true };
    try {
      const candidates = this.candidates(id);
      if (candidates.some((r) => !r.judgment))
        throw Error("尚未核验全部竞品候选");
      const market = new MarketScan(this.store),
        runs: string[] = JSON.parse(task.market_runs);
      const pages = runs.flatMap((r) => {
        const run = market.get(r);
        if (run.shop !== task.shop || run.status !== "complete")
          throw Error("搜索覆盖证据已失效");
        return market.pages(r);
      });
      const review: PriceReview = {
        shopId: task.own_shop_id,
        sourceSku: product.sku,
        sourceIdentityHash: task.identity_hash,
        checkedAt: new Date(
          Math.min(...pages.map((p) => Date.parse(p.checkedAt))),
        ).toISOString(),
        complete: true,
        searchUrls: [...new Set(pages.map((p) => p.url))],
        offers: candidates.map((r) =>
          this.offer(task, r.candidate, judgment.parse(r.judgment)),
        ),
      };
      const decision = decidePrice(review, product.price);
      return this.store.tx(() => {
        const reviewId = new PricingStore(this.store).save(
          task.shop,
          product,
          review,
        );
        this.store.db
          .prepare(
            "UPDATE pricing_tasks SET status='finalized',review_id=?,error=NULL,updated_at=? WHERE id=?",
          )
          .run(reviewId, new Date().toISOString(), id);
        return { reviewId, decision, reused: false };
      });
    } catch (error) {
      this.store.db
        .prepare("UPDATE pricing_tasks SET error=?,updated_at=? WHERE id=?")
        .run(
          error instanceof Error ? error.message : String(error),
          new Date().toISOString(),
          id,
        );
      throw error;
    }
  }
}
