import {
  AnalyticsCollection,
  CollectionAdapterError,
  type CollectionPageAdapter,
  type ExternalAdapterGuard,
} from "./collection.js";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { PACKAGE_ROOT } from "../release-version.js";
import { z } from "zod";
import { AnalyticsStore } from "./core.js";
import { AnalyticsOrders, type OrderSummaryQuery } from "./orders.js";
import { AnalyticsBusiness } from "./business.js";
import { importResearch } from "./research-import.js";
import type { Store } from "../store.js";
import type { MarketQuery, OpportunityQuery } from "./types.js";
import type { AnalyticsOpportunityHandoff } from "./opportunity-handoff.js";

const paginate = <T>(items: T[], p = 1, size = 50) => ({
  items: items.slice((p - 1) * size, p * size),
  total: items.length,
  page: p,
  pageSize: size,
  pages: Math.ceil(items.length / size),
});
const numberParam = (
  q: URLSearchParams,
  key: string,
  fallback: number,
  max: number,
) => {
  const n = Number(q.get(key) ?? fallback);
  if (!Number.isSafeInteger(n) || n < 1 || n > max) throw Error("分页参数无效");
  return n;
};
export class AnalyticsService {
  readonly store: AnalyticsStore;
  readonly orders: AnalyticsOrders;
  readonly business: AnalyticsBusiness;
  collection: AnalyticsCollection;
  handoff: AnalyticsOpportunityHandoff | null = null;
  importStatus: any = { available: false };
  settings: {
    targetCents: number | null;
    historicalContextCents: number | null;
  } = { targetCents: null, historicalContextCents: null };
  constructor(
    readonly root: string,
    readonly shop: string,
    db: Store,
    jobs: () => any[],
  ) {
    this.store = new AnalyticsStore(resolve(root, "analytics.sqlite"));
    this.orders = new AnalyticsOrders(this.store.db);
    this.business = new AnalyticsBusiness(db, shop, jobs);
    this.collection = new AnalyticsCollection(this.store, {
      readPage: async () => {
        throw new CollectionAdapterError("unavailable", "采集浏览器尚未连接");
      },
    });
  }
  async initialize() {
    try {
      this.settings = z
        .object({
          targetCents: z.number().int().nonnegative().nullable(),
          historicalContextCents: z.number().int().nonnegative().nullable(),
        })
        .parse(
          JSON.parse(
            readFileSync(resolve(this.root, "analytics-settings.json"), "utf8"),
          ),
        );
    } catch (e: any) {
      if (e.code !== "ENOENT") throw e;
    }

    this.importStatus = await importResearch(this.store, this.root);
    {
      for (let page = 1; page <= 5; page++) {
        const rows = this.store.listMarket({
          scope: "historical",
          sourceEntry: "hezi-shop-list-v1",
          page,
          pageSize: 200,
        });
        for (let i = 0; i < rows.items.length; i++) {
          const c = this.business.enrich(rows.items[i]);
          this.store.upsertOpportunity(c.id, {
            brand: c.brand,
            route: c.route as any,
            nextAction: c.nextAction,
            reason: "历史累计价值指数候选；周期未知，需核对具体来源与授权。",
            demandRank: (page - 1) * 200 + i + 1,
            authorizationStatus:
              c.authorizationStatus === "scope-needs-review"
                ? "needs-review"
                : (c.authorizationStatus as any),
            ownMatchStatus: c.ownMatchStatus as any,
          });
        }
      }
    }
    return this.importStatus;
  }
  connectCollector(
    adapter: CollectionPageAdapter,
    guard: ExternalAdapterGuard,
  ) {
    this.collection = new AnalyticsCollection(this.store, adapter, guard, {
      maxPagesPerTick: 1,
      leaseMs: 120000,
    });
  }
  connectOpportunityHandoff(handoff: AnalyticsOpportunityHandoff) {
    this.handoff = handoff;
  }
  close() {
    this.store.close();
  }
  private range(q: URLSearchParams): OrderSummaryQuery {
    const now = new Date(),
      year = now.getFullYear();
    const from = q.get("from") ?? `${year}-01-01T00:00:00+08:00`,
      to = q.get("to") ?? now.toISOString();
    const iso = (v: string, end = false) =>
      /^\d{4}-\d\d-\d\d$/.test(v)
        ? new Date(
            Date.parse(v + "T00:00:00+08:00") + (end ? 86400000 : 0),
          ).toISOString()
        : v;
    return {
      from: iso(from),
      to: iso(to, true),
      dateField: "placedAt",
      refundView: "event_period",
      timezone: "Asia/Shanghai",
      currency: "CNY",
    };
  }
  private marketQuery(q: URLSearchParams): MarketQuery {
    const scope = q.get("mode") === "historical" ? "historical" : "recent";
    const query: MarketQuery = {
      scope,
      page: numberParam(q, "page", 1, 100000),
      pageSize: numberParam(q, "pageSize", 50, 200),
      sourceEntry:
        scope === "historical" || q.get("source") === "tracked"
          ? "hezi-shop-list-v1"
          : "hezi-shop-list-cohort-v1",
    };
    for (const key of [
      "search",
      "brand",
      "shop",
      "category",
      "saleUnit",
    ] as const)
      if (q.get(key)) query[key] = q.get(key)!;
    if (scope === "recent") {
      const r = this.store.db
        .prepare(
          "SELECT MIN(observed_at) startAt,MAX(observed_at) endAt FROM analytics_observations WHERE source_entry=? AND (? IS NULL OR shop=?)",
        )
        .get(query.sourceEntry!, query.shop ?? null, query.shop ?? null);
      if (r?.startAt && r.endAt) {
        query.endAt = String(r.endAt);
        query.toleranceMs = 30 * 60 * 1000;
        const window = q.get("window") ?? "available";
        if (!["available", "7", "30", "60"].includes(window))
          throw Error("观察窗口无效");
        query.startAt =
          window === "available"
            ? String(r.startAt)
            : new Date(
                Date.parse(query.endAt) - Number(window) * 86400000,
              ).toISOString();
        query.coverage = "complete";
        query.status = z
          .enum(["comparable", "anomalous", "incomparable"])
          .parse(q.get("status") ?? "comparable");
      }
    }
    return query;
  }
  market(q: URLSearchParams) {
    const query = this.marketQuery(q),
      r = this.store.listMarket(query);
    return {
      ...r,
      items: r.items.map((c) => this.business.enrich(c)),
      mode: query.scope,
      windowLabel:
        query.scope === "historical"
          ? "累计展示销量，统计周期未知"
          : query.startAt && query.endAt
            ? `${query.startAt} — ${query.endAt}`
            : "缺少基线",
      from: query.startAt,
      to: query.endAt,
      metricLabel:
        query.scope === "recent"
          ? "展示增量价值指数（非成交额）"
          : "历史销售价值指数（非年销售额）",
      coverageNote: "研究样本，不代表平台全量；观察期间与采集覆盖见证据",
      reason:
        !r.available || !r.total
          ? "当前窗口没有完整可比基线，请选择最近有效窗口或历史候选"
          : undefined,
    };
  }
  opportunities(q: URLSearchParams) {
    const query: OpportunityQuery = {
      page: numberParam(q, "page", 1, 100000),
      pageSize: numberParam(q, "pageSize", 50, 200),
    };
    for (const key of ["search", "brand", "route", "status"] as const)
      if (q.get(key)) (query as any)[key] = q.get(key);
    const r = this.store.listOpportunities(query);
    const operational = this.handoff?.project(r.items.map((item) => item.id));
    return {
      ...r,
      items: r.items.map((o) => {
        const evidence = this.store.getEvidence(o.candidateId);
        return {
          ...(evidence ? this.business.enrich(evidence.candidate) : {}),
          ...o,
          ...(evidence
            ? (() => {
                const current = this.business.enrich(evidence.candidate);
                return {
                  authorizationStatus: current.authorizationStatus,
                  ownMatchStatus: current.ownMatchStatus,
                  route: current.route,
                  nextAction: current.nextAction,
                  brand: current.brand,
                };
              })()
            : {}),
          evidenceId: o.candidateId,
          evidenceSnapshot: this.handoff?.snapshot(o.candidateId) ?? null,
          operational: operational?.get(o.id) ?? null,
          notes: o.reason,
        };
      }),
      basis: "历史累计候选，非近期热销榜",
      target: 1000,
    };
  }
  brands() {
    return this.store.listBrands().map((b) => ({
      ...b,
      name: b.brand,
      taskStatus: b.status ?? "pending",
      notes: b.resultReason,
      authorizationExpiresAt: b.authorizationValidUntil,
    }));
  }
  overview() {
    const market = this.store.overview(),
      health = this.store.health(),
      orders = this.orders.summary(this.range(new URLSearchParams())),
      goal = this.orders.goal(),
      business = this.business.overview();
    return {
      updatedAt: business.projectedAt,
      market: {
        ...market,
        opportunityCount: market.opportunities,
        windowLabel: "历史候选 / 近期样本独立展示",
      },
      goal: goal
        ? {
            ...goal,
            target: goal.targetCents / 100,
            current: goal.currentCents / 100,
            remaining: goal.remainingCents / 100,
            confirmed: true,
          }
        : {
            target:
              this.settings.targetCents === null
                ? null
                : this.settings.targetCents / 100,
            current: null,
            remaining: null,
            asOf: null,
            confirmed: false,
            historicalContext:
              this.settings.historicalContextCents === null
                ? null
                : this.settings.historicalContextCents / 100,
          },
      orders: {
        ...orders,
        confirmed: orders.acceptedForTarget,
        revenue:
          orders.acceptedNetCents === null
            ? null
            : orders.acceptedNetCents / 100,
        status:
          orders.availability === "unavailable"
            ? "尚未接入订单"
            : "已导入，按指定口径对账",
      },
      business,
      actions: {
        products: {
          count: market.opportunities,
          reason: "按历史需求整理的候选；授权与来源独立核验",
        },
        brands: {
          count: market.brandsNeedingAction,
          reason: "按品牌合并跟进，缺授权不降低需求排名",
        },
        results: {
          count: orders.orderCount,
          reason:
            orders.availability === "unavailable"
              ? "订单尚未接入，先完成导入与对账"
              : "查看实际订单与批次关联",
        },
      },
      health: {
        market: `${health.observations}条观测 / ${health.runs}个采集记录`,
        orders:
          orders.availability === "unavailable"
            ? "待接入"
            : "已导入待核对具体口径",
        identity: "市场SKU与京东来源保持分离",
        authorization: "发布前核对24小时内授权及范围",
      },
    };
  }
  health() {
    const h = this.store.health();
    return {
      ...h,
      importStatus: this.importStatus,
      collection: this.collection.health(),
      schedules: this.collection.list(),
      projectedAt: this.business.overview().projectedAt,
      checks: [
        {
          name: "市场快照",
          status: h.observations ? "已导入" : "待导入",
          detail: "历史证据与受控采集分别留档；任务状态见采集区",
        },
        {
          name: "时间序列",
          status: "积累中",
          detail: "月榜没有完整基线时不计算；不回填虚构历史",
        },
        {
          name: "授权",
          status: "执行前复核",
          detail: "历史授权记录不自动变成当前可发布",
        },
        {
          name: "订单同步",
          status: "导入接口可用",
          detail:
            "已实测订单页可读，但退款金额与完成日期尚未闭合；支持结构化订单导入对账",
        },
        {
          name: "发布队列",
          status: "复用原工作台",
          detail: "分析写操作只更新本地决策，不直接发布商品",
        },
      ],
      capabilities: {
        marketImport: true,
        orderImport: true,
        orderAutoSync: false,
        marketAutoCollection: this.collection.health().active > 0,
        marketCollectorImplemented: true,
        bulkPublishing: "existing-workbench",
        bdContactSending: false,
      },
    };
  }
  read(path: string, q: URLSearchParams): any {
    if (path === "collections")
      return {
        items: this.collection.list(),
        health: this.collection.health(),
      };
    if (path === "orders/template") {
      const text = readFileSync(
        resolve(PACKAGE_ROOT, "docs/analytics-order-import.md"),
        "utf8",
      );
      return JSON.parse(text.match(/```json\n([\s\S]*?)\n```/)![1]);
    }
    if (path === "overview") return this.overview();
    if (path === "market") return this.market(q);
    if (path === "opportunities") return this.opportunities(q);
    if (path === "brands") return { items: this.brands() };
    if (path === "health") return this.health();
    if (path.startsWith("evidence/")) {
      const evidence = this.store.getEvidence(
        decodeURIComponent(path.slice(9)),
      );
      if (!evidence) throw Error("证据不存在");
      return {
        ...evidence,
        ...this.business.enrich(evidence.candidate),
        evidence: evidence.observations,
      };
    }
    if (path === "orders") {
      const range = this.range(q);
      const page = numberParam(q, "page", 1, 100000),
        pageSize = numberParam(q, "pageSize", 50, 200);
      return {
        summary: this.orders.summary(range),
        items: this.orders.listOrders({
          ...range,
          limit: pageSize,
          offset: (page - 1) * pageSize,
        }),
        page,
        pageSize,
        goal: this.orders.goal(),
        range,
      };
    }
    if (path === "batches") {
      const items = this.business.batches(),
        results = this.orders.listBatches(this.range(q));
      return {
        items: items.map((b) => ({
          ...b,
          ...results.find((r) => r.batchId === b.id),
        })),
        available: true,
        note: "原发布批次；没有订单归属时不计算批次收入",
      };
    }
    return undefined;
  }
  write(path: string, data: any): any {
    if (path === "opportunities/transfer") {
      if (!this.handoff) throw Error("机会转交服务尚未连接");
      return this.handoff.transfer(data);
    }
    if (path === "collections/configure")
      return this.collection.configure(
        z
          .object({
            id: z.string().min(1),
            source: z.string().min(1),
            shopId: z.string().regex(/^\d+$/),
            intervalMs: z.number().int().min(3600000),
            pageSize: z.number().int().min(1).max(30).optional(),
          })
          .parse(data),
      );
    if (path === "collections/tick") return this.collection.tick();
    const collectAction = path.match(
      /^collections\/([^/]+)\/(start|pause|resume)$/,
    );
    if (collectAction) {
      const id = decodeURIComponent(collectAction[1]);
      return collectAction[2] === "pause"
        ? this.collection.pause(id, "用户暂停")
        : collectAction[2] === "resume"
          ? this.collection.resume(id)
          : this.collection.start(id);
    }

    if (path === "opportunities") {
      const { candidateId } = z
        .object({ candidateId: z.string().min(1) })
        .parse(data);
      const existing = this.store.db
        .prepare("SELECT id FROM analytics_opportunities WHERE candidate_id=?")
        .get(candidateId);
      if (existing)
        return (
          this.store
            .listOpportunities({ page: 1, pageSize: 200 })
            .items.find((o) => o.id === existing.id) ?? {
            id: existing.id,
            reused: true,
          }
        );
      const evidence = this.store.getEvidence(candidateId);
      if (!evidence) throw Error("候选证据不存在");
      const c = this.business.enrich(evidence.candidate);
      return this.store.upsertOpportunity(candidateId, {
        brand: c.brand,
        route: c.route as any,
        nextAction: c.nextAction,
        reason:
          c.scope === "recent"
            ? "最近有效窗口的展示增长信号；不是实际成交额"
            : "历史累计价值候选，周期未知",
        authorizationStatus:
          c.authorizationStatus === "scope-needs-review"
            ? "needs-review"
            : (c.authorizationStatus as any),
        ownMatchStatus: c.ownMatchStatus as any,
      });
    }

    if (path === "listings/project") return this.orders.projectListings(data);
    if (path === "orders/import") return this.orders.importData(data);
    if (path === "orders/reconcile") return this.orders.reconcile(data);
    if (path === "goal") return this.orders.setGoal(data);
    if (path === "observations/import")
      return this.store.importObservations(data.observations, data.run);
    if (path === "brands/task") {
      const statusMap: Record<string, string> = {
        待联系: "pending",
        沟通中: "contacting",
        材料待补: "materials",
        授权待核: "verification",
        可用: "usable",
        到期: "expired",
      };
      const input = z
        .object({
          brand: z.string().min(1).optional(),
          id: z.string().optional(),
          brandId: z.string().optional(),
          status: z
            .enum([
              "pending",
              "contacting",
              "materials",
              "verification",
              "usable",
              "expired",
              "待联系",
              "沟通中",
              "材料待补",
              "授权待核",
              "可用",
              "到期",
            ])
            .optional(),
          owner: z.string().max(200).nullable().optional(),
          notes: z.string().max(4000).optional(),
          nextFollowUpAt: z.string().optional(),
        })
        .parse(data);
      const brand = input.brand ?? input.brandId ?? input.id;
      if (!brand || !this.store.listBrands().some((b) => b.brand === brand))
        throw Error("品牌机会不存在");
      return this.store.updateBrandTask(brand, {
        status: (statusMap[input.status ?? ""] ?? input.status) as any,
        owner: input.owner,
        resultReason: input.notes,
        nextFollowUpAt: input.nextFollowUpAt
          ? new Date(input.nextFollowUpAt).toISOString()
          : null,
      });
    }
    if (path.startsWith("opportunities/")) {
      const p = z
        .object({
          status: z
            .enum(["open", "selected", "paused", "completed"])
            .optional(),
          owner: z.string().max(200).nullable().optional(),
          notes: z.string().max(4000).optional(),
          reason: z.string().max(4000).optional(),
          nextAction: z.string().max(500).optional(),
          expectedRevision: z.number().int(),
        })
        .parse(data);
      return this.store.updateOpportunity(decodeURIComponent(path.slice(14)), {
        status: p.status,
        owner: p.owner,
        reason: p.notes ?? p.reason,
        nextAction: p.nextAction,
        expectedRevision: p.expectedRevision,
      });
    }
    return undefined;
  }
}
