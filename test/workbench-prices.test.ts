import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.js";
import { example } from "../src/demo.js";
import { digest } from "../src/model.js";
import { workbenchPrices } from "../src/workbench-prices.js";

const now = Date.parse("2026-09-21T08:00:00.000Z");
const at = "2026-09-21T07:50:00.000Z";

function identity(product: ReturnType<typeof example>["product"]) {
  return digest({
    sku: product.sku,
    variant: product.variant,
    title: product.title,
    specs: product.specs,
    price: product.price,
  });
}

function fixture() {
  const store = new Store(":memory:");
  const { product, plan } = example();
  product.price = {
    ...product.price!,
    value: "100.00",
    basis: "jd-price",
    capturedAt: at,
  };
  plan.price = {
    ...plan.price,
    value: "89.10",
    basis: "competitor-bounded" as any,
  };
  plan.unit = "盒";
  plan.catalogBinding = { brandId: "brand-1", categoryId: "category-1" };
  const saved = store.put(plan.shop, product);
  store.setPlan(saved.id, plan);
  return { store, product, plan, id: saved.id };
}

test("a bound immutable review exposes the three prices and signed deltas", () => {
  const f = fixture();
  try {
    f.store.db.exec(
      "CREATE TABLE competitive_price_reviews(id TEXT PRIMARY KEY,shop TEXT,sku TEXT,identity_hash TEXT,payload TEXT,created_at TEXT)",
    );
    const reviewId = "review-1";
    const hash = identity(f.product);
    const payload = {
      preparedIdentityHash: hash,
      sourceJdPrice: f.product.price,
      competitorPrice: "90.00",
      marketCheckedAt: at,
      marketItemId: "market-1",
      marketSkuId: "market-sku-1",
      unit: "盒",
      categoryId: f.plan.catalogBinding!.categoryId,
      decision: { offerCents: 8910, minimumCents: 8500 },
    };
    const storedPayload = { ...payload, payloadHash: digest(payload) };
    f.store.db
      .prepare("INSERT INTO competitive_price_reviews VALUES(?,?,?,?,?,?)")
      .run(
        reviewId,
        f.plan.shop,
        f.product.sku,
        hash,
        JSON.stringify(storedPayload),
        at,
      );
    f.plan.competitivePricingReviewId = reviewId;
    f.store.setPlan(f.id, f.plan);
    const result = workbenchPrices(f.store, f.store.get(f.id), now);
    assert.deepEqual(result.jd?.value, "100.00");
    assert.deepEqual(result.competitor?.value, "90.00");
    assert.deepEqual(result.listing, {
      value: "89.10",
      basis: "competitor-bounded",
    });
    assert.equal(result.deltaVsJd, "-10.90");
    assert.equal(result.deltaVsCompetitor, "-0.90");
    assert.equal(result.reviewed, true);
    assert.equal(result.stale, false);
    assert.equal(result.minimum, "85.00");
    assert.match(result.note, /不表示全网最低或含运价/u);
  } finally {
    f.store.close();
  }
});

test("a historical reviewed decision remains visible but is marked stale", () => {
  const f = fixture();
  try {
    f.store.db.exec(
      "CREATE TABLE competitive_price_reviews(id TEXT PRIMARY KEY,shop TEXT,sku TEXT,identity_hash TEXT,payload TEXT,created_at TEXT)",
    );
    const hash = identity(f.product);
    const payload = {
      preparedIdentityHash: hash,
      sourceJdPrice: {
        ...f.product.price,
        capturedAt: "2026-09-21T06:00:00.000Z",
      },
      competitorPrice: "90.00",
      marketCheckedAt: "2026-09-21T06:00:00.000Z",
      marketItemId: "market-1",
      marketSkuId: "market-sku-1",
      unit: "盒",
      categoryId: f.plan.catalogBinding!.categoryId,
      decision: { offerCents: 8910, minimumCents: 8500 },
    };
    const storedPayload = { ...payload, payloadHash: digest(payload) };
    f.store.db
      .prepare("INSERT INTO competitive_price_reviews VALUES(?,?,?,?,?,?)")
      .run(
        "review-old",
        f.plan.shop,
        f.product.sku,
        hash,
        JSON.stringify(storedPayload),
        at,
      );
    f.plan.competitivePricingReviewId = "review-old";
    f.store.setPlan(f.id, f.plan);
    const result = workbenchPrices(f.store, f.store.get(f.id), now);
    assert.equal(result.reviewed, true);
    assert.equal(result.stale, true);
    assert.match(result.note, /历史决策/u);
  } finally {
    f.store.close();
  }
});

