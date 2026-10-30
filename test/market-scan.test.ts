import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.js";
import { MarketScan, type MarketPage } from "../src/market-scan.js";
function page(n: number, id: string, last = false): MarketPage {
  return {
    page: n,
    total: 2,
    last,
    checkedAt: new Date().toISOString(),
    url: "https://b.csgmall.com.cn/mall-view/product/search?keyword=示例甲品牌",
    rows: [
      {
        itemId: id,
        title: "商品",
        url: "https://b.csgmall.com.cn/mall-view/product/detail?itemId=" + id,
        shopId: "other",
        shopName: "商家",
        minimum: "1",
        free: "是",
        skus: [{ skuId: id + "1001", title: "商品", price: "10.00" }],
      },
    ],
  };
}
test("market scan resumes durable page boundary and only completes with count agreement", () => {
  const s = new Store(":memory:");
  try {
    const scan = new MarketScan(s),
      id = scan.start("ours", "示例甲品牌");
    scan.save(id, page(1, "a"));
    const resumed = new MarketScan(s);
    assert.equal(resumed.get(id).next_page, 2);
    resumed.save(id, page(2, "b", true));
    assert.equal(resumed.get(id).status, "complete");
  } finally {
    s.close();
  }
});
test("duplicate or changing result pages cannot falsely complete coverage", () => {
  const s = new Store(":memory:");
  try {
    const scan = new MarketScan(s),
      id = scan.start("ours", "示例甲品牌");
    scan.save(id, page(1, "a"));
    assert.throws(() => scan.save(id, page(2, "a", true)), /重复/);
    assert.throws(
      () => scan.save(id, { ...page(2, "b", true), total: 3 }),
      /总量/,
    );
    assert.equal(scan.get(id).next_page, 2);
  } finally {
    s.close();
  }
});
test("platform duplicate rows count as result slots but retain one product identity", () => {
  const s = new Store(":memory:");
  try {
    const scan = new MarketScan(s),
      id = scan.start("ours", "示例甲品牌"),
      p = page(1, "a", true);
    p.rows.push({
      ...p.rows[0],
      skus: [{ skuId: "a1002", title: "其他规格", price: "20.00" }],
    });
    scan.save(id, p);
    const status = scan.list("ours")[0];
    assert.equal(status.seen, 2);
    assert.equal(status.uniqueItems, 1);
    assert.equal(status.status, "complete");
  } finally {
    s.close();
  }
});
test("last-page discrepancy is saved as review-needed rather than losing the checkpoint", () => {
  const s = new Store(":memory:");
  try {
    const scan = new MarketScan(s),
      id = scan.start("ours", "示例甲品牌");
    scan.save(id, page(1, "a", true));
    assert.equal(scan.get(id).status, "needs-review");
    assert.equal(scan.pages(id).length, 1);
  } finally {
    s.close();
  }
});

test("a page missing sale SKU identities cannot advance the checkpoint", () => {
  const s = new Store(":memory:");
  try {
    const scan = new MarketScan(s),
      id = scan.start("ours", "示例甲品牌"),
      p = page(1, "a");
    p.rows[0].skus = [];
    assert.throws(() => scan.save(id, p), /SKU/);
    assert.equal(scan.get(id).next_page, 1);
    assert.equal(scan.pages(id).length, 0);
  } finally {
    s.close();
  }
});

test("detail grouping keeps all sales SKUs of repeated item IDs", async () => {
  const { marketItems } = await import("../src/market-scan.js");
  const a = page(1, "a"),
    b = page(2, "a", true);
  b.rows[0].skus = [{ skuId: "a1002", title: "另一规格", price: "20" }];
  const rows = marketItems([a, b]);
  assert.equal(rows.length, 1);
  assert.deepEqual(
    rows[0].skus.map((s) => s.skuId),
    ["a1001", "a1002"],
  );
});
