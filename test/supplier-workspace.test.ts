import test from "node:test";
import assert from "node:assert/strict";
import {
  ensureSupplierWorkspace,
  prepareNewTemplateWorkspace,
} from "../src/browser/supplier-workspace.js";
const config = {
  listUrl: "https://b.csgmall.com.cn/shop-view/#/shop-view/goods/goods-manage",
  newUrl: "https://b.csgmall.com.cn/shop-view/#/shop-view/goods/publish?new=1",
} as any;
test("public competitor view returns to supplier workspace before checking exact shop", async () => {
  const calls: string[] = [];
  const p = {
    url: async () =>
      "https://b.csgmall.com.cn/mall-view/product/search?keyword=x",
    goto: async (url: string) => calls.push(url),
    waitForFunction: async () => {},
  };
  await ensureSupplierWorkspace(p, config, "ours", async (_p, shop) => {
    calls.push(shop ?? "page-health");
  });
  assert.deepEqual(calls, ["page-health", config.listUrl, "ours"]);
});

test("template workspace enters new product directly from known read-only pages and verifies the target shop", async () => {
  for (const start of [
    "https://b.csgmall.com.cn/mall-view/product/detail?itemId=1",
    config.listUrl,
    "https://b.csgmall.com.cn/shop-view/#/shop-view/brand/regulate",
    config.newUrl,
  ]) {
    const calls: string[] = [];
    let current = start;
    const page = {
      url: async () => current,
      goto: async (url: string) => {
        calls.push("goto:" + url);
        current = url;
      },
      reload: async () => calls.push("reload"),
      waitForSelector: async () => calls.push("form"),
    };
    await prepareNewTemplateWorkspace(
      page,
      config,
      "ours",
      async (_p, shop) => {
        calls.push("health:" + (shop ?? "page"));
      },
    );
    assert.deepEqual(calls, [
      "health:page",
      ...(start === config.newUrl ? [] : ["goto:" + config.newUrl]),
      "reload",
      "form",
      "health:ours",
    ]);
    assert.equal(calls.includes("goto:" + config.listUrl), false);
  }
});

test("template workspace never leaves an existing editor and risk stops before navigation", async () => {
  let navigations = 0;
  const page = {
    url: async () =>
      "https://b.csgmall.com.cn/shop-view/#/shop-view/goods/publish?itemId=1&status=99",
    goto: async () => navigations++,
    reload: async () => {},
    waitForSelector: async () => {},
  };
  await assert.rejects(
    prepareNewTemplateWorkspace(page, config, "ours", async () => {}),
    (error: any) => error?.code === "NEEDS_INPUT",
  );
  assert.equal(navigations, 0);

  page.url = async () => "https://b.csgmall.com.cn/mall-view/product/detail";
  await assert.rejects(
    prepareNewTemplateWorkspace(page, config, "ours", async () => {
      throw Error("风险页面");
    }),
    /风险页面/,
  );
  assert.equal(navigations, 0);
});

test("template workspace rejects a target page whose shop identity differs", async () => {
  let current = config.listUrl;
  const page = {
    url: async () => current,
    goto: async (url: string) => {
      current = url;
    },
    reload: async () => {},
    waitForSelector: async () => {},
  };
  await assert.rejects(
    prepareNewTemplateWorkspace(page, config, "ours", async (_page, shop) => {
      if (shop)
        throw Object.assign(new Error("店铺身份不匹配"), {
          code: "ACCOUNT_CHANGED",
        });
    }),
    (error: any) => error?.code === "ACCOUNT_CHANGED",
  );
  assert.equal(current, config.newUrl);
});
test("existing supplier page needs no navigation and public risk does not trigger a navigation retry", async () => {
  let calls = 0;
  const p = {
    url: async () => "https://b.csgmall.com.cn/shop-view/",
    goto: async () => {
      calls++;
    },
  };
  await ensureSupplierWorkspace(p, config, "ours", async () => {});
  assert.equal(calls, 0);
  p.url = async () => "https://b.csgmall.com.cn/mall-view/product/search";
  await assert.rejects(
    ensureSupplierWorkspace(p, config, "ours", async () => {
      throw Error("风险页面");
    }),
  );
  assert.equal(calls, 0);
});
