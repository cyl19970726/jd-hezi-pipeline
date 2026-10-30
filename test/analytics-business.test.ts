import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.js";
import { Catalog } from "../src/catalog.js";
import { Jobs } from "../src/jobs.js";
import { AnalyticsBusiness } from "../src/analytics/business.js";
import {
  inferResearchBrand,
  titleSupportsBrand,
} from "../src/analytics/research-import.js";
import type { MarketCandidate } from "../src/analytics/types.js";

const shop = "test-shop";
const now = new Date();
const iso = (offsetMs = 0) => new Date(now.getTime() + offsetMs).toISOString();

function candidate(
  brand: string,
  marketBrandId: string,
  overrides: { title?: string; brandIdentitySource?: string } = {},
): MarketCandidate {
  return {
    id: `historical:${marketBrandId}`,
    platform: "hezi-market",
    shop: "public-shop",
    itemId: `item-${marketBrandId}`,
    skuId: `sku-${marketBrandId}`,
    title: overrides.title ?? `${brand} 测试商品`,
    brand,
    category: "测试类目",
    packaging: "1件",
    saleUnit: "件",
    sourceEntry: "fixture",
    field: "displaySales",
    fieldVersion: "v1",
    semanticsVersion: "cumulative-v1",
    currency: "CNY",
    scope: "historical",
    status: "comparable",
    reason: null,
    start: null,
    end: {
      id: `observation-${marketBrandId}`,
      runId: "run-1",
      observedAt: iso(),
      value: 1,
      priceMinor: 100,
      sourceEventAt: null,
      raw: {
        brandId: marketBrandId,
        brandIdentitySource: overrides.brandIdentitySource,
      },
      coverage: "complete",
    },
    delta: null,
    valueIndexMinor: 100,
    coverage: "complete",
    sampleScope: null,
    evidencePath: null,
  };
}

function business(brands: Array<{ id: string; name: string }>) {
  const store = new Store(":memory:");
  new Jobs(store, shop);
  new Catalog(store).import({
    shop,
    categories: [
      {
        id: "category-1",
        parentId: null,
        name: "测试类目",
        path: "测试类目",
        selectable: true,
        sourceUrl: "https://supplier.example/categories",
        checkedAt: iso(),
      },
    ],
    brands: brands.map((brand) => ({
      ...brand,
      sourceUrl: "https://supplier.example/brands",
      checkedAt: iso(),
    })),
    grants: brands.map((brand, index) => ({
      id: `grant-${index}`,
      brandId: brand.id,
      status: "approved" as const,
      validFrom: iso(-86_400_000),
      validUntil: iso(86_400_000),
      sourceUrl: "https://supplier.example/grants",
      checkedAt: iso(),
      scopes: [{ categoryId: "category-1", descendants: false }],
    })),
  });
  return { store, analytics: new AnalyticsBusiness(store, shop, () => []) };
}

test("maps market brand IDs to supplier brands only through a unique exact normalized name", () => {
  const { store, analytics } = business([
    { id: "900059", name: "维达(Vinda)" },
    { id: "900502", name: "南孚" },
  ]);
  try {
    const vinda = analytics.enrich(candidate("维达（Vinda）", "59"));
    assert.equal(vinda.marketBrandId, "59");
    assert.equal(vinda.supplierBrandId, "900059");
    assert.equal(vinda.brandId, "900059");
    assert.equal(vinda.brandMatchSource, "unique-normalized-catalog-name");
    assert.equal(vinda.brandMatchEvidence.supplierBrandName, "维达(Vinda)");
    assert.equal(vinda.authorizationStatus, "scope-needs-review");
    assert.equal(vinda.readiness, "needs-review");
    assert.equal(vinda.canPublish, false);
    assert.equal(
      vinda.operationalReadiness.hints.authority,
      "preliminary-name-hints-only",
    );
    assert.equal(
      vinda.operationalReadiness.authorization.status,
      "needs-input",
    );
    assert.equal(vinda.operationalReadiness.eligibility.ready, false);

    const nanfu = analytics.enrich(candidate("南孚", "502"));
    assert.equal(nanfu.marketBrandId, "502");
    assert.equal(nanfu.supplierBrandId, "900502");
  } finally {
    store.close();
  }
});

test("blocks a coincidental supplier-ID collision with a different catalog name", () => {
  const { store, analytics } = business([
    { id: "502", name: "其他品牌" },
    { id: "900502", name: "南孚" },
  ]);
  try {
    const result = analytics.enrich(candidate("南孚", "502"));
    assert.equal(result.brandIdentityConflict, true);
    assert.equal(result.supplierBrandId, null);
    assert.equal(result.authorizationStatus, "missing");
    assert.equal(result.brandMatchSource, "market-id-catalog-name-conflict");
    assert.match(result.nextAction, /冲突/);
    assert.equal(result.canPublish, false);
  } finally {
    store.close();
  }
});

test("does not bind an ambiguous normalized catalog brand name", () => {
  const { store, analytics } = business([
    { id: "brand-a", name: "A-B" },
    { id: "brand-b", name: "AB" },
  ]);
  try {
    const result = analytics.enrich(candidate("A B", "market-ab"));
    assert.equal(result.brandIdentityConflict, false);
    assert.equal(result.supplierBrandId, null);
    assert.equal(result.brandMatchSource, null);
    assert.equal(result.authorizationStatus, "missing");
    assert.equal(result.canPublish, false);
  } finally {
    store.close();
  }
});

test("title inference requires brand-position evidence and Latin token boundaries", () => {
  const brands = ["示例丁品牌", "美的(Midea)", "普联(TP-LINK)", "茶花(CHAHUA)"];
  assert.equal(
    inferResearchBrand("邦耀电力 事故照明配电箱 SMG1-2 单位：个", brands).brand,
    null,
  );
  assert.equal(
    inferResearchBrand("苏泊尔 烧水壶 SW-40C02 灰色 4L", brands).brand,
    null,
  );
  assert.equal(
    inferResearchBrand("Midea 空调 1.5匹", brands).brand,
    "美的(Midea)",
  );
  assert.equal(
    inferResearchBrand("TP-LINK 路由器 AX3000", brands).brand,
    "普联(TP-LINK)",
  );
  assert.equal(inferResearchBrand("3M 电工胶带", ["3M"]).brand, "3M");
  assert.equal(
    inferResearchBrand("凯洁 地垫 入门垫", ["凯洁地垫"]).brand,
    "凯洁地垫",
  );
  assert.equal(titleSupportsBrand("SMG1-2 配电箱", "示例丁品牌"), false);
});

test("legacy title-derived brands without current title evidence stay in review", () => {
  const { store, analytics } = business([
    { id: "morning-light", name: "示例丁品牌" },
  ]);
  try {
    const result = analytics.enrich(
      candidate("示例丁品牌", "59", {
        title: "邦耀电力 事故照明配电箱 SMG1-2 单位：个",
        brandIdentitySource: "title-matched-shop-brand-list",
      }),
    );
    assert.equal(result.titleBrandEvidenceConflict, true);
    assert.equal(result.brandIdentityConflict, true);
    assert.equal(result.supplierBrandId, null);
    assert.equal(result.brandMatchSource, "title-brand-evidence-conflict");
    assert.equal(result.route, "review");
    assert.equal(result.canPublish, false);
  } finally {
    store.close();
  }
});
