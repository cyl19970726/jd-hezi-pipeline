import test from "node:test";
import assert from "node:assert/strict";
import {
  parseAnalyticsShopPage,
  readAnalyticsShopPage,
  type AnalyticsShopPageArgs,
} from "../src/browser/analytics-collection.js";

const args: AnalyticsShopPageArgs = {
  database: ":memory:",
  shopId: "1000020",
  page: 1,
  pageSize: 30,
};
const sku = (overrides: Record<string, unknown> = {}) => ({
  shopId: 1000020,
  itemId: "900000000002",
  skuId: "9000000000020001",
  skuName: "维达 有芯卷纸 180g/卷 10卷/提 单位：提",
  saleUnit: "提",
  saleCount: 8783,
  sellPrice: 26.9,
  brandId: 59,
  buyerName: "must not persist",
  ...overrides,
});
const response = (
  groups = [{ itemSkuInfo: [sku()] }],
  overrides: any = {},
) => ({
  code: "0",
  data: {
    totalCount: groups.length,
    totalPages: 1,
    brandNameList: ["维达(Vinda)"],
    itemList: { page: 1, pageSize: 30, resultList: groups },
    ...overrides,
  },
});

test("parses the verified response into privacy-minimal analytics observations", () => {
  const result = parseAnalyticsShopPage(
    response(),
    args,
    "2026-09-19T00:00:00Z",
  );
  assert.equal(result.completeScope, true);
  assert.equal(result.countSemantics, "item-groups");
  assert.equal(result.totalCount, 1);
  assert.equal(result.observations[0].priceMinor, 2690);
  assert.equal(result.observations[0].packaging, sku().skuName);
  assert.equal(result.observations[0].sourceEntry, "hezi-shop-list-v1");
  assert.equal(result.observations[0].field, "saleCount");
  assert.equal((result.observations[0].raw as any).buyerName, undefined);
});

test("rejects response shop attribution mismatch", () => {
  assert.throws(
    () =>
      parseAnalyticsShopPage(
        response([{ itemSkuInfo: [sku({ shopId: 9 })] }]),
        args,
      ),
    /differs from requested shopId/,
  );
});

test("rejects unsafe identities and missing required fields", () => {
  assert.throws(
    () =>
      parseAnalyticsShopPage(
        response([{ itemSkuInfo: [sku({ skuId: "1 OR 1=1" })] }]),
        args,
      ),
    /skuId is unsafe/,
  );
  assert.throws(
    () =>
      parseAnalyticsShopPage(
        response([{ itemSkuInfo: [sku({ saleUnit: "" })] }]),
        args,
      ),
    /saleUnit is missing/,
  );
  assert.throws(
    () => parseAnalyticsShopPage(response([{ itemSkuInfo: [] }]), args),
    /missing itemSkuInfo/,
  );
});

test("rejects page and count contract mismatches", () => {
  assert.throws(
    () => parseAnalyticsShopPage(response([], { totalCount: 1 }), args),
    /non-zero totalCount returned an empty/,
  );
  assert.throws(
    () =>
      parseAnalyticsShopPage(
        response(undefined, {
          itemList: { page: 2, pageSize: 30, resultList: [] },
        }),
        args,
      ),
    /response page 2 differs/,
  );
  assert.throws(
    () => parseAnalyticsShopPage(response(undefined, { totalPages: 2 }), args),
    /totalPages conflicts/,
  );
});

test("declares item-group coverage independently from SKU observation count", () => {
  const result = parseAnalyticsShopPage(
    response([{ itemSkuInfo: [sku(), sku({ skuId: "9000000000020002" })] }]),
    args,
  );
  assert.equal(result.groupCount, 1);
  assert.equal(result.skuCount, 2);
  assert.equal(result.coverageCount, 1);
  assert.equal(result.completeScope, true);
});

test("reader health-checks, installs the hook, and makes one verified GET without navigation", async () => {
  const calls: string[] = [];
  const page = {
    async url() {
      return "https://b.csgmall.com.cn/mall-view/shop?shopId=1000020&type=1";
    },
    async cdp(method: string, input: any) {
      calls.push(method);
      if (method === "Page.addScriptToEvaluateOnNewDocument") return {};
      if (input.expression.includes("queryShopItemListByKeyword")) {
        assert.match(input.expression, /'GET'/);
        assert.match(input.expression, /"pageNum":1/);
        return { result: { value: response() } };
      }
      return { result: { value: { installed: true } } };
    },
  };
  let healthChecks = 0;
  const result = await readAnalyticsShopPage(
    page,
    { shop: "ours" } as any,
    args,
    async () => {
      healthChecks++;
    },
  );
  assert.equal(result.observations.length, 1);
  assert.equal(healthChecks, 2);
  assert.deepEqual(calls, [
    "Page.addScriptToEvaluateOnNewDocument",
    "Runtime.evaluate",
    "Runtime.evaluate",
  ]);
  assert.equal("goto" in page, false);
});

test("reader rejects foreign domains without binding queries to the visible public shop", async () => {
  let requests = 0;
  const makePage = (url: string) => ({
    async url() {
      return url;
    },
    async cdp() {
      requests++;
      return {};
    },
  });
  await assert.rejects(
    readAnalyticsShopPage(
      makePage("https://example.com/mall-view/shop"),
      { shop: "ours" } as any,
      args,
      async () => {},
    ),
    /csgmall/,
  );
  assert.equal(requests, 0);
});

test("reader rejects a missing configured shop before installing hooks or requests", async () => {
  let calls = 0;
  await assert.rejects(
    readAnalyticsShopPage(
      {
        async url() {
          return "https://b.csgmall.com.cn/mall-view/shop?shopId=1000020";
        },
        async cdp() {
          calls++;
          return {};
        },
      },
      {} as any,
      args,
      async () => {},
    ),
    /configured shop is missing/,
  );
  assert.equal(calls, 0);
});
