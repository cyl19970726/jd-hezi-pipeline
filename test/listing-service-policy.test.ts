import test from "node:test";
import assert from "node:assert/strict";
import { Catalog } from "../src/catalog.js";
import { example } from "../src/demo.js";
import { listingCustomizationPolicy } from "../src/listing-service-policy.js";
import { Preparation, preparationRequirements } from "../src/preparation.js";
import { Planner } from "../src/planner.js";
import { Store } from "../src/store.js";

const shop = "shop";
const approvedAt = new Date(Date.now() - 60_000).toISOString();
const approved = {
  version: 1,
  scope: "office-stationery",
  value: "不可定制",
  approvedAt,
  approval: "用户明确授权：普通文具统一不提供定制服务",
};

function setup(path: string) {
  const store = new Store(":memory:");
  new Catalog(store).import({
    shop,
    categories: [
      {
        id: "office-child",
        parentId: null,
        name: "中性笔",
        path: "办公用品 > 办公文具 > 书写工具 > 中性笔",
        selectable: true,
        sourceUrl: "https://b.csgmall.com.cn/",
        checkedAt: approved.approvedAt,
      },
      {
        id: "non-office",
        parentId: null,
        name: "抽纸",
        path: "家居用品 > 清洁用品 > 抽纸",
        selectable: true,
        sourceUrl: "https://b.csgmall.com.cn/",
        checkedAt: approved.approvedAt,
      },
    ],
    brands: [],
    grants: [],
  });
  const planner = new Planner(store);
  planner.importTemplate(shop, path, {
    categoryId: path,
    specs: ["是否可定制"],
    fields: [
      { id: "custom", name: "是否可定制", required: true, selectType: "1" },
    ],
    sourceUrl: "https://b.csgmall.com.cn/shop-view/",
    checkedAt: approved.approvedAt,
  });
  return store;
}

test("missing customization policy leaves the source requirement in place", () => {
  const store = setup("office-child");
  try {
    assert.equal(listingCustomizationPolicy(store, shop, "office-child"), null);
    assert.ok(
      preparationRequirements(store, shop, "office-child").includes(
        "是否可定制",
      ),
    );
  } finally {
    store.close();
  }
});

test("approved office-stationery policy supplies a shop fact without changing the source product", () => {
  const store = setup("office-child");
  try {
    store.setMeta("listing-customization-policy:" + shop, approved);
    const fact = listingCustomizationPolicy(store, shop, "office-child");
    assert.equal(fact?.value, "不可定制");
    assert.equal(
      fact?.sourceUrl,
      "http://127.0.0.1:4317/opportunity-execution",
    );
    assert.equal(fact?.capturedAt, approved.approvedAt);
    assert.match(fact?.evidence ?? "", /本店用户授权销售政策/);
    assert.ok(
      !preparationRequirements(store, shop, "office-child").includes(
        "是否可定制",
      ),
    );

    const { product } = example();
    const before = structuredClone(product);
    new Preparation(store).analyze(shop, product, ["商品毛重"]);
    assert.deepEqual(product, before);
    assert.equal(product.specs["是否可定制"], undefined);
  } finally {
    store.close();
  }
});

test("non-office categories and malformed approvals cannot remove the source requirement", () => {
  const nonOffice = setup("non-office");
  try {
    nonOffice.setMeta("listing-customization-policy:" + shop, approved);
    assert.equal(
      listingCustomizationPolicy(nonOffice, shop, "non-office"),
      null,
    );
    assert.ok(
      preparationRequirements(nonOffice, shop, "non-office").includes(
        "是否可定制",
      ),
    );
  } finally {
    nonOffice.close();
  }

  const invalid = setup("office-child");
  try {
    invalid.setMeta("listing-customization-policy:" + shop, {
      ...approved,
      approval: " ",
    });
    assert.equal(
      listingCustomizationPolicy(invalid, shop, "office-child"),
      null,
    );
    assert.ok(
      preparationRequirements(invalid, shop, "office-child").includes(
        "是否可定制",
      ),
    );
  } finally {
    invalid.close();
  }
});
