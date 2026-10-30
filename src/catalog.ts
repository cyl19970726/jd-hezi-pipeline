import { randomUUID } from "node:crypto";
import { z } from "zod";
import { Store } from "./store.js";
import { PipelineError, type Plan } from "./model.js";

const evidence = {
  sourceUrl: z.string().url(),
  checkedAt: z.string().datetime(),
};
export const catalogBatchSchema = z.object({
  shop: z.string().min(1),
  categories: z.array(
    z.object({
      id: z.string().min(1),
      parentId: z.string().min(1).nullable(),
      name: z.string().min(1),
      path: z.string().min(1),
      selectable: z.boolean(),
      ...evidence,
    }),
  ),
  brands: z.array(
    z.object({ id: z.string().min(1), name: z.string().min(1), ...evidence }),
  ),
  grants: z.array(
    z.object({
      id: z.string().min(1),
      brandId: z.string().min(1),
      status: z.enum(["approved", "pending", "rejected", "revoked"]),
      validFrom: z.string().datetime(),
      validUntil: z.string().datetime(),
      scopes: z
        .array(
          z.object({ categoryId: z.string().min(1), descendants: z.boolean() }),
        )
        .min(1),
      ...evidence,
    }),
  ),
});
export type CatalogBatch = z.infer<typeof catalogBatchSchema>;
const normalize = (s: string) => s.replace(/\s/g, "").replace(/＞/g, ">");

