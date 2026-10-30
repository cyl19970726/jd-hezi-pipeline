import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import { OpportunityExecution } from "./opportunity-execution.js";
import { Jobs } from "./jobs.js";
import { Store } from "./store.js";
import type { BrowserConfig } from "./browser/runtime.js";
import { remoteProductState } from "./remote-status.js";
import { OpportunitySources } from "./opportunity-source.js";
import { SourceReuse, sourceContext } from "./source-reuse.js";
import { collectionNeed, mergeFreshPrice } from "./collection-needs.js";
import { digest, productSchema } from "./model.js";
import { planSourceCandidateSearch } from "./opportunity-source-match.js";

/** Operational coordinator; analytics remains a read-only consumer of publishing facts. */
export class OpportunityService {
  readonly ledger: OpportunityExecution;
  readonly sources: OpportunitySources;
  constructor(
    readonly store: Store,
    readonly jobs: Jobs,
    readonly root: string,
    readonly shop: string,
  ) {
    this.ledger = new OpportunityExecution(store);
    this.sources = new OpportunitySources(store, this.ledger);
  }

  async initialize() {
    try {
      const manifest = JSON.parse(
        await readFile(
          resolve(this.root, "opportunity-execution.json"),
          "utf8",
        ),
      );
      if (manifest.shop !== this.shop)
        throw Error("机会清单店铺与当前工作台不一致");
      this.ledger.importCohort(manifest);
    } catch (error: any) {
      if (error.code !== "ENOENT") throw error;
    }
  }

