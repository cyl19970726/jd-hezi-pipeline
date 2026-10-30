import { randomUUID } from "node:crypto";
import { Store } from "./store.js";
import type {
  readShopListing,
  readSkuVariants,
} from "./browser/discovery-readers.js";
type Listing = ReturnType<typeof readShopListing>;
type Variants = ReturnType<typeof readSkuVariants>;
export interface Source {
  shop: string;
  brandId: string;
  jdBrandId: string;
  jdShopId: string;
  shopName: string;
  kind: "self-operated" | "official";
  evidenceUrl: string;
  verifiedAt: string;
  seeds: string[];
}
const branch = (url: string) => {
  const u = new URL(url),
    m = u.pathname.match(/^\/view_search-(\d+)-(\d+)-/);
  if (u.hostname !== "mall.jd.com" || !m)
    throw Error("仅支持已核验的京东店铺分类入口");
  return m[1] + ":" + m[2];
};
export class Discovery {
  constructor(readonly store: Store) {
    store.db.exec(`
 CREATE TABLE IF NOT EXISTS discovery_runs(id TEXT PRIMARY KEY,source_json TEXT NOT NULL,status TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,error TEXT);
 CREATE TABLE IF NOT EXISTS discovery_pages(run_id TEXT NOT NULL,url TEXT NOT NULL,seed TEXT NOT NULL,status TEXT NOT NULL,data_json TEXT,PRIMARY KEY(run_id,url),FOREIGN KEY(run_id) REFERENCES discovery_runs(id));
 CREATE TABLE IF NOT EXISTS discovery_skus(run_id TEXT NOT NULL,sku TEXT NOT NULL,status TEXT NOT NULL,data_json TEXT,error TEXT,PRIMARY KEY(run_id,sku),FOREIGN KEY(run_id) REFERENCES discovery_runs(id));
 CREATE TABLE IF NOT EXISTS discovery_links(run_id TEXT NOT NULL,sku TEXT NOT NULL,source_url TEXT NOT NULL,hint TEXT NOT NULL,PRIMARY KEY(run_id,sku,source_url));
 `);
  }
  start(source: Source) {
    if (
      !source.seeds.length ||
      !source.shop ||
      !source.brandId ||
      !source.jdShopId ||
      !source.jdBrandId ||
      !source.shopName ||
      !Number.isFinite(Date.parse(source.verifiedAt))
    )
      throw Error("可信来源证据缺失");
    for (const url of source.seeds) branch(url);
    const id = randomUUID(),
      at = new Date().toISOString();
    this.store.tx(() => {
      this.store.db
        .prepare("INSERT INTO discovery_runs VALUES(?,?,'pages',?,?,NULL)")
        .run(id, JSON.stringify(source), at, at);
      for (const url of new Set(source.seeds))
        this.store.db
          .prepare("INSERT INTO discovery_pages VALUES(?,?,?,'pending',NULL)")
          .run(id, url, url);
    });
    return id;
  }
  get(id: string): any {
    const r = this.store.db
      .prepare("SELECT * FROM discovery_runs WHERE id=?")
      .get(id);
    if (!r) throw Error("商品发现批次不存在");
    return { ...r, source: JSON.parse(String(r.source_json)) };
  }
  next(id: string): any {
    const p = this.store.db
      .prepare(
        "SELECT * FROM discovery_pages WHERE run_id=? AND status='pending' ORDER BY rowid LIMIT 1",
      )
      .get(id);
    if (p) return { kind: "page", ...p };
    const s = this.store.db
      .prepare(
        "SELECT * FROM discovery_skus WHERE run_id=? AND status='pending' ORDER BY rowid LIMIT 1",
      )
      .get(id);
    return s ? { kind: "sku", ...s } : null;
  }
  private candidate(id: string, sku: string, url: string, hint: string) {
    if (!/^\d+$/.test(sku)) throw Error("商品发现SKU无效");
    this.store.db
      .prepare(
        "INSERT OR IGNORE INTO discovery_skus VALUES(?,?,'pending',NULL,NULL)",
      )
      .run(id, sku);
    this.store.db
      .prepare("INSERT OR IGNORE INTO discovery_links VALUES(?,?,?,?)")
      .run(id, sku, url, hint);
  }
  savePage(id: string, url: string, data: Listing) {
    return this.store.tx(() => {
      const run = this.get(id),
        p = this.store.db
          .prepare("SELECT * FROM discovery_pages WHERE run_id=? AND url=?")
          .get(id, url);
      if (
        !p ||
        p.status !== "pending" ||
        data.url !== url ||
        data.shopId !== run.source.jdShopId
      )
        throw Error("列表页面或店铺身份不符");
      if (
        !Number.isInteger(data.totalProducts) ||
        data.totalProducts < 0 ||
        data.pageNumber < 1 ||
        data.totalPages < data.pageNumber ||
        (!data.nextUrl && !data.lastPageConfirmed) ||
        (data.nextUrl && data.lastPageConfirmed)
      )
        throw Error("分页末页证据不完整");
      const prior = this.store.db
        .prepare(
          "SELECT data_json FROM discovery_pages WHERE run_id=? AND seed=? AND status='done'",
        )
        .all(id, p.seed)
        .map((r) => JSON.parse(String(r.data_json)));
      if (
        prior.some(
          (r) =>
            r.totalProducts !== data.totalProducts ||
            r.totalPages !== data.totalPages,
        ) ||
        data.pageNumber !== prior.length + 1
      )
        throw Error("分页顺序或数量变化，保留进度待复核");
      const all = [...prior, data],
        skus = all.flatMap((r) => r.rows.map((x: any) => x.sku));
      if (new Set(skus).size !== skus.length)
        throw Error("分页重复SKU，不能证明覆盖完整");
      if (
        data.lastPageConfirmed &&
        (skus.length !== data.totalProducts ||
          data.pageNumber !== data.totalPages)
      )
        throw Error("商品列表数量与末页不一致");
      if (data.nextUrl) {
        if (branch(data.nextUrl) !== branch(String(p.seed)))
          throw Error("下一页跨越了已授权的店铺分类入口");
        if (
          this.store.db
            .prepare("SELECT 1 FROM discovery_pages WHERE run_id=? AND url=?")
            .get(id, data.nextUrl)
        )
          throw Error("分页循环");
        this.store.db
          .prepare("INSERT INTO discovery_pages VALUES(?,?,?,'pending',NULL)")
          .run(id, data.nextUrl, p.seed);
      }
      for (const row of data.rows) this.candidate(id, row.sku, url, row.title);
      this.store.db
        .prepare(
          "UPDATE discovery_pages SET status='done',data_json=? WHERE run_id=? AND url=?",
        )
        .run(JSON.stringify(data), id, url);
      this.touch(id);
      return this.progress(id);
    });
  }
  saveSku(id: string, sku: string, data: Variants) {
    return this.store.tx(() => {
      const run = this.get(id);
      if (
        data.sku !== sku ||
        !this.store.db
          .prepare("SELECT 1 FROM discovery_skus WHERE run_id=? AND sku=?")
          .get(id, sku)
      )
        throw Error("SKU回执不属于当前任务");
      const eligible =
        data.shopId === run.source.jdShopId &&
        data.jdBrandId === run.source.jdBrandId &&
        data.shopName === run.source.shopName &&
        (run.source.kind !== "self-operated" || data.selfOperated);
      if (eligible)
        for (const v of data.variants)
          this.candidate(id, v.sku, data.url, v.hint);
      this.store.db
        .prepare(
          "UPDATE discovery_skus SET status=?,data_json=?,error=? WHERE run_id=? AND sku=?",
        )
        .run(
          eligible ? "verified" : "excluded",
          JSON.stringify(data),
          eligible ? null : "店铺或品牌身份不符",
          id,
          sku,
        );
      this.touch(id);
      return this.progress(id);
    });
  }
  retryBlocked(id: string, sku: string, reason: string) {
    if (!reason) throw Error("恢复规格任务需要原因");
    this.store.event(null, "DISCOVERY_SKU_RETRY", { runId: id, sku, reason });
    this.store.db
      .prepare(
        "UPDATE discovery_skus SET status='pending' WHERE run_id=? AND sku=? AND status='blocked'",
      )
      .run(id, sku);
    this.touch(id);
  }
  blockSku(id: string, sku: string, error: string) {
    this.store.event(null, "DISCOVERY_SKU_BLOCKED", { runId: id, sku, error });
    this.store.db
      .prepare(
        "UPDATE discovery_skus SET status='blocked',error=? WHERE run_id=? AND sku=?",
      )
      .run(error, id, sku);
    this.touch(id);
  }
  private touch(id: string) {
    const next = this.next(id);
    if (next)
      this.store.db
        .prepare("UPDATE discovery_runs SET status=? WHERE id=?")
        .run(next.kind === "page" ? "pages" : "variants", id);
    this.store.db
      .prepare("UPDATE discovery_runs SET updated_at=? WHERE id=?")
      .run(new Date().toISOString(), id);
  }
  finish(id: string) {
    if (this.next(id)) throw Error("商品发现尚有未完成分页或规格");
    if (["complete-source", "needs-review"].includes(this.get(id).status))
      return this.progress(id);
    const blocked = Number(
      this.store.db
        .prepare(
          "SELECT COUNT(*) AS n FROM discovery_skus WHERE run_id=? AND status='blocked'",
        )
        .get(id)?.n,
    );
    this.store.db
      .prepare("UPDATE discovery_runs SET status=?,updated_at=? WHERE id=?")
      .run(
        blocked ? "needs-review" : "complete-source",
        new Date().toISOString(),
        id,
      );
    return this.progress(id);
  }
  list(shop: string) {
    return this.store.db
      .prepare("SELECT id FROM discovery_runs ORDER BY rowid DESC")
      .all()
      .filter((r) => this.get(String(r.id)).source.shop === shop)
      .map((r) => this.progress(String(r.id)));
  }
  progress(id: string) {
    const run = this.get(id);
    return {
      id,
      brandId: run.source.brandId,
      error: run.error,
      shopName: run.source.shopName,
      status: run.status,
      scope: "one-verified-shop-and-explicit-categories",
      pages: this.store.db
        .prepare(
          "SELECT status,COUNT(*) AS n FROM discovery_pages WHERE run_id=? GROUP BY status",
        )
        .all(id),
      skus: this.store.db
        .prepare(
          "SELECT status,COUNT(*) AS n FROM discovery_skus WHERE run_id=? GROUP BY status",
        )
        .all(id),
      updatedAt: run.updated_at,
    };
  }
}
