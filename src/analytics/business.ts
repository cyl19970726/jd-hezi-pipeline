import type { Store } from "../store.js";
import type { MarketCandidate } from "./types.js";
import { titleSupportsBrand } from "./research-import.js";
import { OperationalReadiness } from "../operational-readiness.js";
const norm = (v: unknown) =>
  String(v ?? "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, "");

/** Consistent local business projection. Read-only; publishing keeps its own state machine. */
export class AnalyticsBusiness {
  private at = 0;
  private snapshot: any;
  private readiness: OperationalReadiness;
  constructor(
    private store: Store,
    private shop: string,
    private jobs: () => any[],
  ) {
    this.readiness = new OperationalReadiness(store);
  }
  read(force = false) {
    if (!force && this.snapshot && Date.now() - this.at < 15_000)
      return this.snapshot;
    const db = this.store.db;
    const jobs = this.jobs();
    const grants = db
      .prepare(
        `SELECT b.id AS brandId,b.name,g.id AS grantId,g.status,g.valid_from AS validFrom,g.valid_until AS validUntil,g.checked_at AS checkedAt FROM catalog_brands b LEFT JOIN catalog_grants g ON g.shop=b.shop AND g.brand_id=b.id WHERE b.shop=?`,
      )
      .all(this.shop);
    const scopes = db
      .prepare(
        "SELECT grant_id AS grantId,category_id AS categoryId,descendants FROM catalog_scopes WHERE shop=?",
      )
      .all(this.shop);
    const inventory = db
      .prepare(
        "SELECT item_id AS itemId,sku,title,status,observed_at AS observedAt FROM remote_inventory WHERE shop=?",
      )
      .all(this.shop);
    const batchRows = db
      .prepare(
        "SELECT b.id,b.created_at AS createdAt,j.id AS jobId,j.status,j.product_id AS productId FROM batches b JOIN batch_jobs bj ON bj.batch_id=b.id JOIN jobs j ON j.id=bj.job_id WHERE j.shop=? ORDER BY b.created_at DESC",
      )
      .all(this.shop);
    const eventCursor = Number(
      db.prepare("SELECT COALESCE(MAX(seq),0) n FROM events").get()?.n,
    );
    const jobCursor = Number(
      db.prepare("SELECT COALESCE(MAX(seq),0) n FROM job_events").get()?.n,
    );
    const counts: Record<string, number> = {};
    for (const j of jobs) {
      const state = j.remoteState ?? j.status;
      counts[state] = (counts[state] ?? 0) + 1;
    }
    this.at = Date.now();
    this.snapshot = {
      shop: this.shop,
      projectedAt: new Date(this.at).toISOString(),
      eventCursor,
      jobCursor,
      counts,
      jobs,
      grants,
      scopes,
      inventory,
      batchRows,
    };
    return this.snapshot;
  }
  overview() {
    const s = this.read();
    return {
      shop: s.shop,
      projectedAt: s.projectedAt,
      eventCursor: s.eventCursor,
      jobCursor: s.jobCursor,
      counts: s.counts,
      jobs: s.jobs,
      brandGrantCount: s.grants.length,
      inventoryCount: s.inventory.length,
      unresolved: s.jobs.filter((j: any) =>
        ["UNKNOWN_OUTCOME", "NEEDS_INPUT"].includes(j.status),
      ),
      rejected: s.jobs.filter(
        (j: any) => j.remoteState === "REJECTED" || j.remoteState === "已驳回",
      ),
    };
  }
  enrich(candidate: MarketCandidate) {
    const s = this.read();
    const raw = candidate.end.raw as any;
    // Public-market brand IDs and supplier-catalog brand IDs are different
    // namespaces. A coincidental numeric equality is not an identity proof.
    const marketBrandId = raw?.brandId ? String(raw.brandId) : null;
    const normalizedBrand = candidate.brand ? norm(candidate.brand) : "";
    const titleBrandEvidenceConflict =
      raw?.brandIdentitySource === "title-matched-shop-brand-list" &&
      !!candidate.brand &&
      !titleSupportsBrand(candidate.title, candidate.brand);
    const nameCandidates =
      normalizedBrand && !titleBrandEvidenceConflict
        ? s.grants.filter((g: any) => norm(g.name) === normalizedBrand)
        : [];
    const supplierBrandIds = [
      ...new Set(nameCandidates.map((g: any) => String(g.brandId))),
    ];
    const collidingSupplierIds = marketBrandId
      ? [
          ...new Set(
            s.grants
              .filter((g: any) => String(g.brandId) === marketBrandId)
              .map((g: any) => String(g.brandId)),
          ),
        ]
      : [];
    const brandIdentityConflict =
      titleBrandEvidenceConflict ||
      (collidingSupplierIds.length > 0 &&
        !supplierBrandIds.includes(marketBrandId!));
    const supplierBrandId =
      !brandIdentityConflict && supplierBrandIds.length === 1
        ? supplierBrandIds[0]
        : null;
    const matches = supplierBrandId
      ? s.grants.filter((g: any) => String(g.brandId) === supplierBrandId)
      : [];
    const at = Date.now();
    const valid = matches.filter(
      (g: any) =>
        g.status === "approved" &&
        Date.parse(g.validFrom) <= at &&
        Date.parse(g.validUntil) >= at,
    );
    const fresh = valid.filter(
      (g: any) =>
        Date.parse(g.checkedAt) <= at &&
        at - Date.parse(g.checkedAt) <= 24 * 60 * 60 * 1000,
    );
    const own = s.inventory.filter(
      (r: any) => norm(r.title) === norm(candidate.title),
    );
    const local = s.jobs.filter(
      (r: any) => norm(r.title) === norm(candidate.title),
    );
    const authorizationStatus = fresh.length
      ? "scope-needs-review"
      : matches.length
        ? "historical"
        : "missing";
    const exactBinding = raw?.catalogBinding;
    const exactSupplierBrandId = exactBinding?.brandId
      ? String(exactBinding.brandId)
      : null;
    const exactCategoryId = exactBinding?.categoryId
      ? String(exactBinding.categoryId)
      : null;
    const exactBrand = exactSupplierBrandId
      ? s.grants.find(
          (grant: any) => String(grant.brandId) === exactSupplierBrandId,
        )
      : null;
    const operationalReadiness = this.readiness.evaluate({
      shop: this.shop,
      brand:
        exactSupplierBrandId && exactBrand
          ? { id: exactSupplierBrandId, name: String(exactBrand.name) }
          : null,
      category:
        exactCategoryId && raw?.categoryPath
          ? { id: exactCategoryId, path: String(raw.categoryPath) }
          : null,
      sourceSku: raw?.sourceSku ? String(raw.sourceSku) : null,
      hints: {
        brandName: candidate.brand,
        categoryPath: candidate.category,
      },
    });
    const nextAction = titleBrandEvidenceConflict
      ? "标题不支持已推断品牌，需人工核对品牌身份"
      : brandIdentityConflict
        ? "市场品牌ID与供应商目录品牌冲突，需人工核对品牌身份"
        : own.length || local.length
          ? "核对本店相似商品，避免重复上架"
          : !candidate.brand
            ? "核对品牌与完整规格"
            : matches.length
              ? "刷新授权并核对类目范围，补齐京东来源"
              : "合并到品牌BD，获取授权与商品来源";
    return {
      ...candidate,
      shopName: raw?.shopName ?? candidate.shop,
      brand: matches[0]?.name ?? candidate.brand,
      brandId: supplierBrandId,
      marketBrandId,
      supplierBrandId,
      brandMatchSource: supplierBrandId
        ? "unique-normalized-catalog-name"
        : titleBrandEvidenceConflict
          ? "title-brand-evidence-conflict"
          : brandIdentityConflict
            ? "market-id-catalog-name-conflict"
            : null,
      brandMatchEvidence: supplierBrandId
        ? {
            marketBrandId,
            marketBrandName: candidate.brand,
            supplierBrandId,
            supplierBrandName: matches[0]?.name ?? null,
            normalizedName: normalizedBrand,
          }
        : null,
      brandIdentityConflict,
      titleBrandEvidenceConflict,
      categorySource: raw?.categorySource ?? "research",
      authorizationStatus,
      operationalReadiness,
      authorizationCheckedAt:
        matches
          .map((g: any) => g.checkedAt)
          .filter(Boolean)
          .sort()
          .at(-1) ?? null,
      authorizationScopes: s.scopes.filter((x: any) =>
        matches.some((g: any) => g.grantId === x.grantId),
      ),
      ownMatchStatus: own.length || local.length ? "candidate" : "needs-review",
      ownMatches: own.slice(0, 5),
      jobId: local[0]?.id ?? null,
      jobUrl: local[0] ? "/?job=" + encodeURIComponent(local[0].id) : null,
      route: brandIdentityConflict
        ? "review"
        : own.length || local.length
          ? "maintain"
          : matches.length || !candidate.brand
            ? "review"
            : "bd",
      nextAction,
      readiness: "needs-review",
      canPublish: false,
      readinessReason:
        "市场SKU不是京东来源SKU；商品身份、授权范围和来源资料需通过原发布预检",
    };
  }
  batches() {
    const s = this.read(),
      groups = new Map<string, any>();
    for (const r of s.batchRows) {
      const b = groups.get(r.id) ?? {
        id: r.id,
        batchId: r.id,
        createdAt: r.createdAt,
        jobs: [],
        counts: {},
        orderRevenue: null,
        orderStatus: "待接入订单并完成身份归属",
      };
      const j = s.jobs.find((x: any) => x.id === r.jobId);
      const state = j?.remoteState ?? r.status;
      b.jobs.push({ ...j, jobUrl: "/?job=" + encodeURIComponent(r.jobId) });
      b.counts[state] = (b.counts[state] ?? 0) + 1;
      groups.set(r.id, b);
    }
    return [...groups.values()];
  }
}
