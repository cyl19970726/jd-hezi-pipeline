import { test } from "node:test";
import assert from "node:assert/strict";
import { Catalog, type CatalogBatch } from "../src/catalog.js";
import { Store } from "../src/store.js";
import { example } from "../src/demo.js";
function fixture() {
  const store = new Store(":memory:");
  const catalog = new Catalog(store);
  const { plan } = example();
  const checkedAt = new Date().toISOString();
  const sourceUrl = "https://b.csgmall.com.cn/";
  const ev = { checkedAt, sourceUrl };
  const data: CatalogBatch = {
    shop: plan.shop,
    brands: [{ id: "b", name: plan.brand, ...ev }],
    categories: [
      {
        id: "root",
        parentId: null,
        name: "根",
        path: "根",
        selectable: false,
        ...ev,
      },
      {
        id: "leaf",
        parentId: "root",
        name: "叶",
        path: plan.categoryPath,
        selectable: true,
        ...ev,
      },
    ],
    grants: [
      {
        id: "g",
        brandId: "b",
        status: "approved",
        validFrom: new Date(Date.now() - 86400000).toISOString(),
        validUntil: new Date(Date.now() + 86400000).toISOString(),
        scopes: [{ categoryId: "root", descendants: true }],
        ...ev,
      },
    ],
  };
  plan.catalogBinding = { brandId: "b", categoryId: "leaf" };
  return { store, catalog, plan, data };
}
test("approved ancestor authorizes only with explicit descendant scope; pending extension does not replace approval", () => {
  const s = fixture();
  try {
    s.catalog.import(s.data);
    assert.equal(s.catalog.authorize(s.plan).grantId, "g");
    s.data.grants = [{ ...s.data.grants[0], id: "pending", status: "pending" }];
    s.catalog.import(s.data);
    assert.equal(s.catalog.authorize(s.plan).grantId, "g");
    s.data.grants = [
      {
        ...s.data.grants[0],
        id: "g",
        status: "approved",
        scopes: [{ categoryId: "root", descendants: false }],
      },
    ];
    s.catalog.import(s.data);
    assert.throws(() => s.catalog.authorize(s.plan), /没有覆盖/);
  } finally {
    s.store.close();
  }
});
test("missing IDs, wrong shop, stale and expired authorization fail closed", () => {
  const s = fixture();
  try {
    s.catalog.import(s.data);
    assert.throws(() =>
      s.catalog.authorize({ ...s.plan, catalogBinding: undefined }),
    );
    assert.throws(() => s.catalog.authorize({ ...s.plan, shop: "another" }));
    assert.throws(() => s.catalog.authorize({ ...s.plan, brand: "wrong" }));
    assert.throws(() => s.catalog.authorize(s.plan, Date.now() + 2 * 86400000));
    s.data.grants[0].validUntil = new Date(Date.now() - 1000).toISOString();
    s.catalog.import(s.data);
    assert.throws(() => s.catalog.authorize(s.plan));
  } finally {
    s.store.close();
  }
});
test("category cycle import rolls back entire batch", () => {
  const s = fixture();
  try {
    s.data.categories[0].parentId = "leaf";
    assert.throws(() => s.catalog.import(s.data), /存在环/);
    assert.equal(s.catalog.summary(s.plan.shop).categories.length, 0);
  } finally {
    s.store.close();
  }
});
test("partial or empty sync never deletes previously seen items or invents source identity", () => {
  const s = fixture();
  try {
    const first = s.catalog.beginSync(s.plan.shop, "draft");
    s.catalog.finishSync(
      first,
      [{ itemId: "123", code: "456", title: "x", status: "草稿" }],
      false,
    );
    const next = s.catalog.beginSync(s.plan.shop, "draft");
    s.catalog.finishSync(next, [], true);
    const summary = s.catalog.summary(s.plan.shop);
    assert.equal(summary.inventory?.total, 1);
    assert.equal(summary.inventory?.unresolved, 1);
    assert.equal(
      summary.syncRuns.filter((r) => r.status === "partial").length,
      1,
    );
    assert.throws(() => s.catalog.finishSync(first, [], true));
  } finally {
    s.store.close();
  }
});

test("page catalog distinguishes brand identity from application identity and builds tree paths", async () => {
  const { parseHTML } = await import("linkedom");
  const { readCatalogOptions } = await import("../src/browser/catalog.js");
  const { document } = parseHTML('<div id="app"></div>');
  Object.assign(globalThis, {
    document,
    location: { href: "https://b.csgmall.com.cn/shop-view/" },
  });
  (document.querySelector("#app") as any).__vue_app__ = {
    _container: {
      _vnode: {
        children: [
          {
            props: {
              id: "form_item_brandId",
              options: [{ id: 61723, value: 9900001, label: "示例甲品牌" }],
            },
          },
          {
            props: {
              id: "form_item_categoryId",
              treeData: [
                {
                  id: 1,
                  categoryName: "家居",
                  children: [{ id: 2, categoryName: "饵剂" }],
                },
              ],
            },
          },
        ],
      },
    },
  };
  const result = readCatalogOptions();
  assert.equal(result.brands[0].id, "9900001");
  assert.equal(result.categories[1].parentId, "1");
  assert.equal(result.categories[1].path, "家居 > 饵剂");
  assert.equal(result.categories[0].selectable, false);
});

test("catalog readiness waits for both page-bound option lists", async () => {
  const { parseHTML } = await import("linkedom");
  const { catalogOptionsReady } = await import("../src/browser/catalog.js");
  const { document } = parseHTML('<div id="app"></div>');
  Object.assign(globalThis, { document });
  const categoryProps = { id: "form_item_categoryId", treeData: [] as any[] };
  const brandProps = { id: "form_item_brandId", options: [] as any[] };
  (document.querySelector("#app") as any).__vue_app__ = {
    _container: {
      _vnode: { children: [{ props: categoryProps }, { props: brandProps }] },
    },
  };

  assert.deepEqual(catalogOptionsReady(), {
    ready: false,
    categoryCount: 0,
    brandCount: 0,
    categoryControl: true,
    brandControl: true,
  });
  categoryProps.treeData.push({ id: 1, categoryName: "家居" });
  brandProps.options.push({ value: 9900001, label: "示例甲品牌" });
  assert.deepEqual(catalogOptionsReady(), {
    ready: true,
    categoryCount: 1,
    brandCount: 1,
    categoryControl: true,
    brandControl: true,
  });
});

test("creation requires recent complete scans of both partitions with resolved source identities", () => {
  const store = new Store(":memory:"),
    c = new Catalog(store);
  try {
    assert.equal(c.inventoryComplete("s"), false);
    c.finishSync(c.beginSync("s", "draft"), [], true);
    c.finishSync(
      c.beginSync("s", "normal"),
      [{ itemId: "1", code: "1", title: "x", status: "待审核" }],
      true,
    );
    assert.equal(c.inventoryComplete("s"), false);
    c.finishSync(
      c.beginSync("s", "normal"),
      [{ itemId: "1", code: "1", title: "x", status: "待审核", sku: "2" }],
      true,
    );
    assert.equal(c.inventoryComplete("s"), true);
  } finally {
    store.close();
  }
});
