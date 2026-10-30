import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.js";
import { MarketDetails } from "../src/market-details.js";
const raw = (id = "123", shop = "other") => ({
  code: "0",
  data: {
    itemId: id,
    itemPublishVo: {
      id,
      shopId: shop,
      brandName: "示例乙品牌",
      saleStatus: 60,
    },
    itemSkuInfoList: [
      {
        id: id + "1001",
        itemId: id,
        shopId: shop,
        skuName: "两支装",
        sellPrice: 37.9,
        inventory: 100,
        skuStatus: 1,
        skuShelfStatus: 20,
        skuPicUrls: [{ url: "https://item.jd.com/900000000001.html?x=1" }],
      },
    ],
  },
});
test("cached market detail reuses fresh receipt and expires without losing evidence", () => {
  const s = new Store(":memory:");
  try {
    const m = new MarketDetails(s);
    const at = "2026-09-10T05:00:00.000Z";
    const id = m.save("ours", "123", "other", raw(), at);
    assert.equal(m.fresh("ours", "123", Date.parse(at) + 1000)?.id, id);
    assert.equal(m.fresh("ours", "123", Date.parse(at) + 3600001), null);
    assert.equal(m.get(id).itemId, "123");
  } finally {
    s.close();
  }
});
test("mismatched shop or item never enters the candidate cache", () => {
  const s = new Store(":memory:");
  try {
    const m = new MarketDetails(s);
    assert.throws(() => m.save("ours", "123", "other", raw("999")), /身份/);
    assert.throws(
      () => m.save("ours", "123", "other", raw("123", "wrong")),
      /身份/,
    );
    assert.equal(m.fresh("ours", "123"), null);
  } finally {
    s.close();
  }
});
test("only explicit JD item links are retained as SKU identity evidence", () => {
  const s = new Store(":memory:");
  try {
    const m = new MarketDetails(s),
      r = raw();
    r.data.itemSkuInfoList[0].skuPicUrls.push(
      { url: "https://item.jd.com.evil.test/456.html" },
      { url: "https://item.jd.com/123.html.invalid" },
    );
    const id = m.save("ours", "123", "other", r);
    assert.deepEqual(m.get(id).skus[0].sourceSkus, ["900000000001"]);
  } finally {
    s.close();
  }
});

test("missing selected sale SKU is rejected before caching the response", () => {
  const s = new Store(":memory:");
  try {
    const m = new MarketDetails(s);
    assert.throws(
      () =>
        m.save("ours", "123", "other", raw(), new Date().toISOString(), [
          "missing",
        ]),
      /SKU/,
    );
    assert.equal(m.fresh("ours", "123"), null);
  } finally {
    s.close();
  }
});

test("same JD identity is only a proposal; a different SKU cannot by itself exclude a competitor", async () => {
  const { sourceMatch } = await import("../src/market-details.js");
  const s = new Store(":memory:");
  try {
    const m = new MarketDetails(s),
      id = m.save("ours", "123", "other", raw());
    const d = m.get(id);
    const p = { sku: "900000000001", specs: { 品牌: { value: "示例乙品牌" } } };
    assert.equal(sourceMatch(p, d, "1231001").source, "same-jd-sku");
    assert.equal(sourceMatch(p, d, "1231001").reviewRequired, true);
    assert.equal(
      sourceMatch({ ...p, sku: "999" }, d, "1231001").source,
      "other-or-multiple-jd-skus",
    );
  } finally {
    s.close();
  }
});

test("repeating a fully cached candidate run makes no browser detail calls", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises"),
    { tmpdir } = await import("node:os"),
    { join } = await import("node:path");
  const { MarketScan } = await import("../src/market-scan.js"),
    { readMarketDetails } =
      await import("../src/browser/market-details-runner.js");
  const dir = await mkdtemp(join(tmpdir(), "hezi-quotes-")),
    database = join(dir, "state.sqlite"),
    s = new Store(database);
  try {
    const market = new MarketScan(s),
      runId = market.start("ours", "示例乙品牌");
    market.save(runId, {
      url: "https://b.csgmall.com.cn/mall-view/product/search?keyword=示例乙品牌",
      page: 1,
      total: 1,
      last: true,
      checkedAt: new Date().toISOString(),
      rows: [
        {
          itemId: "123",
          title: "两支装",
          url: "https://b.csgmall.com.cn/mall-view/product/detail?itemId=123",
          shopId: "other",
          shopName: "商家",
          minimum: "1",
          free: "是",
          skus: [{ skuId: "1231001", title: "两支装", price: "37.9" }],
        },
      ],
    });
    new MarketDetails(s).save("ours", "123", "other", raw());
    let calls = 0;
    const r = await readMarketDetails(
      {
        cdp: async () => {
          calls++;
          throw Error("不应请求");
        },
      },
      { shop: "ours" } as any,
      { database, runId },
      async () => {
        calls++;
      },
    );
    assert.equal(r.remaining, 0);
    assert.equal(r.networkDetails, 0);
    assert.equal(calls, 0);
  } finally {
    s.close();
    await rm(dir, { recursive: true, force: true });
  }
});