  read(cohortId?: string) {
    const cohorts = this.store.db
      .prepare(
        "SELECT * FROM opportunity_cohorts WHERE shop=? ORDER BY imported_at DESC",
      )
      .all(this.shop)
      .map((c: any) => {
        const payload = JSON.parse(c.payload);
        return {
          id: String(c.cohort_key),
          label: `优先候选 · ${String(c.imported_at).slice(0, 10)}`,
          total: payload.rows.length,
          payload,
        };
      });
    const rows = cohorts
      .filter((c) => !cohortId || c.id === cohortId)
      .flatMap((c) => {
        const metadata = new Map(
          c.payload.rows.map((r: any) => [r.opportunityId, r]),
        );
        return this.ledger.rows(c.id).map((r) => {
          const original: any = metadata.get(r.opportunityId) ?? {};
          const job = r.jobId ? this.jobs.get(r.jobId) : null;
          const product = job?.productId ? this.store.get(job.productId) : null;
          // Only the business store may establish these states; DONE alone is not on-sale.
          let outcome = product?.state;
          let outcomeObservedAt: string | null = product
            ? String(
                this.store.db
                  .prepare("SELECT updated_at FROM products WHERE id=?")
                  .get(product.id)?.updated_at ?? job?.updatedAt,
              )
            : null;
          const audit = product ? this.store.meta("audit:" + product.id) : null;
          if (
            product?.remoteId &&
            audit?.observation?.itemId === product.remoteId &&
            typeof audit.observation.status === "string" &&
            Date.parse(audit.checkedAt) >= Date.parse(job!.updatedAt) &&
            Date.parse(audit.checkedAt) <= Date.now() + 60000
          ) {
            outcome = remoteProductState(audit.observation.status) ?? outcome;
            outcomeObservedAt = audit.checkedAt;
          }
          const detail = this.store.meta("opportunity-detail:" + r.id);
          const source = this.store.meta("opportunity-source:" + r.id);
          const sourceCandidates =
            this.ledger
              .evidence(r.id)
              .filter((entry) => entry.kind === "source-candidate-search")
              .at(-1)?.payload ?? null;
          let existing: any = null;
          if (!job && r.targetSku) {
            try {
              const matches = this.ledger.sources.lookup(
                this.shop,
                r.targetSku,
              );
              if (matches.length === 1) existing = matches[0];
            } catch {
              /* An incomplete index cannot establish absence or a current match. */
            }
          }
          const status =
            outcome === "ON_SALE"
              ? "ON_SALE"
              : outcome === "APPROVED"
                ? "APPROVED"
                : outcome === "SUBMITTED"
                  ? "SUBMITTED"
                  : outcome === "REJECTED"
                    ? "REJECTED"
                    : job?.status === "UNKNOWN_OUTCOME"
                      ? "UNKNOWN_OUTCOME"
                      : job?.status === "NEEDS_INPUT"
                        ? "BLOCKED"
                        : job?.status === "CANCELLED"
                          ? "CANCELLED"
                          : job
                            ? "QUEUED"
                            : existing
                              ? "EXISTING"
                              : detail?.issue || source?.blockers?.length
                                ? "BLOCKED"
                                : r.status === "READY_FOR_PREPARATION"
                                  ? "READY"
                                  : r.status;
          return {
            ...r,
            cohortId: c.id,
            title: original.title ?? r.marketSkuId,
            brand: original.brand ?? "",
            marketUrl: `https://b.csgmall.com.cn/mall-view/product/detail?itemId=${encodeURIComponent(r.marketItemId)}&skuId=${encodeURIComponent(r.marketSkuId)}`,
            status,
            blockers: job?.error
              ? [job.error]
              : existing
                ? ["已有相同京东来源SKU，复用原商品；不重复新建"]
                : detail?.issue
                  ? [detail.issue]
                  : source?.blockers?.length
                    ? source.blockers
                    : r.blockers.map((b) => b.message),
            remoteId: product?.remoteId ?? existing?.itemId ?? null,
            jobStage: job?.stage ?? null,
            outcomeObservedAt,
            sourceReuseMode: source?.collectionMode ?? null,
            detailReceiptId: detail?.receiptId ?? null,
            sourceObservationId: source?.id ?? null,
            sourceCandidates,
          };
        });
      });
    return {
      cohorts: cohorts.map(({ payload, ...c }) => c),
      rows,
      summary: {
        total: rows.length,
        matched: rows.filter((r) => r.targetSku).length,
        ready: rows.filter((r) => r.status === "READY").length,
        submitted: rows.filter((r) => r.status === "SUBMITTED").length,
        existing: rows.filter((r) => r.status === "EXISTING").length,
        blocked: rows.filter((r) => r.status === "BLOCKED").length,
        onSale: rows.filter((r) => r.status === "ON_SALE").length,
      },
      browser: this.store.meta("opportunity-browser:" + this.shop) ?? {
        status: "unavailable",
        message: "尚未核验本任务的实时浏览器连接",
      },
    };
  }

