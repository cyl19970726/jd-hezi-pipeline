import { z } from "zod";
import { Catalog } from "./catalog.js";
import { MarketDetails } from "./market-details.js";
import { digest, PipelineError } from "./model.js";
import { OperationalReadiness } from "./operational-readiness.js";
import { SourceIndex } from "./source-index.js";
import type { Store } from "./store.js";

const id = z.string().min(1);
const cohortSchema = z.object({
  cohortKey: id,
  shop: id,
  sourceReportId: id,
  importedAt: z.string().datetime(),
  rows: z
    .array(
      z.object({
        opportunityId: id,
        marketItemId: id,
        marketShopId: id,
        marketSkuId: id,
        rank: z.number().int().positive(),
        targetSku: z.string().regex(/^\d+$/).nullable().default(null),
        title: z.string().min(1).optional(),
        brand: z.string().min(1).optional(),
        marketUrl: z.string().url().optional(),
        unit: z.string().min(1).optional(),
      }),
    )
    .min(1),
});
export type OpportunityCohort = z.infer<typeof cohortSchema>;

export type OpportunityBlocker = {
  code:
    | "SOURCE_MATCH"
    | "STALE_EVIDENCE"
    | "AUTHORIZATION"
    | "PRICING"
    | "DUPLICATE";
  message: string;
};

type EvidenceKind =
  | "source-match"
  | "source-candidate-search"
  | "source-candidate-selected"
  | "source-product-verified"
  | "source-product-rejected"
  | "readiness"
  | "job-associated"
  | "result"
  | "reconciliation";

/**
 * Local execution ledger for a frozen opportunity report. It observes publisher
 * state but deliberately owns none of the publisher's products, jobs or operations.
 */
export class OpportunityExecution {
  readonly details: MarketDetails;
  readonly catalog: Catalog;
  readonly sources: SourceIndex;
  readonly readiness: OperationalReadiness;

