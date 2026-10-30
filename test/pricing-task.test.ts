import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.js";
import { MarketScan } from "../src/market-scan.js";
import { PricingTasks } from "../src/pricing-task.js";
import { example } from "../src/demo.js";
function fixture() {
  const s = new Store(":memory:"),
    { product } = example(),
    shop = "ours";
  const row = s.put(shop, product),
    m = new MarketScan(s),
    run = m.start(shop, "brand");
  m.save(run, {
    url: "https://b.csgmall.com.cn/mall-view/product/search?keyword=brand",
    page: 1,
    total: 1,
    last: true,
    checkedAt: new Date().toISOString(),
    rows: [
      {
        itemId: "123",
        title: "different",
        url: "https://b.csgmall.com.cn/mall-view/product/detail?itemId=123",
        shopId: "other",
        shopName: "other",
        minimum: "1",
        free: "是",
        skus: [{ skuId: "1231001", title: "different", price: "20" }],
      },
    ],
  });
  return { s, row, run, shop };
}
test("review task creation is idempotent and candidate decisions survive reopening", () => {
  const { s, row, run, shop } = fixture();
  try {
    const p = new PricingTasks(s),
      id = p.start(shop, row.id, "own", [run]);
    assert.equal(p.start(shop, row.id, "own", [run]), id);
    p.update(id, "1231001", { match: "different", evidence: ["不同包装"] });
    assert.equal(new PricingTasks(s).status(id).reviewed, 1);
  } finally {
    s.close();
  }
});
test("unknown candidates and exact matches without detail receipts cannot finalize", () => {
  const { s, row, run, shop } = fixture();
  try {
    const p = new PricingTasks(s),
      id = p.start(shop, row.id, "own", [run]);
    assert.throws(() => p.finalize(id), /尚未/);
    assert.throws(
      () =>
        p.update(id, "1231001", {
          match: "exact",
          evidence: ["相似标题"],
          unconditional: true,
          shippingKnown: true,
        }),
      /详情/,
    );
  } finally {
    s.close();
  }
});
test("changed source identity invalidates saved candidate judgments", () => {
  const { s, row, run, shop } = fixture();
  try {
    const p = new PricingTasks(s),
      id = p.start(shop, row.id, "own", [run]);
    p.update(id, "1231001", { match: "different", evidence: ["不同包装"] });
    const product = structuredClone(row.product!);
    product.title.value += "修改";
    s.put(shop, product);
    assert.throws(() => p.finalize(id), /资料已变化/);
  } finally {
    s.close();
  }
});

test("final price comes from bound detail receipt and finalization is idempotent", async () => {
  const { MarketDetails } = await import("../src/market-details.js");
  const { s, row, run, shop } = fixture();
  try {
    const tasks = new PricingTasks(s),
      id = tasks.start(shop, row.id, "own", [run]);
    const detail = new MarketDetails(s).save(shop, "123", "other", {
      code: 0,
      data: {
        itemId: "123",
        itemPublishVo: {
          id: "123",
          shopId: "other",
          brandName: "品牌",
          saleStatus: 60,
        },
        itemSkuInfoList: [
          {
            id: "1231001",
            itemId: "123",
            shopId: "other",
            skuName: "商品",
            sellPrice: 19,
            inventory: 10,
            skuStatus: 1,
            skuShelfStatus: 20,
          },
        ],
      },
    });
    tasks.update(id, "1231001", {
      match: "exact",
      evidence: ["已核对完整销售包装"],
      receiptId: detail,
      unconditional: true,
      shippingKnown: true,
    });
    const first = tasks.finalize(id);
    assert.equal(first.decision?.value, "18.99");
    assert.equal(tasks.finalize(id).reviewId, first.reviewId);
    assert.equal(
      s.db.prepare("SELECT COUNT(*) n FROM price_reviews").get()?.n,
      1,
    );
    assert.throws(
      () =>
        tasks.update(id, "1231001", { match: "different", evidence: ["变更"] }),
      /不可改写/,
    );
  } finally {
    s.close();
  }
});

test("old search coverage cannot create a fresh decision even when every result belongs to us", (t) => {
  const { s, row, run, shop } = fixture();
  try {
    const p = new PricingTasks(s),
      id = p.start(shop, row.id, "other", [run]);
    t.mock.timers.enable({ apis: ["Date"], now: Date.now() + 7200000 });
    assert.throws(() => p.finalize(id), /过期/);
    assert.equal(
      s.db.prepare("SELECT COUNT(*) n FROM price_reviews").get()?.n,
      0,
    );
  } finally {
    t.mock.timers.reset();
    s.close();
  }
});
