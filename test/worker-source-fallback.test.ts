import { JD_CAPTURE_PARSER } from "../src/jd-capture.js";
import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.js";
import { Jobs } from "../src/jobs.js";
import { Worker } from "../src/worker.js";
import { EgoBridge } from "../src/browser/bridge.js";
import { example } from "../src/demo.js";
import { PipelineError } from "../src/model.js";
import type { BrowserConfig } from "../src/browser/runtime.js";
import { Catalog } from "../src/catalog.js";
import { Planner } from "../src/planner.js";
import { SourceIndex } from "../src/source-index.js";

const config = { shop: "ours" } as BrowserConfig;
const mediaError = (sku: string) =>
  new PipelineError("UNSUPPORTED_MEDIA", "Discovery", {
    reason: "discovery-story",
    stage: "main-gallery",
    sku,
    variant: "手机已验证规格",
    parserVersion: JD_CAPTURE_PARSER,
    observedAt: new Date().toISOString(),
  });

function setup() {
  const store = new Store(":memory:");
  const jobs = new Jobs(store, config.shop);
  const now = new Date().toISOString();
  new SourceIndex(store);
  new Catalog(store).import({
    shop: config.shop,
    categories: [
      {
        id: "category",
        parentId: null,
        name: "类目",
        path: "类目",
        selectable: true,
        sourceUrl: "https://b.csgmall.com.cn/",
        checkedAt: now,
      },
    ],
    brands: [
      {
        id: "brand",
        name: "示例品牌",
        sourceUrl: "https://b.csgmall.com.cn/",
        checkedAt: now,
      },
    ],
    grants: [
      {
        id: "grant",
        brandId: "brand",
        status: "approved",
        validFrom: new Date(Date.now() - 1000).toISOString(),
        validUntil: new Date(Date.now() + 86400000).toISOString(),
        scopes: [{ categoryId: "category", descendants: false }],
        sourceUrl: "https://b.csgmall.com.cn/",
        checkedAt: now,
      },
    ],
  });
  const planner = new Planner(store);
  planner.importTemplate(config.shop, "category", {
    categoryId: "category",
    specs: ["规格"],
    fields: [{ id: "f", name: "规格", required: true, selectType: "3" }],
    sourceUrl: "https://b.csgmall.com.cn/shop-view/",
    checkedAt: now,
  });
  planner.importPolicy(config.shop, "policy", {
    inventory: "1",
    logistics: {
      sourceItemId: "1",
      checkedAt: now,
      templateId: "1",
      templateName: "默认",
      addressIds: ["1"],
      areas: [{ areaId: "1", areaName: "全国" }],
    },
    sourceUrl: "https://b.csgmall.com.cn/",
    checkedAt: now,
  });
  const { product } = example();
  product.sku = "5773954";
  product.url = "https://item.jd.com/5773954.html";
  product.variant = "";
  product.title = { ...product.title, value: "浏览器独立结果" };
  product.assets = [];
  product.capturedAt = new Date().toISOString();
  product.price = {
    ...product.price!,
    sourceUrl: product.url,
    capturedAt: product.capturedAt,
  };
  product.specs["商品毛重"] = { ...product.title, value: "1kg" };
  const batch = jobs.enqueue([product.sku], {
    source: "android",
    brandId: "brand",
    categoryId: "category",
    policyId: "policy",
    unit: "件",
    through: "submit",
  });
  return { store, jobs, product, job: jobs.get(batch.items[0].id) };
}

