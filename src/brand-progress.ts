import { Store } from "./store.js";
/** Read-only projection: authorization is the denominator, never just created jobs. */
export function brandProgress(store: Store, shop: string, now = Date.now()) {
  const at = new Date(now).toISOString();
  const brands = store.db
    .prepare(
      `SELECT DISTINCT b.id,b.name FROM catalog_brands b
 JOIN catalog_grants g ON g.shop=b.shop AND g.brand_id=b.id
 JOIN catalog_scopes c ON c.shop=g.shop AND c.grant_id=g.id
 WHERE b.shop=? AND g.status='approved' AND g.valid_from<=? AND g.valid_until>=? ORDER BY b.name,b.id`,
    )
    .all(shop, at, at);
  const runs = store.db
    .prepare("SELECT * FROM discovery_runs ORDER BY updated_at DESC,id DESC")
    .all()
    .map((r) => ({
      id: r.id,
      status: r.status,
      error: r.error,
      updated_at: r.updated_at,
      source: JSON.parse(String(r.source_json)),
    }))
    .filter((r) => r.source.shop === shop);
  const skuRows = store.db
    .prepare("SELECT run_id,sku,status FROM discovery_skus")
    .all();
  const pageRows = store.db
    .prepare(
      "SELECT run_id,status,count(*) n FROM discovery_pages GROUP BY run_id,status",
    )
    .all();
  const jobs = store.db
    .prepare(
      `SELECT j.*,p.state AS remote_state,p.remote_id,p.data_hash,p.verified_hash,p.plan
 FROM jobs j LEFT JOIN products p ON p.id=j.product_id AND p.shop=j.shop WHERE j.shop=?`,
    )
    .all(shop)
    .map((j) => ({
      status: j.status,
      error: j.error,
      remote_id: j.remote_id,
      remote_state: j.remote_state,
      verified_hash: j.verified_hash,
      data_hash: j.data_hash,
      recipe: JSON.parse(String(j.recipe)),
      plan: j.plan ? JSON.parse(String(j.plan)) : null,
    }));
  const rows = brands.map((b) => {
    // A rerun of the same shop/category scope supersedes its earlier scan, without merging stale receipts.
    const selected = new Map<string, (typeof runs)[number]>();
    for (const run of runs.filter((r) => r.source.brandId === b.id)) {
      const key = JSON.stringify([
        run.source.jdShopId,
        [...run.source.seeds].sort(),
      ]);
      if (!selected.has(key)) selected.set(key, run);
    }
    const sources = [...selected.values()],
      ids = new Set(sources.map((r) => r.id));
    const records = skuRows.filter((r) => ids.has(r.run_id));
    const statuses = new Map<string, string>();
    const priority = ["excluded", "pending", "blocked", "verified"];
    for (const record of records) {
      const sku = String(record.sku),
        status = String(record.status);
      if (priority.indexOf(status) > priority.indexOf(statuses.get(sku) ?? ""))
        statuses.set(sku, status);
    }
    const count = (status: string) =>
      [...statuses.values()].filter((s) => s === status).length;
    const reasons = [
      ...new Set(
        sources.flatMap((r) => [
          ...(r.error ? [String(r.error)] : []),
          ...(now - Date.parse(r.source.verifiedAt) > 86400000
            ? ["来源店铺身份需重新核验"]
            : []),
        ]),
      ),
    ];
    const blocked = count("blocked");
    const sourceStatus = !sources.length
      ? "not-started"
      : reasons.length ||
          blocked ||
          sources.some((r) => r.status === "needs-review")
        ? "blocked"
        : sources.every((r) => r.status === "complete-source")
          ? "selected-sources-complete"
          : "discovering";
    const tasks = jobs.filter((j) => j.recipe.brandId === b.id);
    const platformWarnings = tasks
      .filter((j) => j.remote_id)
      .map((j) => store.meta("platform-warning:" + j.remote_id))
      .filter((w) => w?.message);
    const remote = (state: string) =>
      tasks.filter(
        (j) =>
          j.remote_id &&
          j.verified_hash === j.data_hash &&
          j.plan?.catalogBinding?.brandId === b.id &&
          j.remote_state === state,
      ).length;
    return {
      brandId: String(b.id),
      name: String(b.name),
      sourceStatus,
      coverage: sources.length ? "selected-sources-only" : "none",
      sources: sources.map((r) => ({
        id: String(r.id),
        shopName: String(r.source.shopName),
        seeds: r.source.seeds,
        updatedAt: String(r.updated_at),
      })),
      pagesRead: pageRows
        .filter((r) => ids.has(r.run_id) && r.status === "done")
        .reduce((n, r) => n + Number(r.n), 0),
      verifiedSkus: count("verified"),
      pendingSkus: count("pending"),
      blockedSkus: blocked,
      excludedSkus: count("excluded"),
      reasons,
      jobs: tasks.length,
      platformNeedsReview: platformWarnings.length,
      queued: tasks.filter((j) =>
        ["RUNNING", "QUEUED"].includes(String(j.status)),
      ).length,
      needsInput: tasks.filter((j) =>
        ["NEEDS_INPUT", "UNKNOWN_OUTCOME"].includes(String(j.status)),
      ).length,
      jobReasons: [
        ...platformWarnings.map((w) => `平台提示：${w.message}`),
        ...new Set(
          tasks
            .filter(
              (j) =>
                ["NEEDS_INPUT", "UNKNOWN_OUTCOME"].includes(String(j.status)) &&
                j.error,
            )
            .map((j) => String(j.error)),
        ),
      ],
      submitted: remote("SUBMITTED"),
      approved: remote("APPROVED"),
      onSale: remote("ON_SALE"),
    };
  });
  return {
    checkedAt: at,
    authorizedBrands: rows.length,
    started: rows.filter((r) => r.sources.length).length,
    notStarted: rows.filter((r) => !r.sources.length).length,
    blocked: rows.filter((r) => r.sourceStatus === "blocked").length,
    rows,
  };
}