function addOpportunity(f: ReturnType<typeof fixture>, duplicate = false) {
  f.store.db.exec(`
    CREATE TABLE opportunity_cohorts(cohort_key TEXT PRIMARY KEY,shop TEXT);
    CREATE TABLE opportunity_rows(id TEXT PRIMARY KEY,cohort_key TEXT,target_sku TEXT,market_item_id TEXT,market_shop_id TEXT,market_sku_id TEXT);
    CREATE TABLE opportunity_evidence(id TEXT PRIMARY KEY,row_id TEXT,kind TEXT,observed_at TEXT,payload TEXT);
    CREATE TABLE opportunity_source_observations(id TEXT PRIMARY KEY,row_id TEXT,detail_receipt_id TEXT,product TEXT,comparison TEXT,price_issue TEXT,created_at TEXT);
    CREATE TABLE market_details(id TEXT PRIMARY KEY,shop TEXT,item_id TEXT,checked_at TEXT,payload TEXT);
  `);
  f.store.db
    .prepare("INSERT INTO opportunity_cohorts VALUES(?,?)")
    .run("wave", f.plan.shop);
  const insert = (id: string) =>
    f.store.db
      .prepare("INSERT INTO opportunity_rows VALUES(?,?,?,?,?,?)")
      .run(id, "wave", f.product.sku, "market-1", "other-shop", "market-sku-1");
  insert("row-1");
  if (duplicate) insert("row-2");
  const receipt = "detail-1";
  f.store.db.prepare("INSERT INTO opportunity_evidence VALUES(?,?,?,?,?)").run(
    "verified-1",
    "row-1",
    "source-product-verified",
    at,
    JSON.stringify({
      sourceSku: f.product.sku,
      detailReceiptId: receipt,
      fields: [{ field: "brand" }, { field: "model" }, { field: "packaging" }],
    }),
  );
  f.store.db
    .prepare(
      "INSERT INTO opportunity_source_observations VALUES(?,?,?,?,?,?,?)",
    )
    .run(
      "observation-1",
      "row-1",
      receipt,
      JSON.stringify(f.product),
      JSON.stringify({
        matched: true,
        sourceSku: f.product.sku,
        detailReceiptId: receipt,
      }),
      null,
      at,
    );
  f.store.db.prepare("INSERT INTO market_details VALUES(?,?,?,?,?)").run(
    receipt,
    f.plan.shop,
    "market-1",
    at,
    JSON.stringify({
      data: {
        itemSkuInfoList: [
          {
            id: "market-sku-1",
            itemId: "market-1",
            shopId: "other-shop",
            sellPrice: "90.00",
            skuUnit: "盒",
            minimumPurchase: 1,
          },
        ],
      },
    }),
  );
}

test("an exact verified opportunity is reference-only before final review", () => {
  const f = fixture();
  try {
    addOpportunity(f);
    const result = workbenchPrices(f.store, f.store.get(f.id), now);
    assert.equal(result.jd?.value, "100.00");
    assert.equal(result.competitor?.value, "90.00");
    assert.equal(result.listing?.value, "89.10");
    assert.equal(result.reviewed, false);
    assert.equal(result.minimum, null, "minimum purchase is not a price floor");
    assert.match(result.note, /尚未形成/u);
  } finally {
    f.store.close();
  }
});

test("ambiguous opportunity rows hide the competitor reference", () => {
  const f = fixture();
  try {
    addOpportunity(f, true);
    const result = workbenchPrices(f.store, f.store.get(f.id), now);
    assert.equal(result.jd?.value, "100.00");
    assert.equal(result.competitor, null);
    assert.equal(result.reviewed, false);
    assert.equal(result.deltaVsCompetitor, null);
  } finally {
    f.store.close();
  }
});

test("missing tables and missing rows return a bounded empty projection", () => {
  const f = fixture();
  try {
    const result = workbenchPrices(f.store, f.store.get(f.id), now);
    assert.equal(result.jd?.value, "100.00");
    assert.equal(result.competitor, null);
    assert.equal(result.reviewed, false);
    assert.equal(workbenchPrices(f.store, null, now).listing, null);
  } finally {
    f.store.close();
  }
});
