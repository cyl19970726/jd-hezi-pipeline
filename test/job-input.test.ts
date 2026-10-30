import test from "node:test";
import assert from "node:assert/strict";
import { Catalog } from "../src/catalog.js";
import { example } from "../src/demo.js";
import {
  bindCanonicalBrowserSource,
  canonicalSourceBinding,
} from "../src/jd-source-fallback.js";
import { updateJobFacts } from "../src/job-input.js";
import { JdCaptureStore } from "../src/jd-capture.js";
import { Jobs } from "../src/jobs.js";
import { Planner } from "../src/planner.js";
import { Store } from "../src/store.js";

function setup(source: "android" | "browser" = "android") {
  const store = new Store(":memory:");
  const jobs = new Jobs(store, "shop");
  const planner = new Planner(store);
  const catalog = new Catalog(store);
  const now = new Date().toISOString();
  catalog.import({
    shop: "shop",
    categories: [
      {
        id: "root",
        parentId: null,
        name: "根",
        path: "根",
        selectable: false,
        sourceUrl: "https://b.csgmall.com.cn/",
        checkedAt: now,
      },
      {
        id: "leaf",
        parentId: "root",
        name: "类目",
        path: "根>类目",
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
        validFrom: new Date(Date.now() - 60000).toISOString(),
        validUntil: new Date(Date.now() + 86400000).toISOString(),
        scopes: [{ categoryId: "root", descendants: true }],
        sourceUrl: "https://b.csgmall.com.cn/",
        checkedAt: now,
      },
    ],
  });
  planner.importTemplate("shop", "leaf", {
    categoryId: "leaf",
    specs: ["规格"],
    sourceUrl: "https://b.csgmall.com.cn/shop-view/",
    checkedAt: now,
  });
  planner.importPolicy("shop", "policy", {
    inventory: "100",
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
  product.specs = {
    ...product.specs,
    品牌: fact("示例品牌"),
    商品毛重: fact("1kg"),
    包装名称: fact("盒"),
    包装数量: fact("1"),
    规格: fact("单件装"),
  };
  const row = store.put("shop", product);
  const item = jobs.enqueue([product.sku], {
    source,
    brandId: "brand",
    categoryId: "leaf",
    policyId: "policy",
    unit: "件",
    through: "draft",
  }).items[0];
  jobs.update(item.id, "NEEDS_INPUT", "collect", "缺少事实", row.id);
  return { store, jobs, jobId: item.id, row };
}

test("controlled Android fact update rebinds valid browser provenance to the new hash", () => {
  const s = setup();
  try {
    const key = `jd-product-source:shop:${s.row.product!.sku}`;
    s.store.setMeta(
      key,
      bindCanonicalBrowserSource({
        sku: s.row.product!.sku,
        url: s.row.product!.url,
        dataHash: s.row.dataHash,
      }),
    );
    updateJobFacts(s.jobs, s.jobId, {
      values: { 包装数量: "2" },
      mediaReviewed: true,
      sourceUrl: s.row.product!.url,
    });
    const updated = s.store.get(s.row.id);
    assert.notEqual(updated.dataHash, s.row.dataHash);
    assert.equal(updated.product!.specs["包装数量"].value, "2");
    assert.ok(
      canonicalSourceBinding(s.store.meta(key), {
        sku: updated.product!.sku,
        url: updated.product!.url,
        dataHash: updated.dataHash,
      }),
    );
  } finally {
    s.store.close();
  }
});

test("invalid old provenance is not revived by a controlled fact update", () => {
  const s = setup();
  try {
    const key = `jd-product-source:shop:${s.row.product!.sku}`;
    const stale = bindCanonicalBrowserSource({
      sku: s.row.product!.sku,
      url: s.row.product!.url,
      dataHash: "stale-hash",
    });
    s.store.setMeta(key, stale);
    updateJobFacts(s.jobs, s.jobId, {
      values: { 包装数量: "2" },
      mediaReviewed: true,
      sourceUrl: s.row.product!.url,
    });
    assert.deepEqual(s.store.meta(key), stale);
  } finally {
    s.store.close();
  }
});

test("browser-requested jobs never create browser provenance", () => {
  const s = setup("browser");
  try {
    const key = `jd-product-source:shop:${s.row.product!.sku}`;
    updateJobFacts(s.jobs, s.jobId, {
      values: { 包装数量: "2" },
      mediaReviewed: true,
      sourceUrl: s.row.product!.url,
    });
    assert.equal(s.store.meta(key), null);
  } finally {
    s.store.close();
  }
});

test("regular-preferred workbench prices are order-independent and retain the selected alias", () => {
  for (const values of [
    { 补贴价: "55", 京东价: "59.00", 日常价: "59" },
    { 日常价: "59", 京东价: "59.00", 补贴价: "55" },
  ]) {
    const s = setup();
    try {
      s.store.setMeta("listing-price:shop", "jd-regular-preferred");
      updateJobFacts(s.jobs, s.jobId, {
        values,
        sourceUrl: s.row.product!.url,
      });
      const price = s.store.get(s.row.id).product!.price!;
      assert.equal(price.value, "59");
      assert.equal(price.basis, "jd-price");
      assert.match(price.evidence, /日常价/);
    } finally {
      s.store.close();
    }
  }
});

test("regular-preferred workbench replaces subsidy, preserves regular against subsidy, and rejects alias conflict", () => {
  const replaced = setup();
  try {
    replaced.store.setMeta("listing-price:shop", "jd-regular-preferred");
    updateJobFacts(replaced.jobs, replaced.jobId, {
      values: { 京东价: "59" },
      sourceUrl: replaced.row.product!.url,
    });
    assert.equal(
      replaced.store.get(replaced.row.id).product!.price!.basis,
      "jd-price",
    );
    replaced.jobs.update(
      replaced.jobId,
      "NEEDS_INPUT",
      "collect",
      "再次核验",
      replaced.row.id,
    );
    updateJobFacts(replaced.jobs, replaced.jobId, {
      values: { 补贴价: "55" },
      sourceUrl: replaced.row.product!.url,
    });
    assert.equal(
      replaced.store.get(replaced.row.id).product!.price!.value,
      "59",
    );
  } finally {
    replaced.store.close();
  }

  const conflicted = setup();
  try {
    conflicted.store.setMeta("listing-price:shop", "jd-regular-preferred");
    assert.throws(
      () =>
        updateJobFacts(conflicted.jobs, conflicted.jobId, {
          values: { 日常价: "59", 京东价: "60", 补贴价: "55" },
          sourceUrl: conflicted.row.product!.url,
        }),
      /日常价与京东价不一致/,
    );
    assert.equal(
      conflicted.store.get(conflicted.row.id).product!.price!.basis,
      "subsidy",
    );
  } finally {
    conflicted.store.close();
  }
});

test("legacy workbench mode still refuses to replace subsidy with JD price", () => {
  const s = setup();
  try {
    assert.throws(
      () =>
        updateJobFacts(s.jobs, s.jobId, {
          values: { 京东价: "59" },
          sourceUrl: s.row.product!.url,
        }),
      /补贴价.*京东价/,
    );
  } finally {
    s.store.close();
  }
});

test("regular-preferred explicit price reconfirmation refreshes time while unrelated facts do not", () => {
  const s = setup();
  try {
    const product = structuredClone(s.row.product!);
    product.price = {
      ...product.price!,
      value: "59",
      basis: "jd-price",
      capturedAt: "2024-01-01T00:00:00.000Z",
    };
    s.store.put("shop", product);
    s.store.setMeta("listing-price:shop", "jd-regular-preferred");
    updateJobFacts(s.jobs, s.jobId, {
      values: { 京东价: "59" },
      sourceUrl: product.url,
    });
    const refreshed = s.store.get(s.row.id).product!.price!;
    assert.notEqual(refreshed.capturedAt, "2024-01-01T00:00:00.000Z");

    const confirmedAt = refreshed.capturedAt;
    s.jobs.update(s.jobId, "NEEDS_INPUT", "collect", "再次核验", s.row.id);
    updateJobFacts(s.jobs, s.jobId, {
      values: { 包装数量: "2" },
      sourceUrl: product.url,
    });
    assert.equal(s.store.get(s.row.id).product!.price!.capturedAt, confirmedAt);
  } finally {
    s.store.close();
  }
});

test("packing display name changes only the plan and preserves source evidence and fallback binding", () => {
  const s = setup();
  try {
    const originalPacking = {
      ...s.row.product!.specs["包装名称"],
      value: "电蚊拍、充电线及使用说明书整套包装资料",
      evidence: "京东商品包装清单原始事实",
    };
    const product = structuredClone(s.row.product!);
    product.specs["包装名称"] = originalPacking;
    const sourceRow = s.store.put("shop", product);
    const context = {
      shop: "shop",
      sku: product.sku,
      source: "browser" as const,
    };
    const capture = new JdCaptureStore(s.store);
    capture.saveProduct(context, product);
    const cachedBefore: any = s.store.db
      .prepare(
        "SELECT * FROM jd_capture_facts WHERE shop=? AND sku=? AND field='包装名称'",
      )
      .get("shop", product.sku);
    const key = `jd-product-source:shop:${product.sku}`;
    s.store.setMeta(
      key,
      bindCanonicalBrowserSource({
        sku: product.sku,
        url: product.url,
        dataHash: sourceRow.dataHash,
      }),
    );

    updateJobFacts(s.jobs, s.jobId, {
      values: {},
      mediaReviewed: true,
      sourceUrl: product.url,
      packingDisplayName: "电蚊拍整套",
    });

    const updated = s.store.get(sourceRow.id);
    assert.deepEqual(updated.product!.specs["包装名称"], originalPacking);
    assert.equal(updated.plan!.fields.packingName.value, "电蚊拍整套");
    assert.equal(
      updated.plan!.fields.packingName.sourceUrl,
      originalPacking.sourceUrl,
    );
    assert.match(
      updated.plan!.fields.packingName.evidence,
      /完整包装名称.*电蚊拍、充电线及使用说明书整套包装资料.*仅用于包装清单显示/,
    );
    const cachedAfter: any = s.store.db
      .prepare(
        "SELECT * FROM jd_capture_facts WHERE shop=? AND sku=? AND field='包装名称'",
      )
      .get("shop", product.sku);
    assert.deepEqual(cachedAfter, cachedBefore);
    assert.ok(
      canonicalSourceBinding(s.store.meta(key), {
        sku: updated.product!.sku,
        url: updated.product!.url,
        dataHash: updated.dataHash,
      }),
    );
  } finally {
    s.store.close();
  }
});