  async hydrate(
    input: unknown,
    config: BrowserConfig,
    bridge: { call(action: string, args: unknown): Promise<any> },
  ) {
    const { cohortId, limit, rowIds } = z
      .object({
        cohortId: z.string().min(1),
        limit: z.number().int().min(1).max(3).default(3),
        rowIds: z.array(z.string().min(1)).min(1).max(3).optional(),
      })
      .parse(input);
    const rows = this.ledger.rows(cohortId);
    if (!rows.length || rows.some((r) => r.shop !== this.shop))
      throw Error("本店机会批次不存在");
    const state = this.store.meta("opportunity-browser:" + this.shop);
    if (state?.status === "user_control")
      throw Error("浏览器由用户控制，等待明确交回后继续");
    if (
      rowIds &&
      (new Set(rowIds).size !== rowIds.length ||
        rowIds.some((id) => !rows.some((r) => r.id === id && !r.jobId)))
    )
      throw Error("刷新目标必须是本批次尚未进入上架任务的唯一机会行");
    const pending = rows
      .filter(
        (r) =>
          !r.jobId &&
          (rowIds
            ? rowIds.includes(r.id)
            : !this.store.meta("opportunity-detail:" + r.id)),
      )
      .slice(0, limit);
    if (!pending.length) return { received: 0, remaining: 0 };
    const session = z
      .object({
        spaceId: z.number().int().positive(),
        hzPage: z.string().min(1),
        jdPage: z.string().min(1),
        profileId: z.string().min(1),
      })
      .parse(
        JSON.parse(
          await readFile(
            resolve(this.root, "opportunity-session.json"),
            "utf8",
          ),
        ),
      );
    try {
      const result = await bridge.call("opportunity-details", {
        config: { ...config, session },
        database: resolve(this.root, "state.sqlite"),
        opportunities: pending.map((r) => ({
          opportunityId: r.opportunityId,
          itemId: r.marketItemId,
          skuId: r.marketSkuId,
          marketShopId: r.marketShopId,
        })),
        limit,
      });
      for (const receipt of result.receipts) {
        const row = pending.find(
          (r) => r.opportunityId === receipt.opportunityId,
        );
        if (
          !row ||
          receipt.itemId !== row.marketItemId ||
          receipt.skuId !== row.marketSkuId ||
          receipt.marketShopId !== row.marketShopId
        )
          throw Error("采集回执未对应本轮冻结身份");
        const facts = receipt.verified.itemPublishVo;
        let issue: string | null = null;
        try {
          if (!facts.brandId || !facts.cid || !receipt.verified.sku.unit)
            throw Error("详情缺少品牌ID、发布类目或销售单位");
          this.ledger.acceptExactSource(row.id, {
            detailReceiptId: receipt.receiptId,
            brandId: facts.brandId,
            categoryId: facts.cid,
            unit: receipt.verified.sku.unit,
          });
          this.ledger.evaluateForPreparation(row.id);
        } catch (error: any) {
          issue = error.message;
        }
        this.store.setMeta("opportunity-detail:" + row.id, {
          receiptId: receipt.receiptId,
          checkedAt: receipt.verified.checkedAt,
          issue,
        });
      }
      this.store.setMeta("opportunity-browser:" + this.shop, {
        status: "ready",
        message: "商城详情连接已核验",
        checkedAt: new Date().toISOString(),
      });
      return {
        received: result.receipts.length,
        remaining: rows.filter(
          (r) => !r.jobId && !this.store.meta("opportunity-detail:" + r.id),
        ).length,
      };
    } catch (error: any) {
      this.store.setMeta("opportunity-browser:" + this.shop, {
        status:
          error.code === "CONTROL_REQUIRED" ? "user_control" : "unavailable",
        message: error.message,
        checkedAt: new Date().toISOString(),
      });
      throw error;
    }
  }

  prepare(input: unknown) {
    const { rowIds } = z
      .object({ rowIds: z.array(z.string().min(1)).min(1).max(50) })
      .parse(input);
    if (new Set(rowIds).size !== rowIds.length) throw Error("重复机会行");
    this.store.assertRunning(this.shop);
    return this.store.tx(() => {
      const items = rowIds.map((rowId) => {
        const row = this.ledger.row(rowId);
        if (row.shop !== this.shop) throw Error("机会不属于本店");
        if (row.jobId) return { rowId, jobId: row.jobId, reused: true };
        const verified = this.sources.assertPrepared(rowId);
        const readiness = this.ledger.evaluateForPreparation(rowId);
        if (readiness.status !== "READY_FOR_PREPARATION")
          throw Error(readiness.blockers.map((b) => b.message).join("；"));
        const evidence = this.ledger
          .evidence(rowId)
          .filter((e) => e.kind === "source-match")
          .at(-1)?.payload;
        if (!evidence || !row.targetSku) throw Error("缺少来源及发布规则证据");
        const policies = this.store.db
          .prepare("SELECT id FROM shop_policies WHERE shop=?")
          .all(this.shop);
        if (policies.length !== 1) throw Error("需要明确适用的店铺发布政策");
        new SourceReuse(this.store).adopt(this.shop, verified.product);
        const result = this.jobs.enqueue(
          [`https://item.jd.com/${row.targetSku}.html`],
          {
            brandId: String(evidence.brandId),
            categoryId: String(evidence.categoryId),
            policyId: String(policies[0].id),
            unit: String(evidence.unit),
            through: "submit",
          },
          { runId: row.cohortKey, brandId: String(evidence.brandId) },
        );
        const jobId = result.items[0].id;
        this.ledger.associateJob(rowId, jobId);
        return { rowId, jobId, reused: result.items[0].reused };
      });
      return { items };
    });
  }

