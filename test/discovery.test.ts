import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.js";
import { Discovery, type Source } from "../src/discovery.js";
const seed = "https://mall.jd.com/view_search-1-2-99-1-20-1.html";
const source: Source = {
  shop: "shop",
  brandId: "hz",
  jdBrandId: "jd",
  jdShopId: "store",
  shopName: "官方店",
  kind: "self-operated",
  evidenceUrl: "https://item.jd.com/1.html",
  verifiedAt: new Date().toISOString(),
  seeds: [seed],
};
const data = (sku: string) => ({
  url: seed,
  shopId: "store",
  pageNumber: 1,
  totalPages: 1,
  totalProducts: 1,
  nextUrl: null,
  lastPageConfirmed: true,
  rows: [{ sku, url: `https://item.jd.com/${sku}.html`, title: "商品" }],
  capturedAt: new Date().toISOString(),
});
const variant = (sku: string, other: string) => ({
  sku,
  shopId: "store",
  shopName: "官方店",
  selfOperated: true,
  jdBrandId: "jd",
  brandName: "品牌",
  url: `https://item.jd.com/${sku}.html`,
  capturedAt: new Date().toISOString(),
  variants: [{ sku: other, hint: "规格" }],
});
test("durable discovery resumes at the next variant, deduplicates families and excludes wrong-brand siblings", () => {
  const s = new Store(":memory:");
  try {
    const d = new Discovery(s),
      id = d.start(source);
    d.savePage(id, seed, data("1"));
    d.saveSku(id, "1", variant("1", "2"));
    const resumed = new Discovery(s);
    assert.equal(resumed.next(id).sku, "2");
    resumed.saveSku(id, "2", { ...variant("2", "3"), jdBrandId: "other" });
    assert.equal(resumed.next(id), null);
    assert.equal(resumed.finish(id).status, "complete-source");
    assert.equal(
      s.db.prepare("select count(*) as n from discovery_skus").get()?.n,
      2,
    );
  } finally {
    s.close();
  }
});
test("a missing final-page signal, count drift or foreign store cannot advance a page", () => {
  const s = new Store(":memory:");
  try {
    const d = new Discovery(s),
      id = d.start(source);
    for (const change of [
      { lastPageConfirmed: false },
      { totalProducts: 2 },
      { shopId: "other" },
    ])
      assert.throws(() => d.savePage(id, seed, { ...data("1"), ...change }));
    assert.equal(d.next(id).kind, "page");
    assert.throws(() => d.finish(id));
  } finally {
    s.close();
  }
});
test("blocked SKU remains visible and prevents a claim of complete source coverage", () => {
  const s = new Store(":memory:");
  try {
    const d = new Discovery(s),
      id = d.start(source);
    d.savePage(id, seed, data("1"));
    d.blockSku(id, "1", "没有规格证据");
    assert.equal(d.finish(id).status, "needs-review");
  } finally {
    s.close();
  }
});
