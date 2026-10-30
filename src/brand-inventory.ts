import { Catalog, type CatalogBatch } from "./catalog.js";
import { randomUUID } from "node:crypto";
import { Store } from "./store.js";

export function potentiallyActiveBrand(row: any, now = Date.now()) {
  if (![1, 4].includes(row.supplierBrandStatus)) return false;
  if (row.validStatus === 1) return true;
  const from = Date.parse(row.validTimeBegin + "T00:00:00+08:00");
  const until = Date.parse(row.validTimeEnd + "T23:59:59+08:00");
  return (
    Number.isFinite(from) &&
    Number.isFinite(until) &&
    from <= now &&
    now <= until
  );
}

/** A full current-brand snapshot, distinct from the application history. */
export class BrandInventory {
  constructor(readonly store: Store) {
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS brand_inventory_runs (
        id TEXT PRIMARY KEY, shop TEXT NOT NULL, supplier_id TEXT NOT NULL,
        status TEXT NOT NULL, next_page INTEGER NOT NULL, page_size INTEGER NOT NULL,
        total INTEGER, started_at TEXT NOT NULL, updated_at TEXT NOT NULL, error TEXT);
      CREATE TABLE IF NOT EXISTS brand_inventory_rows (
        run_id TEXT NOT NULL, grant_id TEXT NOT NULL, brand_id TEXT NOT NULL,
        list_json TEXT NOT NULL, detail_json TEXT, checked_at TEXT, error TEXT,
        PRIMARY KEY(run_id,grant_id), UNIQUE(run_id,brand_id),
        FOREIGN KEY(run_id) REFERENCES brand_inventory_runs(id));
    `);
  }
  start(shop: string, supplierId: string, pageSize = 10) {
    const id = randomUUID(),
      at = new Date().toISOString();
    if (!shop || !supplierId || pageSize !== 10)
      throw Error("品牌核对身份或分页配置无效");
    this.store.db
      .prepare(
        "INSERT INTO brand_inventory_runs VALUES(?,?,?,'listing',1,?,NULL,?,?,NULL)",
      )
      .run(id, shop, supplierId, pageSize, at, at);
    return id;
  }
  get(id: string): any {
    const row = this.store.db
      .prepare("SELECT * FROM brand_inventory_runs WHERE id=?")
      .get(id);
    if (!row) throw Error("品牌核对批次不存在");
    return row;
  }
  savePage(id: string, page: any) {
    return this.store.tx(() => {
      const run = this.get(id);
      if (
        run.status !== "listing" ||
        page.pageNum !== run.next_page ||
        page.pageSize !== run.page_size ||
        !Number.isInteger(page.totalCount) ||
        page.totalCount < 0 ||
        !Array.isArray(page.result)
      )
        throw Error("品牌分页回执不连续或无效");
      if (run.total !== null && run.total !== page.totalCount)
        throw Error("品牌总数在同步期间变化，保留旧进度等待重新核验");
      const remaining = page.totalCount - (page.pageNum - 1) * page.pageSize;
      if (
        page.result.length !== Math.max(0, Math.min(page.pageSize, remaining))
      )
        throw Error("品牌分页缺行，不能推进进度");
      for (const row of page.result) {
        if (
          row.id === null ||
          row.id === undefined ||
          !row.brandId ||
          !row.brandName ||
          String(row.supplierId) !== run.supplier_id ||
          row.supplierName !== run.shop
        )
          throw Error("品牌行身份与当前供应商不符");
        this.store.db
          .prepare(
            "INSERT INTO brand_inventory_rows(run_id,grant_id,brand_id,list_json) VALUES(?,?,?,?)",
          )
          .run(id, String(row.id), String(row.brandId), JSON.stringify(row));
      }
      const count = Number(
        this.store.db
          .prepare(
            "SELECT COUNT(*) AS n FROM brand_inventory_rows WHERE run_id=?",
          )
          .get(id)?.n,
      );
      this.store.db
        .prepare(
          "UPDATE brand_inventory_runs SET total=?,next_page=?,status=?,updated_at=?,error=NULL WHERE id=?",
        )
        .run(
          page.totalCount,
          page.pageNum + 1,
          count === page.totalCount ? "details" : "listing",
          new Date().toISOString(),
          id,
        );
      return this.progress(id);
    });
  }
  rows(id: string): any[] {
    return this.store.db
      .prepare(
        "SELECT * FROM brand_inventory_rows WHERE run_id=? ORDER BY rowid",
      )
      .all(id)
      .map((r) => ({
        ...r,
        list: JSON.parse(String(r.list_json)),
        detail: r.detail_json ? JSON.parse(String(r.detail_json)) : null,
      }));
  }
  pending(id: string, now = Date.now()) {
    return this.rows(id).filter(
      (r) => !r.detail && potentiallyActiveBrand(r.list, now),
    );
  }
  saveDetail(id: string, grantId: string, detail: any) {
    const run = this.get(id);
    const row = this.store.db
      .prepare(
        "SELECT * FROM brand_inventory_rows WHERE run_id=? AND grant_id=?",
      )
      .get(id, grantId);
    if (
      !row ||
      String(detail.id) !== grantId ||
      String(detail.brandId) !== row.brand_id ||
      String(detail.supplierId) !== run.supplier_id ||
      detail.supplierName !== run.shop ||
      !Array.isArray(detail.supplierBrandCatVos)
    )
      throw Error("品牌详情身份或类目回执无效");
    this.store.db
      .prepare(
        "UPDATE brand_inventory_rows SET detail_json=?,checked_at=?,error=NULL WHERE run_id=? AND grant_id=?",
      )
      .run(JSON.stringify(detail), new Date().toISOString(), id, grantId);
    this.store.db
      .prepare(
        "UPDATE brand_inventory_runs SET updated_at=?,error=NULL WHERE id=?",
      )
      .run(new Date().toISOString(), id);
  }
  fail(id: string, error: string) {
    this.store.db
      .prepare(
        "UPDATE brand_inventory_runs SET error=?,updated_at=? WHERE id=?",
      )
      .run(error, new Date().toISOString(), id);
  }
  complete(id: string) {
    const run = this.get(id);
    if (
      run.status !== "details" ||
      this.pending(id).length ||
      this.rows(id).length !== run.total
    )
      throw Error("品牌核对覆盖不完整");
    this.store.db
      .prepare(
        "UPDATE brand_inventory_runs SET status='complete',error=NULL,updated_at=? WHERE id=?",
      )
      .run(new Date().toISOString(), id);
    return this.progress(id);
  }
  progress(id: string) {
    const run = this.get(id),
      rows = this.rows(id);
    return {
      ...run,
      listed: rows.length,
      potentiallyActive: rows.filter((r) =>
        potentiallyActiveBrand(r.detail ?? r.list),
      ).length,
      details: rows.filter((r) => r.detail).length,
      pendingDetails: this.pending(id).length,
    };
  }
  activateCatalog(id: string) {
    const run = this.get(id);
    if (run.status !== "complete")
      throw Error("品牌核对尚未完成，不能启用授权快照");
    const rows = this.rows(id),
      rejected: { brand: string; reason: string }[] = [];
    const url = "https://b.csgmall.com.cn/shop-view/#/shop-view/brand/regulate";
    const batch: CatalogBatch = {
      shop: run.shop,
      categories: [],
      brands: rows.map((r) => ({
        id: r.brand_id,
        name: r.list.brandName,
        sourceUrl: url,
        checkedAt: run.updated_at,
      })),
      grants: [],
    };
    for (const r of rows) {
      const d = r.detail ?? r.list;
      if (!potentiallyActiveBrand(d)) continue;
      if (!r.detail) throw Error("有效品牌缺少详情");
      if (d.validStatus === 1 || !d.validTimeBegin || !d.validTimeEnd) {
        rejected.push({ brand: d.brandName, reason: "有效期需明确建模" });
        continue;
      }
      const scopes = d.supplierBrandCatVos
        .filter((c: any) => c.status === 1)
        .map((c: any) => ({ categoryId: String(c.catId), descendants: true }));
      if (!scopes.length) {
        rejected.push({ brand: d.brandName, reason: "无状态有效的类目" });
        continue;
      }
      const missing = scopes.filter(
        (c: any) =>
          !this.store.db
            .prepare("SELECT 1 FROM catalog_categories WHERE shop=? AND id=?")
            .get(run.shop, c.categoryId),
      );
      if (missing.length) {
        rejected.push({
          brand: d.brandName,
          reason:
            "缺少平台类目关系：" +
            missing.map((c: any) => c.categoryId).join(","),
        });
        continue;
      }
      batch.grants.push({
        id: "current:" + r.grant_id,
        brandId: r.brand_id,
        status: "approved",
        validFrom: new Date(d.validTimeBegin + "T00:00:00+08:00").toISOString(),
        validUntil: new Date(d.validTimeEnd + "T23:59:59+08:00").toISOString(),
        scopes,
        sourceUrl: url,
        checkedAt: r.checked_at,
      });
    }
    const result = new Catalog(this.store).import(batch, id);
    const report = {
      ...result,
      coverage: "complete-current-brand-inventory",
      rejected,
      runId: id,
    };
    this.store.setMeta("brand-inventory-activation:" + run.shop, report);
    return report;
  }
  latest(shop: string) {
    const r = this.store.db
      .prepare(
        "SELECT id FROM brand_inventory_runs WHERE shop=? ORDER BY rowid DESC LIMIT 1",
      )
      .get(shop);
    return r ? this.progress(String(r.id)) : null;
  }
}