  /** Replay saved receipts after catalog/spec evidence is repaired; no network or publishing writes. */
  recheck(input: unknown) {
    const { cohortId } = z.object({ cohortId: z.string().min(1) }).parse(input);
    const rows = this.ledger.rows(cohortId);
    if (!rows.length || rows.some((r) => r.shop !== this.shop))
      throw Error("本店机会批次不存在");
    let checked = 0;
    for (const row of rows.filter((r) => !r.jobId)) {
      const saved = this.store.meta("opportunity-detail:" + row.id);
      if (!saved?.receiptId) continue;
      let issue: string | null = null;
      try {
        const record = this.store.db
          .prepare(
            "SELECT payload FROM market_details WHERE id=? AND shop=? AND item_id=?",
          )
          .get(saved.receiptId, this.shop, row.marketItemId);
        if (!record) throw Error("机会详情回执缺失或身份不符");
        const raw = JSON.parse(String(record.payload));
        const detail = this.ledger.details.get(saved.receiptId);
        const sku = detail.skus.find((s) => s.id === row.marketSkuId);
        const facts = raw.data.itemPublishVo;
        if (!facts.brandId || !facts.cid || !sku?.unit)
          throw Error("详情缺少品牌ID、发布类目或销售单位");
        const currentSource = this.ledger
          .evidence(row.id)
          .filter((entry) => entry.kind === "source-match")
          .at(-1)?.payload;
        if (!currentSource?.candidateReceiptId)
          this.ledger.acceptExactSource(row.id, {
            detailReceiptId: saved.receiptId,
            brandId: String(facts.brandId),
            categoryId: String(facts.cid),
            unit: sku.unit,
          });
        this.ledger.evaluateForPreparation(row.id);
        if (this.sources.latest(row.id)) this.sources.recheck(row.id);
      } catch (error: any) {
        issue = error.message;
      }
      this.store.setMeta("opportunity-detail:" + row.id, {
        ...saved,
        issue,
        recheckedAt: new Date().toISOString(),
      });
      checked++;
    }
    return { checked };
  }

