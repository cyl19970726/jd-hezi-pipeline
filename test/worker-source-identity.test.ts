import test from "node:test";
import assert from "node:assert/strict";
import { Catalog } from "../src/catalog.js";
import { example } from "../src/demo.js";
import { Jobs } from "../src/jobs.js";
import { Planner } from "../src/planner.js";
import { SourceIndex } from "../src/source-index.js";
import { Store } from "../src/store.js";
import { Worker } from "../src/worker.js";

function setup(
  sourceBrand?: string,
  selectedSpec?: string,
  scent?: string,
  catalogBrand = "示例甲品牌",
) {
  const store = new Store(":memory:");
  const jobs = new Jobs(store, "shop");
  const now = new Date().toISOString();
  const sourceIndex = new SourceIndex(store);
  const scan = sourceIndex.begin("shop");
  sourceIndex.finish(
    scan,
    ["visible-normal", "visible-draft", "hidden-normal", "hidden-draft"].map(
      (partition) => ({ partition, expected: 0, seen: 0 }),
    ),
  );
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
        checkedAt: now,
      },
    ],
    brands: [
      {
        id: "brand",
        name: catalogBrand,
        sourceUrl: "https://b.csgmall.com.cn/",
        checkedAt: now,
      },
    ],
    grants: [
      {
        id: "grant",
        brandId: "brand",
        status: "approved",
        validFrom: new Date(Date.now() - 60_000).toISOString(),
        validUntil: new Date(Date.now() + 86_400_000).toISOString(),
        scopes: [{ categoryId: "leaf", descendants: false }],
        sourceUrl: "https://b.csgmall.com.cn/",
        checkedAt: now,
      },
    ],
  });
  const planner = new Planner(store);
  planner.importTemplate("shop", "leaf", {
    categoryId: "leaf",
    specs: ["规格"],
    fields: [{ id: "f", name: "规格", required: true, selectType: "3" }],
    sourceUrl: "https://b.csgmall.com.cn/shop-view/",
    checkedAt: now,
  });
  planner.importPolicy("shop", "policy", {
    inventory: "1",
    logistics: {
      sourceItemId: "1",
      checkedAt: now,
      templateId: "1",
      templateName: "默认模板",
      addressIds: ["1"],
      areas: [{ areaId: "1", areaName: "全国" }],
    },
    sourceUrl: "https://b.csgmall.com.cn/",
    checkedAt: now,
  });
  const { product } = example();
  const fact = (value: string) => ({ ...product.title, value });
  product.capturedAt = now;
  product.price = { ...product.price!, capturedAt: now };
  product.specs = {
    ...(sourceBrand ? { 品牌: fact(sourceBrand) } : {}),
    ...(selectedSpec ? { 京东销售规格: fact(selectedSpec) } : {}),
    ...(scent ? { 香型: fact(scent) } : {}),
    规格: fact("单件"),
    商品毛重: fact("1kg"),
    包装名称: fact("盒"),
    包装数量: fact("1"),
  };
  const item = jobs.enqueue([product.sku], {
    source: "browser",
    brandId: "brand",
    categoryId: "leaf",
    policyId: "policy",
    unit: "件",
    through: "draft",
  }).items[0];
  return { store, jobs, product, job: jobs.get(item.id) };
}

async function run(
  sourceBrand?: string,
  selectedSpec?: string,
  scent?: string,
  catalogBrand?: string,
) {
  const fixture = setup(sourceBrand, selectedSpec, scent, catalogBrand);
  let downloads = 0;
  const actions: string[] = [];
  await new Worker(
    fixture.store,
    fixture.jobs,
    { shop: "shop" } as any,
    "/unused",
    {
      async call(action: string) {
        actions.push(action);
        return structuredClone(fixture.product);
      },
    } as any,
    {
      async collectAndroid() {
        throw new Error("browser fixture must not use Android");
      },
      async downloadAssets(product) {
        downloads++;
        return structuredClone(product);
      },
    },
  ).run(fixture.job);
  return { ...fixture, downloads, actions };
}

