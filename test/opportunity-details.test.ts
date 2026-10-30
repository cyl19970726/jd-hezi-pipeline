import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hydrateOpportunityDetails } from "../src/browser/opportunity-details.js";
import { MarketDetails } from "../src/market-details.js";
import { Store } from "../src/store.js";

const identity = {
  opportunityId: "opp-1",
  itemId: "123",
  skuId: "1231001",
  marketShopId: "other",
};
const raw = () => ({
  code: "0",
  data: {
    itemId: "123",
    itemPublishVo: {
      id: "123",
      shopId: "other",
      brandName: "示例乙品牌",
      brandId: 234,
      cid: "512",
      categoryFullName: "日用百货>驱蚊用品",
      saleStatus: 60,
    },
    itemSkuInfoList: [
      {
        id: "1231001",
        itemId: "123",
        shopId: "other",
        skuName: "两支装",
        sellPrice: 37.9,
        inventory: 100,
        skuStatus: 1,
        skuShelfStatus: 20,
        skuUnit: "盒",
        attributesName: "香型:无香",
        skuPicUrls: [
          { url: "https://item.jd.com/900000000001.html?from=market" },
        ],
      },
    ],
  },
});

function page(
  url = "https://b.csgmall.com.cn/mall-view/product/detail?itemId=123",
) {
  const calls: string[] = [];
  return {
    calls,
    async url() {
      return url;
    },
    async cdp(method: string, input: any) {
      calls.push(method);
      if (method === "Page.addScriptToEvaluateOnNewDocument") return {};
      if (input.expression.includes("queryNormalItemDetails"))
        return { result: { value: raw() } };
      return { result: { value: { installed: true } } };
    },
  };
}

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "hezi-opportunity-details-"));
  return { dir, database: join(dir, "state.sqlite") };
}

test("hydrates an explicit opportunity with a durable receipt and separates suggestions", async () => {
  const f = await fixture();
  try {
    const p = page();
    let healthChecks = 0;
    const result = await hydrateOpportunityDetails(
      p,
      { shop: "ours" } as any,
      { database: f.database, opportunities: [identity] },
      async () => {
        healthChecks++;
      },
    );
    assert.equal(result.receipts.length, 1);
    const receipt = result.receipts[0];
    assert.match(receipt.receiptId, /^[a-f0-9]{64}$/);
    assert.equal(receipt.verified.itemPublishVo.brandName, "示例乙品牌");
    assert.equal(receipt.verified.itemPublishVo.brandId, "234");
    assert.equal(receipt.verified.itemPublishVo.cid, "512");
    assert.equal(
      receipt.verified.itemPublishVo.categoryFullName,
      "日用百货>驱蚊用品",
    );
    assert.equal(receipt.verified.sku.unit, "盒");
    assert.equal(receipt.verified.sku.attributes, "香型:无香");
    assert.deepEqual(receipt.verified.sku.sourceSkus, ["900000000001"]);
    assert.deepEqual(receipt.suggestions.jdItemLinks, [
      "https://item.jd.com/900000000001.html",
    ]);
    assert.equal(receipt.suggestions.reviewRequired, true);
    assert.equal(healthChecks, 3);
    const s = new Store(f.database);
    try {
      assert.deepEqual(
        s.db
          .prepare("SELECT shop,kind,outcome FROM traffic_log ORDER BY id")
          .all()
          .map((row) => ({ ...row })),
        [{ shop: "ours", kind: "opportunity-detail", outcome: "ok" }],
      );
    } finally {
      s.close();
    }
    assert.deepEqual(p.calls, [
      "Page.addScriptToEvaluateOnNewDocument",
      "Runtime.evaluate",
      "Runtime.evaluate",
    ]);
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

test("reuses a compatible fresh receipt without a detail request", async () => {
  const f = await fixture();
  const s = new Store(f.database);
  try {
    new MarketDetails(s).save("ours", "123", "other", raw());
    const p = page();
    const result = await hydrateOpportunityDetails(
      p,
      { shop: "ours" } as any,
      { database: f.database, opportunities: [identity] },
      async () => {},
    );
    assert.equal(result.receipts[0].cache, "fresh-cache");
    assert.equal(
      result.receipts[0].verified.itemPublishVo.categoryFullName,
      "日用百货>驱蚊用品",
    );
    assert.equal(p.calls.filter((x) => x === "Runtime.evaluate").length, 1);
  } finally {
    s.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test("rejects a non-mall origin before installing a request hook", async () => {
  const f = await fixture();
  try {
    const p = page("https://example.test/mall-view/product/detail?itemId=123");
    await assert.rejects(
      hydrateOpportunityDetails(
        p,
        { shop: "ours" } as any,
        { database: f.database, opportunities: [identity] },
        async () => {},
      ),
      /csgmall/,
    );
    assert.deepEqual(p.calls, []);
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

test("bounds each round and rejects a response missing the selected SKU", async () => {
  const f = await fixture();
  try {
    const p = page();
    await assert.rejects(
      hydrateOpportunityDetails(
        p,
        { shop: "ours" } as any,
        { database: f.database, opportunities: [identity], limit: 4 },
        async () => {},
      ),
      /最多三个/,
    );
    await assert.rejects(
      hydrateOpportunityDetails(
        page(),
        { shop: "ours" } as any,
        {
          database: f.database,
          opportunities: [{ ...identity, skuId: "missing" }],
        },
        async () => {},
      ),
      /SKU/,
    );
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

test("inventory list can transition to the explicit market SKU under the shared budget; editors stay protected", async () => {
  const f = await fixture();
  const listUrl =
    "https://b.csgmall.com.cn/shop-view/#/shop-view/goods/goods-manage";
  try {
    let current = listUrl;
    let navigations = 0;
    const p = {
      ...page(),
      url: async () => current,
      goto: async (url: string) => {
        navigations++;
        current = url;
      },
      waitForFunction: async () => {},
    };
    await hydrateOpportunityDetails(
      p,
      { shop: "ours", listUrl } as any,
      { database: f.database, opportunities: [identity] },
      async () => {},
    );
    assert.equal(navigations, 1);
    assert.equal(
      current,
      "https://b.csgmall.com.cn/mall-view/product/detail?itemId=123&skuId=1231001",
    );
    const store = new Store(f.database);
    assert.equal(
      store.db
        .prepare(
          "SELECT COUNT(*) n FROM traffic_log WHERE kind='opportunity-workspace'",
        )
        .get()?.n,
      1,
    );
    store.close();
    current = "https://b.csgmall.com.cn/shop-view/#/shop-view/brand/regulate";
    await hydrateOpportunityDetails(
      p,
      { shop: "ours", listUrl } as any,
      { database: f.database, opportunities: [identity] },
      async () => {},
    );
    assert.equal(navigations, 2);
    current =
      "https://b.csgmall.com.cn/shop-view/#/shop-view/goods/publish?new=1";
    await assert.rejects(
      hydrateOpportunityDetails(
        p,
        { shop: "ours", listUrl } as any,
        { database: f.database, opportunities: [identity] },
        async () => {},
      ),
      /mall-view/,
    );
    assert.equal(navigations, 2);
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});
