import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.js";
import { SourceIndex } from "../src/source-index.js";
import {
  syncSources,
  validSourcePagination,
} from "../src/browser/source-scan.js";
import { configureHzAccessPolicy } from "../src/traffic.js";

const sourceModule = `function a(){return '/item/shop/shopItem/queryShopItemListOnlyItemInfo'}
function b(){return '/item/shop/shopItem/querySaleItemListOnlyPageSkuInfo'}
export {a,b}`;
const logisticsModule = `function a(){return '/item/shop/itemTmplPublish/queryItemInfo'}
function b(){return '/item/shop/area/config/queryAreaConfigAndBrandById'}
function c(){return '/item/seller/shops/freight/queryTemplateSkuList'}
function d(){return '/item/seller/deliveryAddress/queryConfigByItemId'}
export {a,b,c,d}`;

test("only the exact empty partition permits a zero-based page response", () => {
  assert.equal(
    validSourcePagination({ page: 0, total: 0, pages: 0, items: [] }, 1),
    true,
  );
  assert.equal(
    validSourcePagination({ page: 0, total: 1, pages: 0, items: [] }, 1),
    false,
  );
  assert.equal(
    validSourcePagination({ page: 0, total: 0, pages: 0, items: [{}] }, 1),
    false,
  );
  assert.equal(
    validSourcePagination({ page: 0, total: 0, pages: 0, items: [] }, 2),
    false,
  );
});

function fakeBrowser() {
  const calls: string[] = [];
  return {
    calls,
    async cdp(_method: string, input: { expression: string }) {
      const expression = input.expression;
      calls.push(expression);
      if (expression.includes("document.scripts"))
        return {
          result: {
            value: {
              scripts: ["https://example.test/shop-view/assets/index-a1.js"],
              resources: ["https://example.test/shop-view/assets/manage-b2.js"],
            },
          },
        };
      if (
        expression.includes(
          'fetch("https://example.test/shop-view/assets/index',
        )
      )
        return { result: { value: sourceModule } };
      if (
        expression.includes(
          'fetch("https://example.test/shop-view/assets/manage',
        )
      )
        return { result: { value: logisticsModule } };
      if (expression.includes("Shop identity differs"))
        return { result: { value: "shop-id" } };
      const match = expression.match(/\)\((\{.*\})\)$/s);
      if (!match) throw Error("unexpected fake CDP expression");
      const arg = JSON.parse(match[1]);
      if (expression.includes("function sourceList")) {
        const normal = !arg.draft && !arg.hidden;
        return {
          result: {
            value: {
              total: normal ? 2 : 0,
              pages: normal ? 1 : 0,
              page: normal ? 1 : 0,
              items: normal
                ? [
                    {
                      itemId: "1",
                      code: "1",
                      title: "one",
                      shop: "shop",
                      status: "normal",
                      revision: "r1",
                      hasLinks: true,
                    },
                    {
                      itemId: "2",
                      code: "2",
                      title: "two",
                      shop: "shop",
                      status: "normal",
                      revision: "r2",
                      hasLinks: true,
                    },
                  ]
                : [],
            },
          },
        };
      }
      if (expression.includes("function sourceLinksBatch"))
        return {
          result: {
            value: [
              {
                itemId: arg.items[0].itemId,
                skus: ["100" + arg.items[0].itemId],
                resolved: true,
                unresolvedUrls: [],
              },
            ],
          },
        };
      throw Error("unexpected fake source call");
    },
  };
}

test("browser source scan resumes the exact page detail after a bounded request round", async () => {
  const store = new Store(":memory:"),
    browser = fakeBrowser();
  try {
    const first = await syncSources(browser, store, { shop: "shop" } as any, {
      maxRequests: 5,
      intervalMs: 334,
    });
    assert.equal(first.budgetExhausted, true);
    const checkpoint = new SourceIndex(store).checkpoint(
      first.scan,
      "visible-normal",
    );
    assert.equal(checkpoint?.page?.nextDetail, 1);
    const second = await syncSources(browser, store, { shop: "shop" } as any, {
      maxRequests: 5,
      intervalMs: 334,
    });
    assert.equal(second.scan, first.scan);
    assert.equal(second.resumed, true);
    assert.equal(
      new SourceIndex(store).checkpoint(first.scan, "visible-normal")?.complete,
      true,
    );
    assert.equal(
      store.db
        .prepare("SELECT status FROM source_scans WHERE id=?")
        .get(first.scan)?.status,
      "running",
    );
    const complete = await syncSources(
      browser,
      store,
      { shop: "shop" } as any,
      { maxRequests: 20, intervalMs: 334 },
    );
    assert.equal(complete.complete, true);
    assert.equal(complete.scan, first.scan);
    assert.equal(complete.resumed, true);
  } finally {
    store.close();
  }
});

test("module resolver preserves a swallowed round budget stop", async () => {
  const store = new Store(":memory:");
  try {
    const result = await syncSources(
      fakeBrowser(),
      store,
      { shop: "shop" } as any,
      { maxRequests: 1, intervalMs: 334 },
    );
    assert.equal(result.budgetExhausted, true);
    assert.equal(
      store.db
        .prepare("SELECT status FROM source_scans WHERE id=?")
        .get(result.scan)?.status,
      "running",
    );
  } finally {
    store.close();
  }
});

test("shared hourly traffic pause retains the running scan for manual resume", async () => {
  const store = new Store(":memory:");
  try {
    configureHzAccessPolicy(store, "shop", {
      intervalMs: 334,
      hourlyLimit: 1,
    });
    await assert.rejects(
      () =>
        syncSources(fakeBrowser(), store, { shop: "shop" } as any, {
          maxRequests: 20,
          intervalMs: 334,
        }),
      (error: any) => error?.code === "PAUSED",
    );
    assert.equal(
      store.db
        .prepare("SELECT status FROM source_scans ORDER BY id DESC LIMIT 1")
        .get()?.status,
      "running",
    );
  } finally {
    store.close();
  }
});
