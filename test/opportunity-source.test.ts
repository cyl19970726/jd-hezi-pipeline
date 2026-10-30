import assert from "node:assert/strict";
import test from "node:test";
import { Jobs } from "../src/jobs.js";
import type { Product } from "../src/model.js";
import { OpportunityExecution } from "../src/opportunity-execution.js";
import { OpportunitySources } from "../src/opportunity-source.js";
import { Store } from "../src/store.js";

function fact(value: string, at: string) {
  return {
    value,
    sourceUrl: "https://item.jd.com/123456.html",
    capturedAt: at,
    evidence: "JD商品页可见字段",
  };
}

function product(at: string, changes: Partial<Product> = {}): Product {
  return {
    sku: "123456",
    variant: "",
    url: "https://item.jd.com/123456.html",
    title: fact("示例商品", at),
    price: { ...fact("29.90", at), basis: "jd-price" },
    specs: {
      品牌: fact("示例品牌", at),
      型号: fact("M1", at),
      规格: fact("1盒", at),
    },
    assets: [],
    capturedAt: at,
    ...changes,
  };
}

function payload(
  attributes: Array<{ attributeName: string; attributeValue: string }> = [],
) {
  return {
    code: 0,
    data: {
      itemId: "market-item-9",
      itemPublishVo: {
        id: "market-item-9",
        shopId: "market-shop-7",
        brandId: "brand-1",
        cid: "category-1",
        brandName: "示例品牌",
        saleStatus: 60,
      },
      itemSkuInfoList: [
        {
          id: "market-sku-3",
          itemId: "market-item-9",
          shopId: "market-shop-7",
          targetSKU: "123456",
          skuName: "型号M1，规格1盒",
          sellPrice: "19.90",
          inventory: 3,
          skuStatus: 1,
          skuShelfStatus: 20,
          skuUnit: "盒",
          skuPicUrls: [{ url: "https://item.jd.com/123456.html" }],
          specAttributesList: [
            { attributeName: "型号", attributeValue: "M1" },
            { attributeName: "规格", attributeValue: "1盒" },
            ...attributes,
          ],
        },
      ],
    },
  };
}

function setup(checkedAt: string) {
  const store = new Store(":memory:");
  // Jobs owns its table; create the empty ledger before asserting source work writes none.
  new Jobs(store, "shop-a");
  const ledger = new OpportunityExecution(store);
  ledger.importCohort({
    cohortKey: "opportunity-source-v1",
    shop: "shop-a",
    sourceReportId: "report-v1",
    importedAt: checkedAt,
    rows: [
      {
        opportunityId: "opp-1",
        rank: 1,
        marketItemId: "market-item-9",
        marketShopId: "market-shop-7",
        marketSkuId: "market-sku-3",
        targetSku: null,
      },
    ],
  });
  const rowId = ledger.rows("opportunity-source-v1")[0].id;
  ledger.catalog.import({
    shop: "shop-a",
    categories: [
      {
        id: "category-1",
        parentId: null,
        name: "示例类目",
        path: "示例类目",
        selectable: true,
        sourceUrl: "https://merchant.example/category",
        checkedAt,
      },
    ],
    brands: [],
    grants: [],
  });
  store.setMeta("listing-price:shop-a", "jd-regular-preferred");
  return {
    store,
    ledger,
    sources: new OpportunitySources(store, ledger),
    rowId,
  };
}

function bind(
  ledger: OpportunityExecution,
  rowId: string,
  checkedAt: string,
  raw = payload(),
) {
  const receiptId = ledger.details.save(
    "shop-a",
    "market-item-9",
    "market-shop-7",
    raw,
    checkedAt,
    ["market-sku-3"],
  );
  ledger.acceptExactSource(rowId, {
    detailReceiptId: receiptId,
    brandId: "brand-1",
    categoryId: "category-1",
    unit: "盒",
  });
  return receiptId;
}

test("exact source observation is immutable and recording the same evidence is idempotent", () => {
  const now = Date.now();
  const at = new Date(now - 2_000).toISOString();
  const f = setup(at);
  try {
    bind(f.ledger, f.rowId, at);
    const input = product(at);
    const before = {
      products: (
        f.store.db.prepare("SELECT COUNT(*) n FROM products").get() as any
      ).n,
      jobs: (f.store.db.prepare("SELECT COUNT(*) n FROM jobs").get() as any).n,
    };
    const first = f.sources.record(f.rowId, input, now);
    input.specs.型号.value = "被调用方不得引用此变更";
    const second = f.sources.record(f.rowId, product(at), now);

    assert.equal(first.comparison.matched, true);
    assert.equal(second.id, first.id);
    assert.equal(f.sources.latest(f.rowId)?.product.specs.型号.value, "M1");
    assert.deepEqual(
      {
        products: (
          f.store.db.prepare("SELECT COUNT(*) n FROM products").get() as any
        ).n,
        jobs: (f.store.db.prepare("SELECT COUNT(*) n FROM jobs").get() as any)
          .n,
      },
      before,
    );
  } finally {
    f.store.close();
  }
});