  constructor(readonly store: Store) {
    this.details = new MarketDetails(store);
    this.catalog = new Catalog(store);
    this.sources = new SourceIndex(store);
    this.readiness = new OperationalReadiness(store, {
      catalog: this.catalog,
      sources: this.sources,
    });
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS opportunity_cohorts(
        cohort_key TEXT PRIMARY KEY,shop TEXT NOT NULL,source_report_id TEXT NOT NULL,
        imported_at TEXT NOT NULL,payload_hash TEXT NOT NULL,payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS opportunity_rows(
        id TEXT PRIMARY KEY,cohort_key TEXT NOT NULL REFERENCES opportunity_cohorts(cohort_key),
        ordinal INTEGER NOT NULL,opportunity_id TEXT NOT NULL,market_item_id TEXT NOT NULL,
        market_shop_id TEXT NOT NULL,market_sku_id TEXT NOT NULL,rank INTEGER NOT NULL,
        target_sku TEXT,status TEXT NOT NULL,
        blockers TEXT NOT NULL,job_id TEXT,result_state TEXT,updated_at TEXT NOT NULL,
        UNIQUE(cohort_key,opportunity_id),UNIQUE(cohort_key,market_shop_id,market_item_id,market_sku_id));
      CREATE TABLE IF NOT EXISTS opportunity_evidence(
        id TEXT PRIMARY KEY,row_id TEXT NOT NULL REFERENCES opportunity_rows(id),kind TEXT NOT NULL,
        observed_at TEXT NOT NULL,payload TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS opportunity_evidence_row ON opportunity_evidence(row_id,observed_at,id);
    `);
  }

  importCohort(input: unknown) {
    const cohort = cohortSchema.parse(input);
    const identities = cohort.rows.map((row) =>
      digest({
        opportunityId: row.opportunityId,
        marketItemId: row.marketItemId,
        marketShopId: row.marketShopId,
        marketSkuId: row.marketSkuId,
        rank: row.rank,
        targetSku: row.targetSku,
      }),
    );
    if (new Set(identities).size !== identities.length)
      throw new PipelineError("NEEDS_INPUT", "机会报告包含重复身份");
    if (
      new Set(cohort.rows.map((row) => row.opportunityId)).size !==
      cohort.rows.length
    )
      throw new PipelineError(
        "NEEDS_INPUT",
        "同一机会ID对应多条候选，不能冻结",
      );
    const payload = JSON.stringify(cohort);
    const payloadHash = digest(cohort);
    return this.store.tx(() => {
      const old: any = this.store.db
        .prepare("SELECT * FROM opportunity_cohorts WHERE cohort_key=?")
        .get(cohort.cohortKey);
      if (old) {
        if (old.payload_hash !== payloadHash)
          throw new PipelineError(
            "NEEDS_INPUT",
            "该执行批次已经冻结，重试内容与原始机会身份不一致",
          );
        return {
          cohortKey: cohort.cohortKey,
          reused: true,
          rowCount: cohort.rows.length,
        };
      }
      this.store.db
        .prepare("INSERT INTO opportunity_cohorts VALUES(?,?,?,?,?,?)")
        .run(
          cohort.cohortKey,
          cohort.shop,
          cohort.sourceReportId,
          cohort.importedAt,
          payloadHash,
          payload,
        );
      const now = new Date().toISOString();
      cohort.rows.forEach((row, ordinal) => {
        const rowId = digest({ cohortKey: cohort.cohortKey, ...row });
        this.store.db
          .prepare(
            "INSERT INTO opportunity_rows VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
          )
          .run(
            rowId,
            cohort.cohortKey,
            ordinal,
            row.opportunityId,
            row.marketItemId,
            row.marketShopId,
            row.marketSkuId,
            row.rank,
            row.targetSku,
            "IMPORTED",
            JSON.stringify([
              { code: "SOURCE_MATCH", message: "尚无精确来源链接证据" },
            ]),
            null,
            null,
            now,
          );
      });
      return {
        cohortKey: cohort.cohortKey,
        reused: false,
        rowCount: cohort.rows.length,
      };
    });
  }

  rows(cohortKey: string) {
    return this.store.db
      .prepare(
        `SELECT r.*,c.shop,c.source_report_id,c.imported_at FROM opportunity_rows r
         JOIN opportunity_cohorts c ON c.cohort_key=r.cohort_key
         WHERE r.cohort_key=? ORDER BY r.ordinal`,
      )
      .all(cohortKey)
      .map((row: any) => this.decode(row));
  }

  row(rowId: string) {
    const row: any = this.store.db
      .prepare(
        `SELECT r.*,c.shop,c.source_report_id,c.imported_at FROM opportunity_rows r
         JOIN opportunity_cohorts c ON c.cohort_key=r.cohort_key WHERE r.id=?`,
      )
      .get(rowId);
    if (!row) throw new PipelineError("NEEDS_INPUT", "机会执行行不存在");
    return this.decode(row);
  }

  acceptExactSource(
    rowId: string,
    input: {
      detailReceiptId: string;
      brandId: string;
      categoryId: string;
      unit: string;
    },
    observedAt = new Date().toISOString(),
  ) {
    const row = this.row(rowId);
    const detail = this.details.get(input.detailReceiptId);
    if (
      detail.shop !== row.shop ||
      detail.itemId !== row.marketItemId ||
      detail.shopId !== row.marketShopId
    )
      throw new PipelineError(
        "NEEDS_INPUT",
        "竞品详情与冻结的店铺或商品身份不一致",
      );
    const sku = detail.skus.find(
      (candidate) => candidate.id === row.marketSkuId,
    );
    if (!sku)
      throw new PipelineError("NEEDS_INPUT", "竞品详情缺少冻结的销售SKU");
    if (sku.sourceSkus.length !== 1)
      throw new PipelineError(
        "NEEDS_INPUT",
        "销售SKU必须有且仅有一个可解析京东详情链接；标题或模糊相似不能替代",
      );
    const targetSku = sku.sourceSkus[0];
    if (row.targetSku && row.targetSku !== targetSku)
      throw new PipelineError(
        "NEEDS_INPUT",
        "目标京东SKU已经绑定，不能静默替换",
      );
    if (!sku.unit || sku.unit.trim() !== input.unit.trim())
      throw new PipelineError("NEEDS_INPUT", "销售单位缺失或与核验单位不一致");
    const receipt: any = this.store.db
      .prepare("SELECT payload FROM market_details WHERE id=?")
      .get(input.detailReceiptId);
    let raw: any;
    try {
      raw = JSON.parse(String(receipt?.payload));
    } catch {
      throw new PipelineError("NEEDS_INPUT", "竞品详情原始证据缺失");
    }
    const rawBrandId = raw?.data?.itemPublishVo?.brandId;
    const rawCategoryId = raw?.data?.itemPublishVo?.cid;
    if (
      rawBrandId === undefined ||
      rawCategoryId === undefined ||
      String(rawBrandId) !== input.brandId ||
      String(rawCategoryId) !== input.categoryId
    )
      throw new PipelineError(
        "NEEDS_INPUT",
        "品牌或类目ID不是竞品详情后端的精确事实",
      );
    const category: any = this.store.db
      .prepare("SELECT path FROM catalog_categories WHERE shop=? AND id=?")
      .get(row.shop, input.categoryId);
    if (!category)
      throw new PipelineError("NEEDS_INPUT", "详情类目ID尚未同步到店铺目录");
    const payload = {
      detailReceiptId: input.detailReceiptId,
      marketItemId: row.marketItemId,
      marketShopId: row.marketShopId,
      marketSkuId: row.marketSkuId,
      targetSku,
      source: "sole-external-jd-link",
      available: sku.available,
      price: sku.price,
      unit: sku.unit,
      brand: detail.brand,
      brandId: input.brandId,
      categoryId: input.categoryId,
      categoryPath: String(category.path),
      checkedAt: detail.checkedAt,
    };
    this.store.tx(() => {
      this.append(rowId, "source-match", observedAt, payload);
      this.store.db
        .prepare(
          `UPDATE opportunity_rows
           SET target_sku=COALESCE(target_sku,?),
               status=CASE WHEN status IN ('IMPORTED','PROPOSED','BLOCKED','READY_FOR_PREPARATION')
                           THEN 'PROPOSED' ELSE status END,
               updated_at=? WHERE id=?`,
        )
        .run(targetSku, observedAt, rowId);
    });
    return {
      targetSku,
      evidenceId: digest({ rowId, kind: "source-match", observedAt, payload }),
    };
  }

  recordSourceCandidateSearch(
    rowId: string,
    input: {
      receiptId: string;
      query: string;
      checkedAt: string;
      discoveryMode?: "existing-links" | "search";
      candidates: Array<{ sku: string; url: string; title: string }>;
    },
    observedAt = new Date().toISOString(),
  ) {
    this.row(rowId);
    const checkedAt = Date.parse(input.checkedAt);
    const observed = Date.parse(observedAt);
    if (!input.receiptId.trim() || !input.query.trim())
      throw new PipelineError("NEEDS_INPUT", "来源候选搜索回执或检索词缺失");
    if (
      !Number.isFinite(checkedAt) ||
      !Number.isFinite(observed) ||
      checkedAt > observed + 60_000 ||
      observed - checkedAt > 3_600_000 ||
      input.candidates.length > 10 ||
      input.candidates.some((candidate) => {
        try {
          const url = new URL(candidate.url);
          return (
            !/^\d+$/.test(candidate.sku) ||
            !candidate.title.trim() ||
            url.protocol !== "https:" ||
            url.hostname !== "item.jd.com" ||
            url.pathname !== `/${candidate.sku}.html`
          );
        } catch {
          return true;
        }
      }) ||
      new Set(input.candidates.map((candidate) => candidate.sku)).size !==
        input.candidates.length
    )
      throw new PipelineError(
        "NEEDS_INPUT",
        "来源候选搜索回执不完整或身份无效",
      );
    return this.append(rowId, "source-candidate-search", observedAt, input);
  }

  selectSourceCandidate(
    rowId: string,
    input: { receiptId: string; sku: string },
    observedAt = new Date().toISOString(),
  ) {
    const receipt = this.evidence(rowId)
      .filter((entry) => entry.kind === "source-candidate-search")
      .find((entry) => entry.payload.receiptId === input.receiptId);
    const candidate = receipt?.payload.candidates?.find(
      (entry: any) => entry.sku === input.sku,
    );
    if (!candidate)
      throw new PipelineError("NEEDS_INPUT", "所选京东候选不在指定搜索回执中");
    const checkedAt = Date.parse(String(receipt!.payload.checkedAt));
    const selectedAt = Date.parse(observedAt);
    if (
      !Number.isFinite(checkedAt) ||
      !Number.isFinite(selectedAt) ||
      checkedAt > selectedAt + 60_000 ||
      selectedAt - checkedAt > 3_600_000
    )
      throw new PipelineError(
        "NEEDS_INPUT",
        "来源候选搜索回执已过期，需重新检索",
      );
    return this.append(rowId, "source-candidate-selected", observedAt, {
      receiptId: input.receiptId,
      query: receipt!.payload.query,
      candidate,
      lane: "exact",
    });
  }

  acceptDiscoveredExactSource(
    rowId: string,
    input: { receiptId: string; sourceSku: string; detailReceiptId: string },
    observedAt = new Date().toISOString(),
  ) {
    const row = this.row(rowId);
    const selected = this.evidence(rowId)
      .filter((entry) => entry.kind === "source-candidate-selected")
      .at(-1)?.payload;
    if (
      !selected ||
      selected.receiptId !== input.receiptId ||
      selected.candidate?.sku !== input.sourceSku ||
      selected.lane !== "exact"
    )
      throw new PipelineError("NEEDS_INPUT", "精确来源不属于当前已选搜索候选");
    if (row.targetSku && row.targetSku !== input.sourceSku)
      throw new PipelineError(
        "NEEDS_INPUT",
        "目标京东SKU已经绑定，不能静默替换",
      );
    if (row.jobId)
      throw new PipelineError(
        "NEEDS_INPUT",
        "机会已进入上架任务，不能变更来源候选",
      );
    const detail = this.details.get(input.detailReceiptId);
    if (
      detail.shop !== row.shop ||
      detail.itemId !== row.marketItemId ||
      detail.shopId !== row.marketShopId
    )
      throw new PipelineError("NEEDS_INPUT", "候选核验与竞品详情身份不一致");
    const marketSku = detail.skus.find((entry) => entry.id === row.marketSkuId);
    if (!marketSku?.unit)
      throw new PipelineError("NEEDS_INPUT", "目标销售SKU缺少销售单位");
    const receipt: any = this.store.db
      .prepare("SELECT payload FROM market_details WHERE id=?")
      .get(input.detailReceiptId);
    let raw: any;
    try {
      raw = JSON.parse(String(receipt?.payload));
    } catch {
      throw new PipelineError("NEEDS_INPUT", "竞品详情原始证据缺失");
    }
    const brandId = raw?.data?.itemPublishVo?.brandId;
    const categoryId = raw?.data?.itemPublishVo?.cid;
    if (brandId === undefined || categoryId === undefined)
      throw new PipelineError("NEEDS_INPUT", "竞品详情缺少供应商品牌或类目ID");
    let publishCategoryId = String(categoryId);
    let categoryMapping: any = null;
    let observedComparison: any = null;
    if (publishCategoryId === "10015") {
      const observation: any = this.store.db
        .prepare(
          `SELECT product,comparison FROM opportunity_source_observations
           WHERE row_id=? AND detail_receipt_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1`,
        )
        .get(rowId, input.detailReceiptId);
      let observedProduct: any = null;
      try {
        observedProduct = JSON.parse(String(observation?.product));
        observedComparison = JSON.parse(String(observation?.comparison));
        categoryMapping = observedComparison.categoryMapping;
      } catch {
        categoryMapping = null;
      }
      const comparisonAt = Date.parse(String(observedComparison?.checkedAt));
      const acceptedAt = Date.parse(observedAt);
      if (
        observedProduct?.sku !== input.sourceSku ||
        observedComparison?.sourceSku !== input.sourceSku ||
        observedComparison?.detailReceiptId !== input.detailReceiptId ||
        observedComparison?.matched !== true ||
        !Number.isFinite(comparisonAt) ||
        !Number.isFinite(acceptedAt) ||
        comparisonAt > acceptedAt + 60_000 ||
        acceptedAt - comparisonAt > 3_600_000 ||
        categoryMapping?.marketCategoryId !== "10015" ||
        categoryMapping?.publishCategoryId !== "10015007" ||
        categoryMapping?.rule !==
          "copy-paper-parent-to-leaf/barcode-and-full-signature-v1"
      )
        throw new PipelineError(
          "NEEDS_INPUT",
          "父类目竞品缺少可复核的复印纸叶类目映射证明",
        );
      publishCategoryId = "10015007";
    }
    const category: any = this.store.db
      .prepare("SELECT path FROM catalog_categories WHERE shop=? AND id=?")
      .get(row.shop, publishCategoryId);
    if (!category)
      throw new PipelineError("NEEDS_INPUT", "详情类目ID尚未同步到店铺目录");
    const payload = {
      detailReceiptId: input.detailReceiptId,
      marketItemId: row.marketItemId,
      marketShopId: row.marketShopId,
      marketSkuId: row.marketSkuId,
      targetSku: input.sourceSku,
      source: "independent-jd-search-and-full-product-comparison",
      candidateReceiptId: input.receiptId,
      available: marketSku.available,
      price: marketSku.price,
      unit: marketSku.unit,
      brand: detail.brand,
      brandId: String(brandId),
      categoryId: publishCategoryId,
      categoryPath: String(category.path),
      marketCategoryId: String(categoryId),
      ...(categoryMapping ? { categoryMapping } : {}),
      checkedAt:
        categoryMapping && publishCategoryId === "10015007"
          ? String(observedComparison.checkedAt)
          : observedAt,
    };
    this.store.tx(() => {
      this.append(rowId, "source-match", observedAt, payload);
      this.store.db
        .prepare(
          "UPDATE opportunity_rows SET target_sku=?,status='PROPOSED',updated_at=? WHERE id=?",
        )
        .run(input.sourceSku, observedAt, rowId);
    });
    return payload;
  }

  verifySourceProduct(
    rowId: string,
    input: {
      sourceSku: string;
      detailReceiptId: string;
      checkedAt: string;
      fields: Array<{
        field: "brand" | "packaging" | "model";
        marketValue: string;
        sourceValue: string;
        marketEvidenceUrl: string;
        sourceEvidenceUrl: string;
      }>;
    },
    observedAt = new Date().toISOString(),
  ) {
    const row = this.row(rowId);
    if (!row.targetSku || input.sourceSku !== row.targetSku)
      throw new PipelineError("NEEDS_INPUT", "规格核验与已绑定京东SKU不一致");
    const source = this.latestEvidence(rowId, "source-match");
    if (
      !source ||
      source.payload.detailReceiptId !== input.detailReceiptId ||
      source.payload.targetSku !== input.sourceSku
    )
      throw new PipelineError(
        "NEEDS_INPUT",
        "规格核验必须绑定当前来源链接详情回执",
      );
    if (!Number.isFinite(Date.parse(input.checkedAt)))
      throw new PipelineError("NEEDS_INPUT", "规格核验时间无效");
    const fields = new Map(input.fields.map((field) => [field.field, field]));
    if (fields.size !== input.fields.length)
      throw new PipelineError("NEEDS_INPUT", "规格核验字段重复");
    for (const name of ["brand", "packaging", "model"] as const) {
      const field = fields.get(name);
      if (
        !field ||
        !field.marketValue.trim() ||
        field.marketValue.trim() !== field.sourceValue.trim()
      )
        throw new PipelineError(
          "NEEDS_INPUT",
          "品牌、销售包装和型号必须逐字段精确一致",
        );
      try {
        const marketUrl = new URL(field.marketEvidenceUrl);
        const sourceUrl = new URL(field.sourceEvidenceUrl);
        if (
          marketUrl.protocol !== "https:" ||
          marketUrl.hostname !== "b.csgmall.com.cn" ||
          marketUrl.pathname !== "/mall-view/product/detail" ||
          marketUrl.searchParams.get("itemId") !== row.marketItemId ||
          marketUrl.searchParams.get("skuId") !== row.marketSkuId ||
          sourceUrl.protocol !== "https:" ||
          sourceUrl.hostname !== "item.jd.com" ||
          sourceUrl.pathname !== `/${row.targetSku}.html`
        )
          throw new Error("identity mismatch");
      } catch {
        throw new PipelineError(
          "NEEDS_INPUT",
          "规格证据链接没有精确指向冻结的市场商品、销售SKU和京东SKU",
        );
      }
    }
    const hasObservations = this.store.db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='opportunity_source_observations'",
      )
      .get();
    const observation: any = hasObservations
      ? this.store.db
          .prepare(
            `SELECT product,comparison FROM opportunity_source_observations
             WHERE row_id=? AND detail_receipt_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1`,
          )
          .get(rowId, input.detailReceiptId)
      : null;
    let categoryMapping: any = null;
    let mappingProduct: any = null;
    let mappingComparison: any = null;
    try {
      mappingProduct = JSON.parse(String(observation?.product));
      mappingComparison = JSON.parse(String(observation?.comparison));
      categoryMapping = mappingComparison.categoryMapping;
    } catch {
      categoryMapping = null;
    }
    if (
      source.payload.categoryId === "10015" &&
      mappingProduct?.sku === input.sourceSku &&
      mappingComparison?.sourceSku === input.sourceSku &&
      mappingComparison?.detailReceiptId === input.detailReceiptId &&
      mappingComparison?.matched === true &&
      categoryMapping?.marketCategoryId === "10015" &&
      categoryMapping?.publishCategoryId === "10015007" &&
      categoryMapping?.rule ===
        "copy-paper-parent-to-leaf/barcode-and-full-signature-v1"
    ) {
      const category: any = this.store.db
        .prepare("SELECT path FROM catalog_categories WHERE shop=? AND id=?")
        .get(row.shop, "10015007");
      if (!category)
        throw new PipelineError(
          "NEEDS_INPUT",
          "复印纸发布叶类目尚未同步到店铺目录",
        );
      this.append(rowId, "source-match", observedAt, {
        ...source.payload,
        marketCategoryId: "10015",
        categoryId: "10015007",
        categoryPath: String(category.path),
        categoryMapping,
      });
    }
    return this.append(rowId, "source-product-verified", observedAt, {
      sourceSku: input.sourceSku,
      detailReceiptId: input.detailReceiptId,
      checkedAt: input.checkedAt,
      fields: [...fields.values()],
    });
  }

  rejectSourceProduct(
    rowId: string,
    detailReceiptId: string,
    reasons: string[],
    observedAt = new Date().toISOString(),
  ) {
    this.row(rowId);
    return this.append(rowId, "source-product-rejected", observedAt, {
      detailReceiptId,
      reasons,
    });
  }

  evaluateForPreparation(
    rowId: string,
    input: { now?: number; maxAgeMs?: number } = {},
  ) {
    const row = this.row(rowId);
    const now = input.now ?? Date.now();
    const maxAge = input.maxAgeMs ?? 3_600_000;
    const blockers: OpportunityBlocker[] = [];
    const source = this.latestEvidence(rowId, "source-match");
    if (!source)
      blockers.push({ code: "SOURCE_MATCH", message: "尚无精确来源链接证据" });
    else {
      const checked = Date.parse(String(source.payload.checkedAt));
      if (
        !Number.isFinite(checked) ||
        checked > now + 60_000 ||
        now - checked > maxAge
      )
        blockers.push({
          code: "STALE_EVIDENCE",
          message: "精确来源证据已过期",
        });
      if (!source.payload.available)
        blockers.push({
          code: "SOURCE_MATCH",
          message: "目标销售SKU当前不满足在售与库存条件",
        });
    }
    const productVerification = this.latestEvidence(
      rowId,
      "source-product-verified",
    );
    const latestComparison = this.store.db
      .prepare(
        "SELECT kind FROM opportunity_evidence WHERE row_id=? AND kind IN ('source-product-verified','source-product-rejected') ORDER BY observed_at DESC,rowid DESC LIMIT 1",
      )
      .get(rowId);
    if (latestComparison?.kind === "source-product-rejected")
      blockers.push({
        code: "SOURCE_MATCH",
        message: "最新京东规格核对未通过，历史匹配不能继续复用",
      });
    if (!productVerification) {
      blockers.push({
        code: "SOURCE_MATCH",
        message: "仍需采集京东规格并逐字段核对销售包装与型号",
      });
    } else {
      const checked = Date.parse(String(productVerification.payload.checkedAt));
      if (
        !Number.isFinite(checked) ||
        checked > now + 60_000 ||
        now - checked > maxAge
      )
        blockers.push({
          code: "STALE_EVIDENCE",
          message: "销售包装与型号核验证据已过期",
        });
      if (
        !source ||
        productVerification.payload.detailReceiptId !==
          source.payload.detailReceiptId
      )
        blockers.push({
          code: "SOURCE_MATCH",
          message: "来源详情已经变化，需重新核验品牌、包装与型号",
        });
    }
    const operationalReadiness = this.readiness.evaluate(
      {
        shop: row.shop,
        brand: source
          ? {
              id: String(source.payload.brandId),
              name: String(source.payload.brand),
            }
          : null,
        category: source
          ? {
              id: String(source.payload.categoryId),
              path: String(source.payload.categoryPath),
            }
          : null,
        sourceSku: row.targetSku,
      },
      { now },
    );
    if (source && operationalReadiness.authorization.status !== "authorized")
      blockers.push({
        code: "AUTHORIZATION",
        message: operationalReadiness.authorization.reason,
      });
    if (this.store.meta("listing-price:" + row.shop) !== "jd-regular-preferred")
      blockers.push({
        code: "PRICING",
        message: "上架定价策略必须是京东日常价优先、缺失时才使用补贴价",
      });
    if (operationalReadiness.sourceDuplicate.status === "duplicate")
      blockers.push({
        code: "DUPLICATE",
        message: `来源索引已有${operationalReadiness.sourceDuplicate.matches.length}条目标SKU`,
      });
    else if (operationalReadiness.sourceDuplicate.status === "needs-input")
      blockers.push({
        code: "DUPLICATE",
        message: row.targetSku
          ? operationalReadiness.sourceDuplicate.reason
          : "尚未绑定唯一京东SKU",
      });
    const status = blockers.length ? "BLOCKED" : "READY_FOR_PREPARATION";
    this.store.tx(() => {
      this.append(rowId, "readiness", new Date(now).toISOString(), {
        status,
        blockers,
        operationalReadiness,
      });
      this.store.db
        .prepare(
          `UPDATE opportunity_rows SET status=?,blockers=?,updated_at=?
           WHERE id=? AND status IN ('IMPORTED','PROPOSED','BLOCKED','READY_FOR_PREPARATION')`,
        )
        .run(
          status,
          JSON.stringify(blockers),
          new Date(now).toISOString(),
          rowId,
        );
    });
    return { status, blockers };
  }

  associateJob(
    rowId: string,
    jobId: string,
    observedAt = new Date().toISOString(),
  ) {
    const row = this.row(rowId);
    if (!row.targetSku)
      throw new PipelineError("NEEDS_INPUT", "机会行尚未绑定唯一京东SKU");
    const job: any = this.store.db
      .prepare("SELECT id,shop,sku FROM jobs WHERE id=?")
      .get(jobId);
    if (!job || job.shop !== row.shop || job.sku !== row.targetSku)
      throw new PipelineError("NEEDS_INPUT", "任务与冻结机会的店铺或SKU不一致");
    if (row.jobId && row.jobId !== jobId)
      throw new PipelineError(
        "NEEDS_INPUT",
        "机会行已绑定另一个任务，不能静默替换",
      );
    this.store.tx(() => {
      this.store.db
        .prepare(
          `UPDATE opportunity_rows SET job_id=?,
           status=CASE WHEN status='RESULT' THEN status ELSE 'QUEUED' END,
           updated_at=? WHERE id=?`,
        )
        .run(jobId, observedAt, rowId);
      this.append(rowId, "job-associated", observedAt, {
        jobId,
        shop: row.shop,
        sku: row.targetSku,
      });
    });
    return this.row(rowId);
  }

  recordResult(
    rowId: string,
    state:
      "SUBMITTED" | "APPROVED" | "ON_SALE" | "REJECTED" | "UNKNOWN_OUTCOME",
    evidence: { remoteId: string } & Record<string, unknown>,
    observedAt = new Date().toISOString(),
  ) {
    const row = this.row(rowId);
    if (!row.targetSku)
      throw new PipelineError("NEEDS_INPUT", "机会行尚未绑定唯一京东SKU");
    if (!row.jobId)
      throw new PipelineError("NEEDS_INPUT", "机会行尚未关联任务");
    const job: any = this.store.db
      .prepare("SELECT id,shop,sku FROM jobs WHERE id=?")
      .get(row.jobId);
    if (!job || job.shop !== row.shop || job.sku !== row.targetSku)
      throw new PipelineError("NEEDS_INPUT", "关联任务身份已经失配");
    const latest = this.latestEvidence(rowId, "result");
    if (latest && Date.parse(observedAt) < Date.parse(latest.observedAt))
      throw new PipelineError(
        "NEEDS_INPUT",
        "结果观察早于已记录证据，不能覆盖较新状态",
      );
    if (!evidence.remoteId.trim())
      throw new PipelineError("NEEDS_INPUT", "结果观察缺少远端商品身份");
    if (
      latest &&
      latest.payload.remoteId !== undefined &&
      latest.payload.remoteId !== evidence.remoteId
    )
      throw new PipelineError("NEEDS_INPUT", "结果观察的远端商品身份发生变化");
    this.store.tx(() => {
      this.append(rowId, "result", observedAt, {
        ...evidence,
        state,
        jobId: row.jobId,
      });
      this.store.db
        .prepare(
          "UPDATE opportunity_rows SET status='RESULT',result_state=?,updated_at=? WHERE id=?",
        )
        .run(state, observedAt, rowId);
    });
    return this.row(rowId);
  }

  async reconcile<T extends Record<string, unknown>>(
    rowId: string,
    readOnly: (
      identity: Readonly<{
        shop: string;
        targetSku: string;
        jobId: string | null;
      }>,
    ) => T | Promise<T>,
    observedAt = new Date().toISOString(),
  ) {
    const row = this.row(rowId);
    if (!row.targetSku)
      throw new PipelineError("NEEDS_INPUT", "机会行尚未绑定唯一京东SKU");
    const observation = await readOnly(
      Object.freeze({
        shop: row.shop,
        targetSku: row.targetSku,
        jobId: row.jobId,
      }),
    );
    this.append(rowId, "reconciliation", observedAt, observation);
    return observation;
  }

  evidence(rowId: string) {
    this.row(rowId);
    return this.store.db
      .prepare(
        "SELECT * FROM opportunity_evidence WHERE row_id=? ORDER BY observed_at,rowid",
      )
      .all(rowId)
      .map((entry: any) => ({
        id: String(entry.id),
        kind: String(entry.kind),
        observedAt: String(entry.observed_at),
        payload: JSON.parse(String(entry.payload)),
      }));
  }

  private append(
    rowId: string,
    kind: EvidenceKind,
    observedAt: string,
    payload: Record<string, unknown>,
  ) {
    if (!Number.isFinite(Date.parse(observedAt)))
      throw new PipelineError("NEEDS_INPUT", "证据时间无效");
    this.row(rowId);
    const evidenceId = digest({ rowId, kind, observedAt, payload });
    this.store.db
      .prepare("INSERT OR IGNORE INTO opportunity_evidence VALUES(?,?,?,?,?)")
      .run(evidenceId, rowId, kind, observedAt, JSON.stringify(payload));
    return evidenceId;
  }

  private latestEvidence(rowId: string, kind: EvidenceKind) {
    const row: any = this.store.db
      .prepare(
        "SELECT * FROM opportunity_evidence WHERE row_id=? AND kind=? ORDER BY observed_at DESC,rowid DESC LIMIT 1",
      )
      .get(rowId, kind);
    return row
      ? {
          observedAt: String(row.observed_at),
          payload: JSON.parse(String(row.payload)) as Record<string, unknown>,
        }
      : null;
  }

  private decode(row: any) {
    return {
      id: String(row.id),
      cohortKey: String(row.cohort_key),
      shop: String(row.shop),
      sourceReportId: String(row.source_report_id),
      importedAt: String(row.imported_at),
      ordinal: Number(row.ordinal),
      opportunityId: String(row.opportunity_id),
      marketItemId: String(row.market_item_id),
      marketShopId: String(row.market_shop_id),
      marketSkuId: String(row.market_sku_id),
      rank: Number(row.rank),
      targetSku: row.target_sku === null ? null : String(row.target_sku),
      status: String(row.status),
      blockers: JSON.parse(String(row.blockers)) as OpportunityBlocker[],
      jobId: row.job_id === null ? null : String(row.job_id),
      resultState: row.result_state === null ? null : String(row.result_state),
      updatedAt: String(row.updated_at),
    };
  }

  private message(error: unknown) {
    return error instanceof Error ? error.message : String(error);
  }
}
