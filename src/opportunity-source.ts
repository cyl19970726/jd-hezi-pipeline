import { digest, parseSku, productSchema, type Product } from "./model.js";
import { listingPrice } from "./listing-price.js";
import { OpportunityExecution } from "./opportunity-execution.js";
import { compareMarketSource } from "./opportunity-source-match.js";
import type { Store } from "./store.js";

/** Immutable observations used by opportunity matching; never writes products/jobs. */
export class OpportunitySources {
  constructor(
    readonly store: Store,
    readonly ledger: OpportunityExecution,
  ) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS opportunity_source_observations(
      id TEXT PRIMARY KEY,row_id TEXT NOT NULL REFERENCES opportunity_rows(id),
      detail_receipt_id TEXT NOT NULL,product TEXT NOT NULL,comparison TEXT NOT NULL,
      price_issue TEXT,created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS opportunity_source_row ON opportunity_source_observations(row_id,created_at);`);
  }

  private market(rowId: string) {
    const row = this.ledger.row(rowId);
    const evidence = this.ledger
      .evidence(rowId)
      .filter((e) => e.kind === "source-match")
      .at(-1)?.payload;
    if (!row.targetSku || !evidence?.detailReceiptId)
      throw Error("尚未取得唯一京东来源链接");
    const saved = this.store.db
      .prepare(
        "SELECT payload,checked_at FROM market_details WHERE id=? AND shop=? AND item_id=?",
      )
      .get(String(evidence.detailReceiptId), row.shop, row.marketItemId);
    if (!saved) throw Error("来源详情回执缺失或身份不一致");
    return {
      row,
      sourceEvidence: evidence,
      receiptId: String(evidence.detailReceiptId),
      payload: JSON.parse(String(saved.payload)),
      checkedAt: String(saved.checked_at),
    };
  }

  private candidateMarket(rowId: string, sourceSku: string) {
    const row = this.ledger.row(rowId);
    const selected = this.ledger
      .evidence(rowId)
      .filter((entry) => entry.kind === "source-candidate-selected")
      .at(-1)?.payload;
    if (
      row.targetSku ||
      !selected ||
      selected.lane !== "exact" ||
      selected.candidate?.sku !== sourceSku
    )
      throw Error("尚未选择可核验的精确京东候选");
    const detailReceiptId = this.store.meta(
      "opportunity-detail:" + rowId,
    )?.receiptId;
    if (!detailReceiptId) throw Error("竞品详情回执缺失");
    const saved = this.store.db
      .prepare(
        "SELECT payload,checked_at FROM market_details WHERE id=? AND shop=? AND item_id=?",
      )
      .get(String(detailReceiptId), row.shop, row.marketItemId);
    if (!saved) throw Error("来源详情回执缺失或身份不一致");
    return {
      row,
      selected,
      receiptId: String(detailReceiptId),
      payload: JSON.parse(String(saved.payload)),
      checkedAt: String(saved.checked_at),
    };
  }

  private priceIssue(
    shop: string,
    product: Product,
    now: number,
  ): string | null {
    try {
      if (this.store.meta("listing-price:" + shop) !== "jd-regular-preferred")
        throw Error("尚未采用京东日常价优先策略");
      const decision = listingPrice(this.store, shop, product);
      if (parseSku(decision.price.sourceUrl) !== product.sku)
        throw Error("报价来源不是当前京东SKU");
      const age = now - Date.parse(decision.price.capturedAt);
      if (!Number.isFinite(age) || age < 0 || age > 30 * 60 * 1000)
        throw Error("京东报价已过期，需要重新核价");
      return null;
    } catch (error: any) {
      return error.message;
    }
  }

  record(rowId: string, input: Product, now = Date.now()) {
    const product = productSchema.parse(input),
      market = this.market(rowId);
    if (
      product.sku !== market.row.targetSku ||
      parseSku(product.url) !== market.row.targetSku
    )
      throw Error("京东采集SKU与机会来源不一致");
    const previous = this.latest(rowId);
    if (
      previous &&
      (now < Date.parse(previous.createdAt) ||
        Date.parse(product.capturedAt) <
          Date.parse(previous.product.capturedAt))
    )
      throw Error("京东观察时间早于已保存证据，不能覆盖较新的核对结果");
    const comparison = compareMarketSource(
      {
        marketPayload: market.payload,
        marketItemId: market.row.marketItemId,
        marketSkuId: market.row.marketSkuId,
        marketShopId: market.row.marketShopId,
        source: product,
        detailReceiptId: market.receiptId,
        marketCheckedAt: market.checkedAt,
        ...(market.sourceEvidence.candidateReceiptId
          ? {
              candidateDiscovery: {
                receiptId: String(market.sourceEvidence.candidateReceiptId),
                query: String(
                  this.ledger
                    .evidence(rowId)
                    .filter(
                      (entry) =>
                        entry.kind === "source-candidate-selected" &&
                        entry.payload.receiptId ===
                          market.sourceEvidence.candidateReceiptId,
                    )
                    .at(-1)?.payload.query ?? "",
                ),
              },
            }
          : {}),
      },
      now,
    );
    const priceIssue = this.priceIssue(market.row.shop, product, now);
    const id = digest({ rowId, product, comparison, priceIssue });
    this.store.tx(() => {
      this.store.db
        .prepare(
          "INSERT OR IGNORE INTO opportunity_source_observations VALUES(?,?,?,?,?,?,?)",
        )
        .run(
          id,
          rowId,
          market.receiptId,
          JSON.stringify(product),
          JSON.stringify(comparison),
          priceIssue,
          new Date(now).toISOString(),
        );
      this.store.setMeta("opportunity-source:" + rowId, {
        collectionMode:
          this.store.meta("opportunity-source:" + rowId)?.collectionMode ??
          null,
        id,
        checkedAt: product.capturedAt,
        matched: comparison.matched,
        blockers: [...comparison.blockers, ...(priceIssue ? [priceIssue] : [])],
      });
      if (comparison.matched)
        this.ledger.verifySourceProduct(
          rowId,
          {
            sourceSku: product.sku,
            detailReceiptId: market.receiptId,
            checkedAt: comparison.checkedAt,
            fields: comparison.fields,
          },
          new Date(now).toISOString(),
        );
      else
        this.ledger.rejectSourceProduct(
          rowId,
          market.receiptId,
          comparison.blockers,
          new Date(now).toISOString(),
        );
      this.ledger.evaluateForPreparation(rowId, { now });
    });
    return this.latest(rowId)!;
  }

  /** Full-product verification for a search candidate; only a strict match is promoted. */
  recordCandidate(rowId: string, input: Product, now = Date.now()) {
    const product = productSchema.parse(input);
    const market = this.candidateMarket(rowId, product.sku);
    if (parseSku(product.url) !== product.sku)
      throw Error("京东候选采集链接与SKU不一致");
    const comparison = compareMarketSource(
      {
        marketPayload: market.payload,
        marketItemId: market.row.marketItemId,
        marketSkuId: market.row.marketSkuId,
        marketShopId: market.row.marketShopId,
        source: product,
        detailReceiptId: market.receiptId,
        marketCheckedAt: market.checkedAt,
        candidateDiscovery: {
          receiptId: market.selected.receiptId,
          query: market.selected.query,
        },
      },
      now,
    );
    const priceIssue = this.priceIssue(market.row.shop, product, now);
    const id = digest({ rowId, product, comparison, priceIssue });
    this.store.tx(() => {
      this.store.db
        .prepare(
          "INSERT OR IGNORE INTO opportunity_source_observations VALUES(?,?,?,?,?,?,?)",
        )
        .run(
          id,
          rowId,
          market.receiptId,
          JSON.stringify(product),
          JSON.stringify(comparison),
          priceIssue,
          new Date(now).toISOString(),
        );
      this.store.setMeta("opportunity-source:" + rowId, {
        collectionMode: "candidate-full",
        id,
        checkedAt: product.capturedAt,
        matched: comparison.matched,
        blockers: [...comparison.blockers, ...(priceIssue ? [priceIssue] : [])],
      });
      if (comparison.matched) {
        this.ledger.acceptDiscoveredExactSource(
          rowId,
          {
            receiptId: market.selected.receiptId,
            sourceSku: product.sku,
            detailReceiptId: market.receiptId,
          },
          new Date(now).toISOString(),
        );
        this.ledger.verifySourceProduct(
          rowId,
          {
            sourceSku: product.sku,
            detailReceiptId: market.receiptId,
            checkedAt: comparison.checkedAt,
            fields: comparison.fields,
          },
          new Date(now).toISOString(),
        );
      } else {
        this.ledger.rejectSourceProduct(
          rowId,
          market.receiptId,
          comparison.blockers,
          new Date(now).toISOString(),
        );
      }
      this.ledger.evaluateForPreparation(rowId, { now });
    });
    return this.latest(rowId)!;
  }

  latest(rowId: string) {
    this.ledger.row(rowId);
    const pointer = this.store.meta("opportunity-source:" + rowId);
    const r = pointer?.id
      ? this.store.db
          .prepare(
            "SELECT * FROM opportunity_source_observations WHERE id=? AND row_id=?",
          )
          .get(pointer.id, rowId)
      : undefined;
    if (!r) return null;
    return {
      id: String(r.id),
      product: productSchema.parse(JSON.parse(String(r.product))),
      comparison: JSON.parse(String(r.comparison)) as ReturnType<
        typeof compareMarketSource
      >,
      priceIssue: r.price_issue === null ? null : String(r.price_issue),
      createdAt: String(r.created_at),
    };
  }

  recheck(rowId: string, now = Date.now()) {
    const previous = this.latest(rowId);
    if (!previous) throw Error("尚未采集京东商品规格");
    return this.record(rowId, previous.product, now);
  }

  assertPrepared(rowId: string, now = Date.now()) {
    const result = this.recheck(rowId, now);
    if (!result.comparison.matched)
      throw Error(
        result.comparison.blockers.join("；") || "京东商品尚未准确对应",
      );
    if (result.priceIssue) throw Error(result.priceIssue);
    return result;
  }
}