test("a JD product for another SKU is rejected before it can replace source evidence or prepare", () => {
  const now = Date.now();
  const at = new Date(now - 2_000).toISOString();
  const f = setup(at);
  try {
    bind(f.ledger, f.rowId, at);
    const wrong = product(at, {
      sku: "654321",
      url: "https://item.jd.com/654321.html",
      title: {
        ...fact("示例商品", at),
        sourceUrl: "https://item.jd.com/654321.html",
      },
      price: {
        ...fact("29.90", at),
        sourceUrl: "https://item.jd.com/654321.html",
        basis: "jd-price",
      },
      specs: Object.fromEntries(
        Object.entries(product(at).specs).map(([name, value]) => [
          name,
          { ...value, sourceUrl: "https://item.jd.com/654321.html" },
        ]),
      ),
    });
    assert.throws(
      () => f.sources.record(f.rowId, wrong, now),
      /SKU与机会来源不一致/,
    );
    assert.equal(f.sources.latest(f.rowId), null);
    assert.throws(() => f.sources.assertPrepared(f.rowId, now), /尚未采集/);
  } finally {
    f.store.close();
  }
});

test("stale matching evidence and a missing labelled JD price cannot prepare", () => {
  const now = Date.now();
  const at = new Date(now - 3_600_001).toISOString();
  const f = setup(at);
  try {
    bind(f.ledger, f.rowId, at);
    const stale = f.sources.record(f.rowId, product(at, { price: null }), now);
    assert.equal(stale.comparison.matched, false);
    assert.match(stale.priceIssue ?? "", /缺少明确日常价/);
    assert.throws(
      () => f.sources.assertPrepared(f.rowId, now),
      /超过1小时|缺少明确日常价/,
    );
  } finally {
    f.store.close();
  }
});

test("a newer market receipt invalidates the saved comparison on recheck", () => {
  const now = Date.now();
  const firstAt = new Date(now - 3_000).toISOString();
  const secondAt = new Date(now - 1_000).toISOString();
  const f = setup(firstAt);
  try {
    bind(f.ledger, f.rowId, firstAt);
    f.sources.record(f.rowId, product(firstAt), now);
    bind(
      f.ledger,
      f.rowId,
      secondAt,
      payload([{ attributeName: "型号", attributeValue: "M2" }]),
    );
    assert.throws(
      () => f.sources.assertPrepared(f.rowId, now),
      /型号存在冲突|型号不一致/,
    );
  } finally {
    f.store.close();
  }
});

test("a newer failed source observation prevents preparation despite earlier verified evidence", () => {
  const now = Date.now();
  const at = new Date(now - 2_000).toISOString();
  const f = setup(at);
  try {
    bind(f.ledger, f.rowId, at);
    const accepted = f.sources.record(f.rowId, product(at), now);
    assert.equal(accepted.comparison.matched, true);
    const rejected = f.sources.record(
      f.rowId,
      product(at, { specs: { ...product(at).specs, 型号: fact("M2", at) } }),
      now + 1,
    );
    assert.equal(rejected.comparison.matched, false);
    assert.ok(
      rejected.comparison.blockers.some((message: string) =>
        /型号不一致/.test(message),
      ),
    );
    assert.throws(
      () => f.sources.assertPrepared(f.rowId, now + 1),
      /型号不一致/,
    );
  } finally {
    f.store.close();
  }
});

test("an older source observation cannot replace a newer failed pointer", () => {
  const now = Date.now();
  const olderAt = new Date(now - 4_000).toISOString();
  const newerAt = new Date(now - 2_000).toISOString();
  const f = setup(olderAt);
  try {
    bind(f.ledger, f.rowId, olderAt);
    f.sources.record(f.rowId, product(olderAt), now - 3_000);
    const newer = f.sources.record(
      f.rowId,
      product(newerAt, {
        specs: { ...product(newerAt).specs, 型号: fact("M2", newerAt) },
      }),
      now - 1_000,
    );
    assert.equal(newer.comparison.matched, false);
    assert.throws(
      () => f.sources.record(f.rowId, product(olderAt), now - 3_000),
      /早于已保存证据/,
    );
    assert.equal(f.sources.latest(f.rowId)?.id, newer.id);
    assert.equal(f.sources.latest(f.rowId)?.product.specs.型号.value, "M2");
  } finally {
    f.store.close();
  }
});

test("a material colour mismatch blocks an otherwise exact brand, model and packaging match", () => {
  const now = Date.now();
  const at = new Date(now - 2_000).toISOString();
  const f = setup(at);
  try {
    bind(
      f.ledger,
      f.rowId,
      at,
      payload([{ attributeName: "颜色", attributeValue: "红色" }]),
    );
    const withWrongColour = product(at, {
      specs: { ...product(at).specs, 颜色: fact("蓝色", at) },
    });
    const result = f.sources.record(f.rowId, withWrongColour, now);
    assert.equal(result.comparison.matched, false);
    assert.ok(
      result.comparison.blockers.some((message: string) =>
        /颜色.*不一致/.test(message),
      ),
    );
    assert.throws(() => f.sources.assertPrepared(f.rowId, now), /颜色.*不一致/);
  } finally {
    f.store.close();
  }
});