test("exact unsupported Android media falls back once and stores only the browser product", async () => {
  const { store, jobs, product, job } = setup();
  try {
    let androidCalls = 0;
    const bridge = new EgoBridge();
    const browserCalls: string[] = [];
    bridge.call = async (action, args: any) => {
      browserCalls.push(action);
      if (action === "collect-regions")
        return {
          sku: product.sku,
          url: product.url,
          variant: product.variant,
          specs: {},
          observedAt: new Date().toISOString(),
          regions: args.regions,
          completeRegions: [],
        };
      return structuredClone(product);
    };
    await new Worker(store, jobs, config, "/unused", bridge, {
      collectAndroid: async () => {
        androidCalls++;
        throw mediaError(product.sku);
      },
    }).run(job);
    assert.equal(androidCalls, 1);
    assert.deepEqual(browserCalls, ["collect", "collect-regions"]);
    const saved = store.list().find((row) => row.sku === product.sku)!;
    assert.equal(saved.product!.title.value, "浏览器独立结果");
    assert.equal(
      store.db
        .prepare("SELECT source FROM jd_capture_checkpoints WHERE sku=?")
        .get(product.sku).source,
      "browser",
    );
    const event: any = store.db
      .prepare("SELECT detail FROM job_events WHERE kind='source-fallback'")
      .get();
    assert.deepEqual(
      (({ requestedSource, effectiveSource, stage, sku }) => ({
        requestedSource,
        effectiveSource,
        stage,
        sku,
      }))(JSON.parse(event.detail)),
      {
        requestedSource: "android",
        effectiveSource: "browser",
        stage: "main-gallery",
        sku: product.sku,
      },
    );

    const provenance: any = store.meta(
      `jd-product-source:${config.shop}:${product.sku}`,
    );
    assert.equal(provenance.dataHash, saved.dataHash);
    assert.equal(provenance.url, saved.product!.url);
    jobs.retry(job.id);
    let resumedAndroidCalls = 0;
    await new Worker(store, jobs, config, "/unused", bridge, {
      collectAndroid: async () => {
        resumedAndroidCalls++;
        throw new Error(
          "saved browser provenance must prevent Android recollection",
        );
      },
    }).run(jobs.get(job.id));
    assert.equal(resumedAndroidCalls, 0);
    assert.equal(
      browserCalls.filter((action) => action === "collect").length,
      1,
    );
    assert.equal(
      store.db
        .prepare("SELECT source FROM jd_capture_checkpoints WHERE sku=?")
        .get(product.sku).source,
      "browser",
    );

    const changed = structuredClone(store.list()[0].product!);
    changed.title = {
      ...changed.title,
      value: changed.title.value + " 已修改",
    };
    store.put(config.shop, changed);
    jobs.retry(job.id);
    let androidAfterHashChange = 0;
    const noBrowser = new EgoBridge();
    noBrowser.call = async () => {
      throw new Error("stale provenance must not switch to browser");
    };
    await new Worker(store, jobs, config, "/unused", noBrowser, {
      collectAndroid: async () => {
        androidAfterHashChange++;
        throw new PipelineError("AUTH_REQUIRED", "stop after identity retry");
      },
    }).run(jobs.get(job.id));
    assert.equal(androidAfterHashChange, 1);
  } finally {
    store.close();
  }
});

for (const code of ["AUTH_REQUIRED", "RATE_LIMITED", "PAUSED"] as const) {
  test(`${code} never switches collection source`, async () => {
    const { store, jobs, product, job } = setup();
    try {
      let browserCalls = 0;
      const bridge = new EgoBridge();
      bridge.call = async () => {
        browserCalls++;
        return product;
      };
      await new Worker(store, jobs, config, "/unused", bridge, {
        collectAndroid: async () => {
          throw new PipelineError(code, code);
        },
      }).run(job);
      assert.equal(browserCalls, 0);
      assert.equal(store.list().length, 0);
    } finally {
      store.close();
    }
  });
}

test("a fallback browser response with another URL identity is never stored", async () => {
  const { store, jobs, product, job } = setup();
  try {
    const bridge = new EgoBridge();
    bridge.call = async () => ({
      ...product,
      url: "https://item.jd.com/900000000006.html",
    });
    await new Worker(store, jobs, config, "/unused", bridge, {
      collectAndroid: async () => {
        throw mediaError(product.sku);
      },
    }).run(job);
    assert.equal(store.list().length, 0);
    assert.equal(jobs.get(job.id).status, "NEEDS_INPUT");
    assert.match(jobs.get(job.id).error!, /URL与任务SKU不一致/);
  } finally {
    store.close();
  }
});

test("authentication failure in the fallback remains attributed to the browser channel", async () => {
  const { store, jobs, product, job } = setup();
  try {
    const bridge = new EgoBridge();
    let browserCalls = 0;
    bridge.call = async () => {
      browserCalls++;
      throw new PipelineError("AUTH_REQUIRED", "browser auth");
    };
    await new Worker(store, jobs, config, "/unused", bridge, {
      collectAndroid: async () => {
        throw mediaError(product.sku);
      },
    }).run(job);
    assert.equal(browserCalls, 1);
    assert.ok(store.meta("pause:jd:" + config.shop));
    assert.equal(store.meta("pause:jd-android:" + config.shop), null);
    assert.equal(store.list().length, 0);
  } finally {
    store.close();
  }
});