  /** Read one selected JD SKU through the existing paced collector, then compare locally. */
  async discoverCandidates(
    input: unknown,
    config: BrowserConfig,
    bridge: { call(action: string, args: unknown): Promise<any> },
  ) {
    const { cohortId, rowId } = z
      .object({ cohortId: z.string().min(1), rowId: z.string().min(1) })
      .parse(input);
    const row = this.ledger.rows(cohortId).find((entry) => entry.id === rowId);
    if (!row || row.shop !== this.shop) throw Error("机会不属于本店批次");
    if (
      this.store.meta("opportunity-browser:" + this.shop)?.status ===
      "user_control"
    )
      throw Error("浏览器由用户控制，等待明确交回后继续");
    if (row.targetSku || row.jobId)
      throw Error("机会已有精确来源或已进入上架任务");
    const detailReceiptId = this.store.meta(
      "opportunity-detail:" + row.id,
    )?.receiptId;
    const saved: any = detailReceiptId
      ? this.store.db
          .prepare(
            "SELECT payload,checked_at FROM market_details WHERE id=? AND shop=? AND item_id=?",
          )
          .get(detailReceiptId, this.shop, row.marketItemId)
      : null;
    if (!saved) throw Error("缺少可用于候选检索的竞品详情回执");
    const marketPayload = JSON.parse(String(saved.payload));
    const selectedSkus = (
      Array.isArray(marketPayload?.data?.itemSkuInfoList)
        ? marketPayload.data.itemSkuInfoList
        : []
    ).filter((sku: any) => String(sku?.id) === row.marketSkuId);
    if (selectedSkus.length !== 1)
      throw Error("竞品详情没有唯一的目标销售SKU，不能读取来源候选");
    const rawLinks = selectedSkus[0]?.skuPicUrls;
    if (rawLinks !== undefined && rawLinks !== null && !Array.isArray(rawLinks))
      throw Error("目标销售SKU的京东来源链接格式不受支持");
    if (Array.isArray(rawLinks) && rawLinks.length) {
      const candidates = new Map<
        string,
        { sku: string; url: string; title: string }
      >();
      for (const entry of rawLinks) {
        const rawUrl = typeof entry?.url === "string" ? entry.url.trim() : "";
        let url: URL;
        try {
          url = new URL(rawUrl);
        } catch {
          throw Error("目标销售SKU含无效京东来源链接，不能降级为关键词搜索");
        }
        const match = url.pathname.match(/^\/(\d+)\.html$/u);
        const observedMarketTracking =
          [...url.searchParams].length === 1 &&
          url.searchParams.get("from") === "market";
        if (
          url.protocol !== "https:" ||
          url.hostname !== "item.jd.com" ||
          !!url.username ||
          !!url.password ||
          (!!url.search && !observedMarketTracking) ||
          !!url.hash ||
          !match
        )
          throw Error(
            "目标销售SKU含不支持的京东来源链接，不能降级为关键词搜索",
          );
        candidates.set(match[1], {
          sku: match[1],
          url: `https://item.jd.com/${match[1]}.html`,
          title: `详情已记录来源 SKU ${match[1]}`,
        });
      }
      if (candidates.size > 10)
        throw Error("目标销售SKU记录超过十个京东来源链接，需人工核对");
      const result = {
        discoveryMode: "existing-links" as const,
        query: `竞品详情已记录的京东来源 ${row.marketItemId}`,
        checkedAt: String(saved.checked_at),
        candidates: [...candidates.values()],
      };
      const receiptId = digest({ rowId, detailReceiptId, result });
      this.ledger.recordSourceCandidateSearch(rowId, { receiptId, ...result });
      return { rowId, receiptId, plan: null, ...result };
    }
    const plan = planSourceCandidateSearch({
      lane: "exact",
      marketPayload,
      marketSkuId: row.marketSkuId,
    });
    if (plan.blockers.length || plan.queries.length !== 1)
      throw Error(
        plan.blockers.join("；") || "精确来源检索词不唯一，需人工核对品牌别名",
      );
    const session = z
      .object({
        spaceId: z.number().int().positive(),
        hzPage: z.string().min(1),
        jdPage: z.string().min(1),
        profileId: z.string().min(1),
      })
      .parse(
        JSON.parse(
          await readFile(
            resolve(this.root, "opportunity-session.json"),
            "utf8",
          ),
        ),
      );
    let result;
    try {
      result = z
        .object({
          query: z.string().min(1),
          checkedAt: z.string().datetime(),
          candidates: z
            .array(
              z.object({
                sku: z.string().regex(/^\d+$/),
                url: z.string().url(),
                title: z.string().min(1),
              }),
            )
            .max(10),
        })
        .parse(
          await bridge.call("search-source-candidates", {
            config: { ...config, session },
            database: resolve(this.root, "state.sqlite"),
            query: plan.queries[0],
            limit: 10,
          }),
        );
    } catch (error: any) {
      this.store.setMeta("opportunity-browser:" + this.shop, {
        status:
          error.code === "CONTROL_REQUIRED" ? "user_control" : "unavailable",
        message: error.message,
        checkedAt: new Date().toISOString(),
      });
      throw error;
    }
    if (result.query !== plan.queries[0])
      throw Error("来源候选回执检索词与服务端计划不一致");
    const receiptId = digest({ rowId, plan, result });
    this.ledger.recordSourceCandidateSearch(rowId, {
      receiptId,
      discoveryMode: "search",
      ...result,
    });
    return {
      rowId,
      receiptId,
      plan,
      discoveryMode: "search" as const,
      ...result,
    };
  }

