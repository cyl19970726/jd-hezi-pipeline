import test from "node:test";
import assert from "node:assert/strict";
import { Catalog } from "../src/catalog.js";
import { example } from "../src/demo.js";
import { Jobs } from "../src/jobs.js";
import { Planner } from "../src/planner.js";
import { preflightJob } from "../src/preflight.js";
import { SourceIndex } from "../src/source-index.js";
import { Store } from "../src/store.js";
import { Worker } from "../src/worker.js";

function fixture(options: {
  source?: "browser" | "android";
  authorization?: boolean;
  staleTemplate?: boolean;
  wave?: boolean;
  existingSourceShop?: string;
  existingSourceSku?: string;
}) {
  const store = new Store(":memory:");
  const jobs = new Jobs(store, "shop");
  const planner = new Planner(store);
  new SourceIndex(store);
  const now = new Date();
  new Catalog(store).import({
    shop: "shop",
    categories: [
      {
        id: "leaf",
        parentId: null,
        name: "类目",
        path: "类目",
        selectable: true,
        sourceUrl: "https://b.csgmall.com.cn/",
        checkedAt: now.toISOString(),
      },
    ],
    brands: [
      {
        id: "brand",
        name: "示例品牌",
        sourceUrl: "https://b.csgmall.com.cn/",
        checkedAt: now.toISOString(),
      },
    ],
    grants:
      options.authorization === false
        ? []
        : [
            {
              id: "grant",
              brandId: "brand",
              status: "approved" as const,
              validFrom: new Date(now.getTime() - 60_000).toISOString(),
              validUntil: new Date(now.getTime() + 86_400_000).toISOString(),
              scopes: [{ categoryId: "leaf", descendants: false }],
              sourceUrl: "https://b.csgmall.com.cn/",
              checkedAt: now.toISOString(),
            },
          ],
  });
  planner.importTemplate("shop", "leaf", {
    categoryId: "leaf",
    specs: ["规格"],
    fields: [{ id: "f", name: "规格", required: true, selectType: "3" }],
    sourceUrl: "https://b.csgmall.com.cn/shop-view/",
    checkedAt: now.toISOString(),
  });
  if (options.staleTemplate)
    store.db
      .prepare("UPDATE category_templates SET checked_at=?")
      .run("2000-01-01T00:00:00.000Z");
  planner.importPolicy("shop", "policy", {
    inventory: "1",
    logistics: {
      sourceItemId: "1",
      checkedAt: now.toISOString(),
      templateId: "1",
      templateName: "默认模板",
      addressIds: ["1"],
      areas: [{ areaId: "1", areaName: "全国" }],
    },
    sourceUrl: "https://b.csgmall.com.cn/",
    checkedAt: now.toISOString(),
  });
  const { product } = example();
  product.specs = {
    ...product.specs,
    品牌: { ...product.title, value: "示例品牌" },
    规格: { ...product.title, value: "单件" },
    商品毛重: { ...product.title, value: "1kg" },
    包装名称: { ...product.title, value: "盒" },
    包装数量: { ...product.title, value: "1" },
  };
  product.assets = [];
  const waveKey = "controlled-wave";
  if (options.wave)
    store.setMeta(waveKey, {
      status: "planned",
      candidates: [
        {
          sku: product.sku,
          brandId: "brand",
          suggestedCategoryId: "leaf",
          evidence: { runId: "run" },
        },
      ],
      groups: [],
    });
  const item = jobs.enqueue(
    [product.sku],
    {
      source: options.source,
      brandId: "brand",
      categoryId: "leaf",
      policyId: "policy",
      unit: "件",
      through: "draft",
    },
    options.wave ? { runId: "run", brandId: "brand", waveKey } : undefined,
  ).items[0];
  if (options.existingSourceShop) {
    const index = new SourceIndex(store);
    const scan = index.begin(options.existingSourceShop);
    const sourceSku = options.existingSourceSku ?? product.sku;
    index.put(
      scan,
      options.existingSourceShop,
      {
        itemId: "remote-42",
        code: "remote-42",
        title: "已有商品",
        shop: options.existingSourceShop,
        status: "在售",
        sku: sourceSku,
      },
      "revision",
      [sourceSku],
      true,
    );
    index.finish(
      scan,
      ["visible-normal", "visible-draft", "hidden-normal", "hidden-draft"].map(
        (partition) => ({
          partition,
          expected: partition === "visible-normal" ? 1 : 0,
          seen: partition === "visible-normal" ? 1 : 0,
        }),
      ),
    );
  }
  return { store, jobs, job: jobs.get(item.id), product };
}

