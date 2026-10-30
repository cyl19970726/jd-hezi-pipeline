import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.js";
import { Catalog } from "../src/catalog.js";
import { Discovery } from "../src/discovery.js";
import { Jobs } from "../src/jobs.js";
import { brandProgress } from "../src/brand-progress.js";
function fixture() {
  const s = new Store(":memory:");
  new Catalog(s);
  new Discovery(s);
  new Jobs(s, "ours");
  const now = "2026-09-10T00:00:00.000Z";
  for (const [brand, shop, end] of [
    ["a", "ours", "2027-01-01"],
    ["b", "ours", "2027-01-01"],
    ["expired", "ours", "2025-01-01"],
    ["foreign", "other", "2027-01-01"],
  ]) {
    s.db
      .prepare("INSERT INTO catalog_brands VALUES(?,?,?,?,?)")
      .run(shop, brand, brand, "https://example.com", now);
    s.db
      .prepare("INSERT INTO catalog_categories VALUES(?,?,NULL,?,?,1,?,?)")
      .run(shop, brand, brand, brand, "https://example.com", now);
    s.db
      .prepare("INSERT INTO catalog_grants VALUES(?,?,?,'approved',?,?,?,?)")
      .run(
        shop,
        brand,
        brand,
        "2024-01-01T00:00:00.000Z",
        end + "T00:00:00.000Z",
        "https://example.com",
        now,
      );
    s.db
      .prepare("INSERT INTO catalog_scopes VALUES(?,?,?,1)")
      .run(shop, brand, brand);
  }
  return { s, now: Date.parse(now) };
}
test("all currently authorized brands appear before any discovery task exists", () => {
  const { s, now } = fixture();
  try {
    const p = brandProgress(s, "ours", now);
    assert.deepEqual(
      p.rows.map((x) => x.brandId),
      ["a", "b"],
    );
    assert.equal(p.notStarted, 2);
    assert.ok(p.rows.every((x) => x.sourceStatus === "not-started"));
  } finally {
    s.close();
  }
});
test("blocked source retains checkpoint counts and cannot become whole-brand completion", () => {
  const { s, now } = fixture();
  try {
    s.db.prepare("INSERT INTO discovery_runs VALUES(?,?,?,?,?,?)").run(
      "run",
      JSON.stringify({
        shop: "ours",
        brandId: "a",
        jdShopId: "jd",
        seeds: ["one"],
        shopName: "store",
        verifiedAt: new Date(now).toISOString(),
      }),
      "variants",
      new Date(now).toISOString(),
      new Date(now).toISOString(),
      "需要验证",
    );
    s.db
      .prepare("INSERT INTO discovery_skus VALUES(?,?,?,?,?)")
      .run("run", "123", "verified", "{}", null);
    s.db
      .prepare("INSERT INTO discovery_skus VALUES(?,?,?,?,?)")
      .run("run", "456", "pending", null, null);
    const p = brandProgress(s, "ours", now);
    assert.equal(p.started, 1);
    assert.equal(p.rows[0].sourceStatus, "blocked");
    assert.equal(p.rows[0].verifiedSkus, 1);
    assert.equal(p.rows[0].pendingSkus, 1);
    assert.deepEqual(p.rows[0].reasons, ["需要验证"]);
    assert.equal(p.rows[0].coverage, "selected-sources-only");
  } finally {
    s.close();
  }
});
test("done job alone does not count as verified submission or on-sale", () => {
  const { s, now } = fixture();
  try {
    const j = new Jobs(s, "ours").enqueue(["123"], {
      brandId: "a",
      categoryId: "a",
      policyId: "p",
      unit: "件",
      through: "submit",
    }).items[0];
    s.db.prepare("UPDATE jobs SET status='DONE' WHERE id=?").run(j.id);
    const p = brandProgress(s, "ours", now);
    assert.equal(p.rows[0].jobs, 1);
    assert.equal(p.rows[0].submitted, 0);
    assert.equal(p.rows[0].onSale, 0);
  } finally {
    s.close();
  }
});

test("a newer scan supersedes the same source scope, while other scopes remain visible", () => {
  const { s, now } = fixture();
  try {
    for (const [id, seed, updated, status] of [
      ["old", "one", "2026-09-09", "complete-source"],
      ["new", "one", "2026-09-10", "variants"],
      ["other", "two", "2026-09-10", "complete-source"],
    ]) {
      s.db.prepare("INSERT INTO discovery_runs VALUES(?,?,?,?,?,NULL)").run(
        id,
        JSON.stringify({
          shop: "ours",
          brandId: "a",
          jdShopId: "jd",
          seeds: [seed],
          shopName: "store",
          verifiedAt: new Date(now).toISOString(),
        }),
        status,
        updated,
        updated,
      );
      s.db
        .prepare("INSERT INTO discovery_skus VALUES(?,?,?,?,NULL)")
        .run(id, id === "old" ? "999" : "123", "verified", "{}");
    }
    const r = brandProgress(s, "ours", now).rows[0];
    assert.equal(r.sources.length, 2);
    assert.equal(r.verifiedSkus, 1);
    assert.equal(r.sourceStatus, "discovering");
  } finally {
    s.close();
  }
});

test("completed submission still exposes platform review warning independently", async () => {
  const { s, now } = fixture();
  const { example } = await import("../src/demo.js");
  try {
    const { product, plan } = example();
    plan.shop = "ours";
    plan.catalogBinding = { brandId: "a", categoryId: "a" };
    const row = s.put("ours", product);
    s.setPlan(row.id, plan);
    s.bind(row.id, "123", "123");
    s.verified(row.id, s.get(row.id).dataHash);
    s.state(row.id, "SUBMITTED");
    const jobs = new Jobs(s, "ours"),
      job = jobs.enqueue([product.sku], {
        brandId: "a",
        categoryId: "a",
        policyId: "p",
        unit: "件",
        through: "submit",
      }).items[0];
    jobs.update(job.id, "DONE", "done", null, row.id);
    s.setMeta("platform-warning:123", { message: "价格锁定" });
    const result = brandProgress(s, "ours", now).rows[0];
    assert.equal(result.submitted, 1);
    assert.equal(result.platformNeedsReview, 1);
    assert.deepEqual(result.jobReasons, ["平台提示：价格锁定"]);
    assert.equal(result.onSale, 0);
  } finally {
    s.close();
  }
});