/** Shop-scoped platform facts. Never treats an imported subset as a full catalog. */
export class Catalog {
  constructor(readonly store: Store) {
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS catalog_categories(
        shop TEXT NOT NULL,id TEXT NOT NULL,parent_id TEXT,name TEXT NOT NULL,path TEXT NOT NULL,
        selectable INTEGER NOT NULL,source_url TEXT NOT NULL,checked_at TEXT NOT NULL,
        PRIMARY KEY(shop,id));
      CREATE TABLE IF NOT EXISTS catalog_brands(
        shop TEXT NOT NULL,id TEXT NOT NULL,name TEXT NOT NULL,source_url TEXT NOT NULL,
        checked_at TEXT NOT NULL,PRIMARY KEY(shop,id));
      CREATE TABLE IF NOT EXISTS catalog_grants(
        shop TEXT NOT NULL,id TEXT NOT NULL,brand_id TEXT NOT NULL,status TEXT NOT NULL,
        valid_from TEXT NOT NULL,valid_until TEXT NOT NULL,source_url TEXT NOT NULL,
        checked_at TEXT NOT NULL,PRIMARY KEY(shop,id),
        FOREIGN KEY(shop,brand_id) REFERENCES catalog_brands(shop,id));
      CREATE TABLE IF NOT EXISTS catalog_scopes(
        shop TEXT NOT NULL,grant_id TEXT NOT NULL,category_id TEXT NOT NULL,descendants INTEGER NOT NULL,
        PRIMARY KEY(shop,grant_id,category_id),
        FOREIGN KEY(shop,grant_id) REFERENCES catalog_grants(shop,id),
        FOREIGN KEY(shop,category_id) REFERENCES catalog_categories(shop,id));
      CREATE TABLE IF NOT EXISTS sync_runs(
        id TEXT PRIMARY KEY,shop TEXT NOT NULL,partition TEXT NOT NULL,status TEXT NOT NULL,
        started_at TEXT NOT NULL,finished_at TEXT,coverage TEXT NOT NULL,error TEXT);
      CREATE TABLE IF NOT EXISTS remote_inventory(
        shop TEXT NOT NULL,item_id TEXT NOT NULL,code TEXT NOT NULL,sku TEXT,title TEXT NOT NULL,
        status TEXT NOT NULL,snapshot TEXT NOT NULL,observed_at TEXT NOT NULL,run_id TEXT NOT NULL,
        PRIMARY KEY(shop,item_id),FOREIGN KEY(run_id) REFERENCES sync_runs(id));
    `);
  }
  import(input: unknown, authoritativeRunId?: string) {
    const batch = catalogBatchSchema.parse(input);
    const now = Date.now();
    for (const row of [...batch.categories, ...batch.brands, ...batch.grants]) {
      if (Date.parse(row.checkedAt) > now + 60000)
        throw new PipelineError("NEEDS_INPUT", "目录核验时间不能在未来");
    }
    return this.store.tx(() => {
      if (authoritativeRunId) {
        const run = this.store.db
          .prepare("SELECT * FROM brand_inventory_runs WHERE id=?")
          .get(authoritativeRunId);
        const ids = this.store.db
          .prepare("SELECT brand_id FROM brand_inventory_rows WHERE run_id=?")
          .all(authoritativeRunId)
          .map((r) => String(r.brand_id))
          .sort();
        if (
          !run ||
          run.status !== "complete" ||
          run.shop !== batch.shop ||
          run.total !== ids.length ||
          JSON.stringify(ids) !==
            JSON.stringify(batch.brands.map((b) => b.id).sort())
        )
          throw new PipelineError(
            "BUSINESS_BLOCKED",
            "当前品牌全量核对未完成，不能替换授权",
          );
        this.store.db
          .prepare("UPDATE catalog_grants SET status='revoked' WHERE shop=?")
          .run(batch.shop);
        this.store.setMeta(
          "authoritative-brand-inventory:" + batch.shop,
          authoritativeRunId,
        );
      }
      for (const c of batch.categories)
        this.store.db
          .prepare(
            `INSERT INTO catalog_categories VALUES(?,?,?,?,?,?,?,?)
        ON CONFLICT(shop,id) DO UPDATE SET parent_id=excluded.parent_id,name=excluded.name,path=excluded.path,
        selectable=excluded.selectable,source_url=excluded.source_url,checked_at=excluded.checked_at
        WHERE excluded.checked_at >= catalog_categories.checked_at`,
          )
          .run(
            batch.shop,
            c.id,
            c.parentId,
            c.name,
            c.path,
            Number(c.selectable),
            c.sourceUrl,
            c.checkedAt,
          );
      // Reject broken/cyclic ancestry rather than permitting an ambiguous authorization walk.
      const all = this.store.db
        .prepare("SELECT id,parent_id FROM catalog_categories WHERE shop=?")
        .all(batch.shop);
      const parents = new Map(
        all.map((r) => [
          String(r.id),
          r.parent_id === null ? null : String(r.parent_id),
        ]),
      );
      for (const id of parents.keys()) {
        const seen = new Set<string>();
        let current: string | null = id;
        while (current !== null) {
          if (seen.has(current) || !parents.has(current))
            throw new PipelineError("NEEDS_INPUT", "类目父节点缺失或存在环", {
              id,
            });
          seen.add(current);
          current = parents.get(current)!;
        }
      }
      for (const b of batch.brands)
        this.store.db
          .prepare(
            `INSERT INTO catalog_brands VALUES(?,?,?,?,?)
        ON CONFLICT(shop,id) DO UPDATE SET name=excluded.name,source_url=excluded.source_url,checked_at=excluded.checked_at
        WHERE excluded.checked_at >= catalog_brands.checked_at`,
          )
          .run(batch.shop, b.id, b.name, b.sourceUrl, b.checkedAt);
      for (const g of batch.grants) {
        if (Date.parse(g.validUntil) < Date.parse(g.validFrom))
          throw new PipelineError("NEEDS_INPUT", "授权有效期倒置");
        const old = this.store.db
          .prepare(
            "SELECT checked_at FROM catalog_grants WHERE shop=? AND id=?",
          )
          .get(batch.shop, g.id);
        if (old && Date.parse(String(old.checked_at)) > Date.parse(g.checkedAt))
          continue;
        this.store.db
          .prepare(
            `INSERT INTO catalog_grants VALUES(?,?,?,?,?,?,?,?)
          ON CONFLICT(shop,id) DO UPDATE SET brand_id=excluded.brand_id,status=excluded.status,valid_from=excluded.valid_from,
          valid_until=excluded.valid_until,source_url=excluded.source_url,checked_at=excluded.checked_at`,
          )
          .run(
            batch.shop,
            g.id,
            g.brandId,
            g.status,
            g.validFrom,
            g.validUntil,
            g.sourceUrl,
            g.checkedAt,
          );
        this.store.db
          .prepare("DELETE FROM catalog_scopes WHERE shop=? AND grant_id=?")
          .run(batch.shop, g.id);
        for (const s of g.scopes)
          this.store.db
            .prepare("INSERT INTO catalog_scopes VALUES(?,?,?,?)")
            .run(batch.shop, g.id, s.categoryId, Number(s.descendants));
      }
      this.store.event(null, "CATALOG_IMPORTED", {
        shop: batch.shop,
        categories: batch.categories.length,
        brands: batch.brands.length,
        grants: batch.grants.length,
        coverage: "subset",
      });
      return {
        categories: batch.categories.length,
        brands: batch.brands.length,
        grants: batch.grants.length,
        coverage: "subset",
      };
    });
  }
  authorize(
    plan: Pick<Plan, "shop" | "brand" | "categoryPath" | "catalogBinding">,
    now = Date.now(),
    maxAgeMs = 24 * 3600000,
  ) {
    const binding = plan.catalogBinding;
    const blocked = (message: string): never => {
      throw new PipelineError("BUSINESS_BLOCKED", message);
    };
    if (!binding)
      return blocked("计划缺少数据库品牌及类目 ID，不能以手填授权声明提交");
    const brand = this.store.db
      .prepare("SELECT * FROM catalog_brands WHERE shop=? AND id=?")
      .get(plan.shop, binding.brandId);
    const category = this.store.db
      .prepare("SELECT * FROM catalog_categories WHERE shop=? AND id=?")
      .get(plan.shop, binding.categoryId);
    const fresh = (r: any) =>
      r &&
      now - Date.parse(r.checked_at) <= maxAgeMs &&
      Date.parse(r.checked_at) <= now + 60000;
    if (!fresh(brand) || !fresh(category))
      return blocked("品牌或类目目录缺失/过期，请同步");
    if (
      normalize(String(brand!.name)) !== normalize(plan.brand) ||
      normalize(String(category!.path)) !== normalize(plan.categoryPath) ||
      !category!.selectable
    )
      return blocked("计划名称、类目路径与数据库 ID 不匹配或类目不可选");
    const ancestors = new Set<string>();
    let parent = category!.parent_id;
    while (parent !== null) {
      if (ancestors.has(String(parent))) return blocked("类目关系出现环");
      const row = this.store.db
        .prepare("SELECT * FROM catalog_categories WHERE shop=? AND id=?")
        .get(plan.shop, String(parent));
      if (!fresh(row)) return blocked("类目祖先关系缺失/过期");
      ancestors.add(String(parent));
      parent = row!.parent_id;
    }
    const grants = this.store.db
      .prepare(
        `SELECT * FROM catalog_grants WHERE shop=? AND brand_id=? AND status='approved'`,
      )
      .all(plan.shop, binding.brandId);
    for (const g of grants) {
      const id = String(g.id);
      // A targeted read is a newer observation of this exact platform grant.
      // It may prove the historical row stale, but cannot hide a different grant.
      if (!id.startsWith("current:")) {
        const current = this.store.db
          .prepare(
            "SELECT status,checked_at FROM catalog_grants WHERE shop=? AND id=? AND brand_id=?",
          )
          .get(plan.shop, "current:" + id, binding.brandId);
        if (
          current &&
          ["pending", "rejected", "revoked"].includes(String(current.status)) &&
          Date.parse(String(current.checked_at)) >
            Date.parse(String(g.checked_at))
        )
          continue;
      }
      if (
        !fresh(g) ||
        now < Date.parse(String(g.valid_from)) ||
        now > Date.parse(String(g.valid_until))
      )
        continue;
      const scopes = this.store.db
        .prepare("SELECT * FROM catalog_scopes WHERE shop=? AND grant_id=?")
        .all(plan.shop, String(g.id));
      if (
        scopes.some(
          (s) =>
            s.category_id === binding.categoryId ||
            (s.descendants === 1 && ancestors.has(String(s.category_id))),
        )
      )
        return {
          grantId: String(g.id),
          brandId: binding.brandId,
          categoryId: binding.categoryId,
          checkedAt: String(g.checked_at),
        };
    }
    return blocked("现有品牌没有覆盖该类目的有效已批准授权");
  }
  summary(shop: string) {
    return {
      categories: this.store.db
        .prepare("SELECT * FROM catalog_categories WHERE shop=?")
        .all(shop),
      brands: this.store.db
        .prepare("SELECT * FROM catalog_brands WHERE shop=?")
        .all(shop),
      grants: this.store.db
        .prepare("SELECT * FROM catalog_grants WHERE shop=?")
        .all(shop),
      scopes: this.store.db
        .prepare("SELECT * FROM catalog_scopes WHERE shop=?")
        .all(shop),
      syncRuns: this.store.db
        .prepare(
          "SELECT * FROM sync_runs WHERE shop=? ORDER BY started_at DESC LIMIT 20",
        )
        .all(shop),
      inventory: this.store.db
        .prepare(
          "SELECT COUNT(*) AS total,SUM(sku IS NULL) AS unresolved FROM remote_inventory WHERE shop=?",
        )
        .get(shop),
    };
  }
  inventoryComplete(shop: string) {
    for (const partition of ["draft", "normal"]) {
      const r = this.store.db
        .prepare(
          "SELECT * FROM sync_runs WHERE shop=? AND partition=? ORDER BY started_at DESC,rowid DESC LIMIT 1",
        )
        .get(shop, partition);
      if (
        !r ||
        r.status !== "complete" ||
        Date.now() - Date.parse(String(r.finished_at)) > 86400000 ||
        !JSON.parse(String(r.coverage)).identityResolved
      )
        return false;
    }
    return true;
  }
  beginSync(shop: string, partition: "draft" | "normal") {
    const id = randomUUID();
    this.store.db
      .prepare("INSERT INTO sync_runs VALUES(?,?,?,?,?,?,?,?)")
      .run(
        id,
        shop,
        partition,
        "running",
        new Date().toISOString(),
        null,
        "{}",
        null,
      );
    return id;
  }
  finishSync(
    id: string,
    rows: Array<{
      itemId: string;
      code: string;
      title: string;
      status: string;
      sku?: string;
    }>,
    complete: boolean,
    error?: string,
  ) {
    return this.store.tx(() => {
      const run = this.store.db
        .prepare("SELECT * FROM sync_runs WHERE id=? AND status='running'")
        .get(id);
      if (!run)
        throw new PipelineError("NEEDS_INPUT", "同步运行不存在或已结束");
      const seen = new Set<string>();
      for (const row of rows) {
        if (
          !/^\d+$/.test(row.itemId) ||
          !/^\d+$/.test(row.code) ||
          seen.has(row.itemId)
        )
          throw new PipelineError("UI_CHANGED", "目录缺少有效身份或存在重复项");
        seen.add(row.itemId);
        this.store.db
          .prepare(
            `INSERT INTO remote_inventory VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(shop,item_id)
          DO UPDATE SET code=excluded.code,sku=excluded.sku,title=excluded.title,status=excluded.status,
          snapshot=excluded.snapshot,observed_at=excluded.observed_at,run_id=excluded.run_id`,
          )
          .run(
            String(run.shop),
            row.itemId,
            row.code,
            row.sku && /^\d+$/.test(row.sku) ? row.sku : null,
            row.title,
            row.status,
            JSON.stringify(row),
            new Date().toISOString(),
            id,
          );
      }
      this.store.db
        .prepare(
          "UPDATE sync_runs SET status=?,finished_at=?,coverage=?,error=? WHERE id=?",
        )
        .run(
          error ? "failed" : complete ? "complete" : "partial",
          new Date().toISOString(),
          JSON.stringify({
            rows: rows.length,
            identityResolved: rows.every((r) => !!r.sku),
          }),
          error ?? null,
          id,
        );
      return {
        id,
        complete: complete && !error,
        rows: rows.length,
        unresolved: rows.filter((r) => !r.sku).length,
      };
    });
  }
}