  async collectCandidate(
    input: unknown,
    config: BrowserConfig,
    bridge: { call(action: string, args: unknown): Promise<any> },
  ) {
    const parsed = z
      .object({
        cohortId: z.string().min(1),
        rowId: z.string().min(1),
        receiptId: z.string().min(1),
        sku: z.string().regex(/^\d+$/),
      })
      .parse(input);
    const row = this.ledger
      .rows(parsed.cohortId)
      .find((entry) => entry.id === parsed.rowId);
    if (!row || row.shop !== this.shop) throw Error("机会不属于本店批次");
    if (row.targetSku || row.jobId)
      throw Error("机会已有精确来源或已进入上架任务");
    if (
      this.store.meta("opportunity-browser:" + this.shop)?.status ===
      "user_control"
    )
      throw Error("浏览器由用户控制，等待明确交回后继续");
    this.ledger.selectSourceCandidate(row.id, parsed);
    const session = z
      .object({
        spaceId: z.number().int().positive(),
        hzPage: z.string().min(1),
        jdPage: z.string().min(1),
        profileId: z.string().min(1),
      })
      .parse(
        JSON.parse(
          await readFile(
            resolve(this.root, "opportunity-session.json"),
            "utf8",
          ),
        ),
      );
    const unlock = this.store.lock("publisher");
    try {
      this.store.assertScopes(
        "all",
        this.shop,
        "jd-account:" + this.shop,
        "jd:" + this.shop,
      );
      const product = productSchema.parse(
        await bridge.call("collect", {
          config: { ...config, session },
          url: `https://item.jd.com/${parsed.sku}.html`,
        }),
      );
      const observed = this.store.tx(() => {
        const result = this.sources.recordCandidate(row.id, product);
        new SourceReuse(this.store).remember(
          sourceContext(this.store, this.shop, parsed.sku),
          product,
        );
        return result;
      });
      this.store.setMeta("opportunity-browser:" + this.shop, {
        status: "ready",
        message: "京东候选已完整读取并核对，未执行商品发布",
        checkedAt: new Date().toISOString(),
      });
      return {
        rowId: row.id,
        sku: parsed.sku,
        matched: observed.comparison.matched,
        blockers: [
          ...observed.comparison.blockers,
          ...(observed.priceIssue ? [observed.priceIssue] : []),
        ],
        observationId: observed.id,
      };
    } catch (error: any) {
      this.store.setMeta("opportunity-browser:" + this.shop, {
        status:
          error.code === "CONTROL_REQUIRED" ? "user_control" : "unavailable",
        message: error.message,
        checkedAt: new Date().toISOString(),
      });
      throw error;
    } finally {
      unlock();
    }
  }