for (const scenario of ["invalid authorization", "stale template"] as const) {
  test(`${scenario} blocks collection before every external source`, async () => {
    const s = fixture({
      source: scenario === "stale template" ? "android" : "browser",
      authorization: scenario !== "invalid authorization",
      staleTemplate: scenario === "stale template",
    });
    let browserCalls = 0;
    let androidCalls = 0;
    let downloads = 0;
    try {
      await new Worker(
        s.store,
        s.jobs,
        { shop: "shop" } as any,
        "/unused",
        {
          async call() {
            browserCalls++;
            return s.product;
          },
        } as any,
        {
          async collectAndroid() {
            androidCalls++;
            return s.product;
          },
          async downloadAssets() {
            downloads++;
            return s.product;
          },
        },
      ).run(s.job);
      assert.deepEqual(
        { browserCalls, androidCalls, downloads },
        { browserCalls: 0, androidCalls: 0, downloads: 0 },
      );
      assert.equal(s.jobs.get(s.job.id).status, "NEEDS_INPUT");
    } finally {
      s.store.close();
    }
  });
}

test("valid uncollected work reaches collection despite COLLECT_REQUIRED", async () => {
  const s = fixture({ source: "browser", authorization: true });
  let browserCalls = 0;
  try {
    await new Worker(s.store, s.jobs, { shop: "shop" } as any, "/unused", {
      async call(action: string) {
        assert.equal(action, "collect");
        browserCalls++;
        return s.product;
      },
    } as any).run(s.job);
    assert.equal(browserCalls, 1);
    assert.ok(s.store.list().some((row) => row.sku === s.product.sku));
  } finally {
    s.store.close();
  }
});

test("controlled-wave source match blocks before collection and names the remote item", async () => {
  const s = fixture({
    source: "browser",
    authorization: true,
    wave: true,
    existingSourceShop: "shop",
  });
  let browserCalls = 0;
  try {
    const preflight = preflightJob(s.store, s.jobs, s.job);
    assert.ok(
      preflight.issues.some(
        (issue) =>
          issue.code === "SOURCE_ALREADY_EXISTS" &&
          issue.message.includes("remote-42"),
      ),
    );
    await new Worker(s.store, s.jobs, { shop: "shop" } as any, "/unused", {
      async call() {
        browserCalls++;
        return s.product;
      },
    } as any).run(s.job);
    assert.equal(browserCalls, 0);
    const stopped = s.jobs.get(s.job.id);
    assert.equal(stopped.status, "NEEDS_INPUT");
    assert.match(String(stopped.error), /remote-42/);
    assert.equal(stopped.productId, null);
  } finally {
    s.store.close();
  }
});

test("ordinary work, another shop and a nonmatching SKU do not trigger the wave guard", async () => {
  for (const options of [
    { wave: false, existingSourceShop: "shop" },
    { wave: true, existingSourceShop: "other-shop" },
    {
      wave: true,
      existingSourceShop: "shop",
      existingSourceSku: "999999999999",
    },
  ]) {
    const s = fixture({ source: "browser", authorization: true, ...options });
    let browserCalls = 0;
    try {
      await new Worker(s.store, s.jobs, { shop: "shop" } as any, "/unused", {
        async call() {
          browserCalls++;
          return s.product;
        },
      } as any).run(s.job);
      assert.equal(browserCalls, 1);
    } finally {
      s.store.close();
    }
  }
});
