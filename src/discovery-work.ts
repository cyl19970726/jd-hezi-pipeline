import { Store } from "./store.js";
import { Discovery } from "./discovery.js";
import { SourceIndex } from "./source-index.js";
import { Jobs, type Recipe } from "./jobs.js";
import { Catalog } from "./catalog.js";
import { PipelineError, type RemoteRecord } from "./model.js";
/** Local planning only: absence in a valid index is not permission to publish. */
export function discoveryWork(store: Store, shop: string, runId: string) {
  const run = new Discovery(store).get(runId);
  if (run.source.shop !== shop)
    throw new PipelineError("ACCOUNT_CHANGED", "来源批次不属于当前店铺");
  const candidates = store.db
    .prepare(
      "SELECT sku,status,data_json,error FROM discovery_skus WHERE run_id=? ORDER BY sku",
    )
    .all(runId);
  const jobs = new Map(new Jobs(store, shop).list().map((j) => [j.sku, j]));
  const products = store.list().filter((p) => p.shop === shop);
  let matches = new Map<string, RemoteRecord[]>(),
    indexError: string | null = null;
  try {
    matches = new SourceIndex(store).lookupMany(
      shop,
      candidates.map((c) => String(c.sku)),
    );
  } catch (e) {
    if (!(e instanceof PipelineError) || e.code !== "NEEDS_INPUT") throw e;
    indexError = e.message;
  }
  const rows = candidates.map((c) => {
    const sku = String(c.sku),
      data = c.data_json ? JSON.parse(String(c.data_json)) : null;
    const job = jobs.get(sku),
      local = products.filter((p) => p.sku === sku);
    const remote = new Map(
      (matches.get(sku) ?? []).map((r) => [
        r.itemId,
        { itemId: r.itemId, status: r.status, source: "index" },
      ]),
    );
    for (const p of local.filter((p) => p.remoteId)) {
      const replacement = store.replacement(p.id);
      if (replacement?.status === "bound" && replacement.new_id === p.remoteId)
        remote.delete(String(replacement.old_id));
      remote.set(p.remoteId!, {
        itemId: p.remoteId!,
        status: p.state,
        source: "binding",
      });
    }
    const kind =
      c.status !== "verified"
        ? "source-" + c.status
        : remote.size > 1
          ? "duplicate"
          : job
            ? "task"
            : remote.size
              ? "existing"
              : indexError
                ? "index-required"
                : "unassigned";
    return {
      sku,
      url: `https://item.jd.com/${sku}.html`,
      specification:
        data?.variants?.find((v: any) => v.sku === sku)?.hint ?? "",
      kind,
      jobId: job?.id ?? null,
      jobStatus: job?.status ?? null,
      records: [...remote.values()],
      reason:
        kind === "duplicate"
          ? "同一京东SKU对应多个本店商品，先核对原记录"
          : kind === "unassigned"
            ? "尚无任务；需核对授权叶类目、店铺规则和商品事实后安排"
            : kind === "index-required"
              ? indexError
              : (c.error ?? null),
    };
  });
  return {
    runId,
    shop,
    brandId: run.source.brandId,
    shopName: run.source.shopName,
    sourceStatus: run.status,
    sourceError: run.error,
    sourceNeedsRecheck:
      !Number.isFinite(Date.parse(run.source.verifiedAt)) ||
      Date.parse(run.source.verifiedAt) > Date.now() + 60000 ||
      Date.now() - Date.parse(run.source.verifiedAt) > 86400000,
    indexError,
    rows,
    counts: rows.reduce<Record<string, number>>(
      (out, r) => ((out[r.kind] = (out[r.kind] ?? 0) + 1), out),
      {},
    ),
    scope: "selected-source-local-planning",
    checkedAt: new Date().toISOString(),
  };
}

/** All-or-nothing assignment. This authorizes a task, never substitutes for source facts or publishing validation. */
export function enqueueDiscovery(
  store: Store,
  shop: string,
  runId: string,
  skus: string[],
  recipe: Recipe,
) {
  if (!skus.length || skus.length > 200 || skus.some((s) => !/^\d+$/.test(s)))
    throw new PipelineError("NEEDS_INPUT", "请选择1至200个有效规格SKU");
  const work = discoveryWork(store, shop, runId);
  if (work.sourceNeedsRecheck)
    throw new PipelineError("NEEDS_INPUT", "来源店铺身份已过期，先重新核验");
  if (recipe.brandId !== work.brandId)
    throw new PipelineError("NEEDS_INPUT", "所选品牌与来源批次不一致");
  const catalog = new Catalog(store);
  const brand = store.db
    .prepare("SELECT name FROM catalog_brands WHERE shop=? AND id=?")
    .get(shop, recipe.brandId);
  const category = store.db
    .prepare("SELECT path FROM catalog_categories WHERE shop=? AND id=?")
    .get(shop, recipe.categoryId);
  catalog.authorize({
    shop,
    brand: String(brand?.name ?? ""),
    categoryPath: String(category?.path ?? ""),
    catalogBinding: { brandId: recipe.brandId, categoryId: recipe.categoryId },
  });
  for (const [table, column, id] of [
    ["category_templates", "category_id", recipe.categoryId],
    ["shop_policies", "id", recipe.policyId],
  ]) {
    const r = store.db
      .prepare(`SELECT checked_at FROM ${table} WHERE shop=? AND ${column}=?`)
      .get(shop, id);
    const at = Date.parse(String(r?.checked_at));
    if (
      !Number.isFinite(at) ||
      Date.now() - at > 86400000 ||
      at > Date.now() + 60000
    )
      throw new PipelineError("NEEDS_INPUT", "类目模板或店铺规则缺失/过期");
  }
  const jobs = new Jobs(store, shop);
  for (const sku of new Set(skus)) {
    const row = work.rows.find((r) => r.sku === sku);
    if (!row || !["unassigned", "task"].includes(row.kind))
      throw new PipelineError(
        "NEEDS_INPUT",
        `${sku}：${row?.reason ?? "规格未核验或已有赫兹商品，不能新建任务"}`,
      );
    if (row.jobId) {
      const prior = jobs.get(row.jobId).recipe;
      if (
        (Object.keys(recipe) as (keyof Recipe)[]).some(
          (k) => prior[k] !== recipe[k],
        )
      )
        throw new PipelineError(
          "NEEDS_INPUT",
          `${sku}已有任务使用不同上架规则，不能静默替换`,
        );
    }
  }
  return jobs.enqueue(skus, recipe, { runId, brandId: work.brandId });
}