test("explicit source-brand mismatch blocks before assets or remote save", async () => {
  const result = await run("贝贝健");
  try {
    assert.equal(result.downloads, 0);
    assert.deepEqual(result.actions, ["collect"]);
    assert.equal(result.jobs.get(result.job.id).status, "NEEDS_INPUT");
    assert.match(result.jobs.get(result.job.id).error!, /来源品牌.*不一致/);
  } finally {
    result.store.close();
  }
});

test("equivalent authorized brand continues to asset handling", async () => {
  const result = await run("示例 甲品牌（Super）");
  try {
    assert.equal(
      result.downloads,
      1,
      result.jobs.get(result.job.id).error ?? "",
    );
    assert.equal(
      result.actions.filter((action) => action === "save").length,
      0,
    );
  } finally {
    result.store.close();
  }
});

test("plain source brand matches an authorized trailing Latin name", async () => {
  const result = await run(
    "示例甲品牌",
    undefined,
    undefined,
    "示例甲品牌（Super）",
  );
  try {
    assert.equal(
      result.downloads,
      1,
      result.jobs.get(result.job.id).error ?? "",
    );
  } finally {
    result.store.close();
  }
});

test("generic parenthetical text is not accepted as a brand alias", async () => {
  const result = await run("示例甲品牌（APP）");
  try {
    assert.equal(result.downloads, 0);
    assert.equal(result.jobs.get(result.job.id).status, "NEEDS_INPUT");
    assert.match(result.jobs.get(result.job.id).error!, /来源品牌.*不一致/);
  } finally {
    result.store.close();
  }
});

test("conflicting explicit Latin aliases block before asset handling", async () => {
  const result = await run(
    "示例甲品牌（Other）",
    undefined,
    undefined,
    "示例甲品牌（Super）",
  );
  try {
    assert.equal(result.downloads, 0);
    assert.equal(result.jobs.get(result.job.id).status, "NEEDS_INPUT");
    assert.match(result.jobs.get(result.job.id).error!, /来源品牌.*不一致/);
  } finally {
    result.store.close();
  }
});

test("missing source brand keeps the existing downstream missing-fact path", async () => {
  const result = await run();
  try {
    assert.equal(
      result.downloads,
      1,
      result.jobs.get(result.job.id).error ?? "",
    );
    assert.equal(result.jobs.get(result.job.id).status, "NEEDS_INPUT");
    assert.match(result.jobs.get(result.job.id).error!, /品牌.*缺失/);
  } finally {
    result.store.close();
  }
});

test("explicit selected no-scent conflicts with an explicit scented field before assets", async () => {
  const result = await run("示例甲品牌", "700mL 无香升级款", "有香型");
  try {
    assert.equal(result.downloads, 0);
    assert.deepEqual(result.actions, ["collect"]);
    assert.equal(result.jobs.get(result.job.id).status, "NEEDS_INPUT");
    assert.match(
      result.jobs.get(result.job.id).error!,
      /明确无香.*香型字段不一致/,
    );
  } finally {
    result.store.close();
  }
});

test("scent gate accepts consistent and non-binary selected specifications", async () => {
  for (const [selectedSpec, scent] of [
    ["无香升级款", "无香型"],
    ["薄荷型 700mL", "有香型"],
    ["无香型或薄荷型可选", "有香型"],
  ]) {
    const result = await run("示例甲品牌", selectedSpec, scent);
    try {
      assert.equal(
        result.downloads,
        1,
        `${selectedSpec} / ${scent}: ${result.jobs.get(result.job.id).error}`,
      );
    } finally {
      result.store.close();
    }
  }
});

test("scent gate adds no blocker when either explicit field is absent", async () => {
  for (const [selectedSpec, scent] of [
    ["700mL 无香型", undefined],
    [undefined, "清香型"],
  ] as const) {
    const result = await run("示例甲品牌", selectedSpec, scent);
    try {
      assert.equal(result.downloads, 1);
    } finally {
      result.store.close();
    }
  }
});
