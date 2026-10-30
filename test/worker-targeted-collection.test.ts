import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.js";
import { Jobs } from "../src/jobs.js";
import { Worker } from "../src/worker.js";
import { EgoBridge } from "../src/browser/bridge.js";
import { example } from "../src/demo.js";
import { Catalog } from "../src/catalog.js";
import { Planner } from "../src/planner.js";
import { JdCaptureStore } from "../src/jd-capture.js";
import { sourceContext } from "../src/source-reuse.js";
import { SourceIndex } from "../src/source-index.js";
const config = {
  shop: "ours",
  session: { spaceId: 3, hzPage: "p3", jdPage: "p8", profileId: "4" },
  listUrl: "",
  newUrl: "",
  editUrl: "",
  maxPages: 1,
};
function setupStructure(store: Store, categoryId = "category") {
  const now = new Date().toISOString();
  store.setMeta("jd-context:ours", {
    account: "fixture-account",
    region: "fixture-region",
  });
  new SourceIndex(store);
  new Catalog(store).import({
    shop: "ours",
    categories: [
      {
        id: categoryId,
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
        scopes: [{ categoryId, descendants: false }],
        sourceUrl: "https://b.csgmall.com.cn/",
        checkedAt: now,
      },
    ],
  });
  const planner = new Planner(store);
  planner.importTemplate("ours", categoryId, {
    categoryId,
    specs: ["规格"],
    fields: [{ id: "f", name: "规格", required: true, selectType: "3" }],
    sourceUrl: "https://b.csgmall.com.cn/shop-view/",
    checkedAt: now,
  });
  planner.importPolicy("ours", "policy", {
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
}

test("worker passes the selected category into local archive-box preparation", async () => {
  const s = new Store(":memory:");
  try {
    setupStructure(s, "10048009");
    const { product } = example();
    const fact = (value: string) => ({ ...product.title, value });
    product.title = fact("示例品牌 A4 档案盒 35mm");
    product.price!.capturedAt = new Date().toISOString();
    product.specs = {
      品牌: fact("示例品牌"),
      商品毛重: fact("0.2kg"),
      规格: fact("A4"),
      材质: fact("PP"),
      货号: fact("BX71"),
      包装清单: fact("BX71档案盒 × １个"),
      京东销售规格: fact("【35mm侧宽】蓝色-纯PP材质"),
    };
    const original = structuredClone(product);
    const row = s.put("ours", product);
    new JdCaptureStore(s).saveProduct(
      sourceContext(s, "ours", product.sku, "browser"),
      product,
    );
    const jobs = new Jobs(s, "ours");
    jobs.enqueue([product.sku], {
      brandId: "brand",
      categoryId: "10048009",
      policyId: "policy",
      unit: "个",
      through: "submit",
    });
    const bridge = new EgoBridge();
    const calls: string[] = [];
    bridge.call = async (action) => {
      calls.push(action);
      throw Error("local preparation must not contact the browser");
    };
    const worker = new Worker(s, jobs, config, "/unused", bridge, {
      downloadAssets: async () => {
        throw Error("stop before asset download");
      },
    });
    await worker.run(jobs.claim()!);
    const updated = s.get(row.id).product!;
    assert.equal(updated.specs["规格"].value, "单个装");
    assert.equal(updated.specs["尺寸规格"].value, "35mm");
    assert.equal(updated.specs["京东原始规格"].value, "A4");
    assert.deepEqual(updated.assets, original.assets);
    assert.deepEqual(updated.price, original.price);
    assert.deepEqual(calls, []);
    assert.equal(s.get(row.id).remoteId, null);
  } finally {
    s.close();
  }
});

for (const source of ["browser", "android"] as const) {
  test(`worker ${source} fills missing facts through a bounded patch without replacing assets or quote`, async () => {
    const s = new Store(":memory:");
    try {
      setupStructure(s);
      const { product } = example();
      product.price!.capturedAt = new Date().toISOString();
      const original = structuredClone(product);
      const row = s.put("ours", product);
      new JdCaptureStore(s).saveProduct(
        sourceContext(s, "ours", product.sku, source),
        product,
      );
      const jobs = new Jobs(s, "ours");
      jobs.enqueue([product.sku], {
        source,
        brandId: "brand",
        categoryId: "category",
        policyId: "policy",
        unit: "件",
        through: "submit",
      });
      const calls: string[] = [];
      const facts = () => {
        const at = new Date().toISOString();
        return {
          商品毛重: { ...product.title, value: "1kg", capturedAt: at },
          包装名称: { ...product.title, value: "单件商品", capturedAt: at },
          包装数量: { ...product.title, value: "1", capturedAt: at },
        };
      };
      const bridge = new EgoBridge();
      bridge.call = async (action, args: any) => {
        calls.push(action);
        assert.equal(action, "collect-regions");
        const specs = facts();
        return {
          sku: product.sku,
          url: product.url,
          variant: product.variant,
          specs,
          observedAt: specs.商品毛重.capturedAt,
          regions: args.regions,
          completeRegions: args.regions,
        };
      };
      const worker = new Worker(s, jobs, config, "/unused", bridge, {
        collectAndroid: async (_s, _shop, _root, _serial, _sku, options) => {
          calls.push("android-facts");
          assert.equal(options?.factsOnly, true);
          const specs = facts();
          return {
            ...product,
            specs,
            assets: [],
            price: null,
            capturedAt: specs.商品毛重.capturedAt,
          };
        },
        downloadAssets: async () => {
          throw Error("test stops before downloading");
        },
      });
      await worker.run(jobs.claim()!);
      assert.deepEqual(calls, [
        source === "browser" ? "collect-regions" : "android-facts",
      ]);
      const updated = s.get(row.id).product!;
      assert.equal(updated.specs["商品毛重"].value, "1kg");
      assert.equal(updated.specs["包装数量"].value, "1");
      assert.deepEqual(updated.assets, original.assets);
      assert.deepEqual(updated.price, original.price);
      assert.equal(s.get(row.id).remoteId, null);
    } finally {
      s.close();
    }
  });
}
test("an incomplete targeted observation is recorded and is not repeated on retry", async () => {
  const s = new Store(":memory:");
  try {
    setupStructure(s);
    const { product } = example();
    product.price!.capturedAt = new Date().toISOString();
    const row = s.put("ours", product);
    new JdCaptureStore(s).saveProduct(
      sourceContext(s, "ours", product.sku, "browser"),
      product,
    );
    const jobs = new Jobs(s, "ours");
    jobs.enqueue([product.sku], {
      brandId: "brand",
      categoryId: "category",
      policyId: "policy",
      unit: "件",
      through: "submit",
    });
    let calls = 0;
    const bridge = new EgoBridge();
    bridge.call = async (action, args: any) => {
      calls++;
      assert.equal(action, "collect-regions");
      return {
        sku: product.sku,
        url: product.url,
        variant: product.variant,
        specs: {},
        observedAt: new Date().toISOString(),
        regions: args.regions,
        completeRegions: [],
      };
    };
    const worker = new Worker(s, jobs, config, "/unused", bridge);
    await worker.run(jobs.claim()!);
    const j = jobs.list()[0];
    assert.equal(j.status, "NEEDS_INPUT");
    jobs.retry(j.id);
    await worker.run(jobs.claim()!);
    assert.equal(calls, 1);
    assert.deepEqual(s.get(row.id).product, product);
  } finally {
    s.close();
  }
});