  /** Read one selected JD SKU through the existing paced collector, then compare locally. */
  async collectSource(
    input: unknown,
    config: BrowserConfig,
    bridge: { call(action: string, args: unknown): Promise<any> },
  ) {
    const { cohortId, rowId } = z
      .object({
        cohortId: z.string().min(1),
        rowId: z.string().min(1).optional(),
      })
      .parse(input);
    if (
      this.store.meta("opportunity-browser:" + this.shop)?.status ===
      "user_control"
    )
      throw Error("浏览器由用户控制，等待明确交回后继续");
    const rows = this.ledger.rows(cohortId);
    if (!rows.length || rows.some((r) => r.shop !== this.shop))
      throw Error("本店机会批次不存在");
    const row = rowId
      ? rows.find((r) => r.id === rowId)
      : rows.find((r) => r.targetSku && !r.jobId && !this.sources.latest(r.id));
    if (rowId && !row) throw Error("机会不属于本店批次");
    if (!row)
      return { received: 0, message: "没有尚待读取且已有京东来源链接的商品。" };
    if (!row.targetSku || row.jobId)
      throw Error("机会缺少来源链接或已进入上架任务");
    const session = z
      .object({
        spaceId: z.number().int().positive(),
        hzPage: z.string().min(1),
        jdPage: z.string().min(1),
        profileId: z.string().min(1),
      })
      .parse(
        JSON.parse(
          await readFile(
            resolve(this.root, "opportunity-session.json"),
            "utf8",
          ),
        ),
      );
    const unlock = this.store.lock("publisher");
    let raw: unknown;
    let collectionMode: "cache" | "price" | "full" = "full";
    try {
      this.store.assertScopes(
        "all",
        this.shop,
        "jd-account:" + this.shop,
        "jd:" + this.shop,
      );
      const reuse = new SourceReuse(this.store);
      const context = sourceContext(this.store, this.shop, row.targetSku);
      const cached = reuse.captures.facts(context);
      const collectionNow = Date.now();
      const comparisonFactsFresh = cached
        ? [
            cached.capturedAt,
            cached.title.capturedAt,
            ...Object.values(cached.specs).map((fact) => fact.capturedAt),
          ].every((capturedAt) => {
            const at = Date.parse(capturedAt);
            return (
              Number.isFinite(at) &&
              at <= collectionNow + 60_000 &&
              collectionNow - at <= 3_600_000
            );
          })
        : false;
      const ordinaryNeed = collectionNeed(cached, "browser", collectionNow, {
        previouslyObserved: !!cached,
      });
      const need = cached && !comparisonFactsFresh ? "full" : ordinaryNeed;
      const priceReusable =
        cached?.price && reuse.captures.price(context, {}, cached.price);
      if (cached && need !== "full" && priceReusable) {
        collectionMode = "cache";
        raw = cached;
        reuse.captures.metric(context, {
          stage: "opportunity",
          reason: "shared-source-cache",
          cacheHits: 1,
        });
      } else if (cached && need !== "full") {
        collectionMode = "price";
        const quote = productSchema.parse(
          await bridge.call("refresh-price", {
            config: { ...config, session },
            url: cached.url,
          }),
        );
        raw = mergeFreshPrice(cached, quote);
      } else {
        raw = await bridge.call("collect", {
          config: { ...config, session },
          url: `https://item.jd.com/${row.targetSku}.html`,
        });
      }
      const product = productSchema.parse(raw);
      const observed = this.store.tx(() => {
        const result = this.sources.record(row.id, product);
        // Immutable comparison and the reusable original collector checkpoint commit together.
        // Cache-only reuse must not relabel an old quote with today's account/region.
        if (raw !== cached) reuse.remember(context, product);
        this.store.setMeta("opportunity-source:" + row.id, {
          ...this.store.meta("opportunity-source:" + row.id),
          collectionMode,
        });
        return result;
      });
      this.store.setMeta("opportunity-browser:" + this.shop, {
        status: "ready",
        message: "京东规格已由采集脚本读取，未执行商品发布",
        checkedAt: new Date().toISOString(),
      });
      return {
        received: 1,
        rowId: row.id,
        matched: observed.comparison.matched,
        blockers: [
          ...observed.comparison.blockers,
          ...(observed.priceIssue ? [observed.priceIssue] : []),
        ],
        observationId: observed.id,
        collectionMode,
      };
    } catch (error: any) {
      this.store.setMeta("opportunity-browser:" + this.shop, {
        status:
          error.code === "CONTROL_REQUIRED" ? "user_control" : "unavailable",
        message: error.message,
        checkedAt: new Date().toISOString(),
      });
      throw error;
    } finally {
      unlock();
    }
  }
}
