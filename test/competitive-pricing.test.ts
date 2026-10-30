import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.js";
import { CompetitivePricing } from "../src/competitive-pricing.js";
import { JdCaptureStore } from "../src/jd-capture.js";
import { normalizeProduct } from "../src/normalization.js";
import { prepareSaleText } from "../src/sale-text.js";
import type { Product } from "../src/model.js";

function fixture(options: { competitor?: number; condition?: boolean } = {}) {
  const store = new Store(":memory:");
  const now = new Date().toISOString();
  const sku = "900000001234";
  const url = `https://item.jd.com/${sku}.html`;
  const fact = (value: string) => ({
    value,
    sourceUrl: url,
    capturedAt: now,
    evidence: "fabricated exact SKU fact",
  });
  const product: Product = {
    sku,
    variant: "",
    url,
    title: fact("示例牌 AX1 单支装"),
    price: { ...fact("100.00"), basis: "jd-price" },
    specs: {
      品牌: fact("示例牌"),
      型号: fact("AX1"),
      京东销售规格: fact("单支装"),
    },
    assets: [],
    capturedAt: now,
  };
  const observedProduct = structuredClone(product);
  product.specs.规格 = {
    ...product.specs.京东销售规格,
    evidence:
      product.specs.京东销售规格.evidence + "；销售文字规则 sale-text/5",
  };
  store.db.exec(`
    CREATE TABLE opportunity_cohorts(cohort_key TEXT PRIMARY KEY,shop TEXT NOT NULL,source_report_id TEXT,imported_at TEXT,payload_hash TEXT,payload TEXT);
    CREATE TABLE opportunity_rows(id TEXT PRIMARY KEY,cohort_key TEXT,ordinal INTEGER,opportunity_id TEXT,market_item_id TEXT,market_shop_id TEXT,market_sku_id TEXT,rank INTEGER,target_sku TEXT,status TEXT,blockers TEXT,job_id TEXT,result_state TEXT,updated_at TEXT);
    CREATE TABLE opportunity_evidence(id TEXT PRIMARY KEY,row_id TEXT,kind TEXT,observed_at TEXT,payload TEXT);
    CREATE TABLE opportunity_source_observations(id TEXT PRIMARY KEY,row_id TEXT,detail_receipt_id TEXT,product TEXT,comparison TEXT,price_issue TEXT,created_at TEXT);
  `);
  store.db
    .prepare("INSERT INTO opportunity_cohorts VALUES(?,?,?,?,?,?)")
    .run("approved-wave", "shop-a", "report", now, "hash", "{}");
  store.db
    .prepare("INSERT INTO opportunity_rows VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(
      "row-1",
      "approved-wave",
      1,
      "opp-1",
      "market-1",
      "other-shop",
      "market-sku-1",
      1,
      sku,
      "READY_FOR_PREPARATION",
      "[]",
      null,
      null,
      now,
    );
  const payload = {
    code: 0,
    data: {
      itemId: "market-1",
      priceBenefitFlag: 0,
      itemPublishVo: {
        id: "market-1",
        shopId: "other-shop",
        brandName: "示例牌",
        saleStatus: 60,
        packingList: null,
        skuSpecMap: {
          "market-sku-1": [
            { attrName: "型号", attrValue: "AX1" },
            { attrName: "规格", attrValue: "单支装" },
          ],
        },
      },
      itemSkuInfoList: [
        {
          id: "market-sku-1",
          itemId: "market-1",
          shopId: "other-shop",
          skuName: "示例牌 AX1 单支装",
          sellPrice: options.competitor ?? 90,
          inventory: 10,
          skuStatus: 1,
          skuShelfStatus: 20,
          skuUnit: "支",
          specAttributes: "型号:AX1;规格:单支装;",
          modelCode: "AX1",
          minimumPurchase: options.condition ? 2 : 1,
          skuPicUrls: [{ url }],
        },
      ],
    },
  };
  const pricing = new CompetitivePricing(store);
  new JdCaptureStore(store).saveProduct(
    {
      shop: "shop-a",
      sku,
      source: "browser",
      accountContext: "account-a",
      regionContext: "region-a",
    },
    observedProduct,
    "facts",
  );
  const receipt = pricing.details.save(
    "shop-a",
    "market-1",
    "other-shop",
    payload,
    now,
    ["market-sku-1"],
  );
  store.db
    .prepare(
      "INSERT INTO opportunity_source_observations VALUES(?,?,?,?,?,?,?)",
    )
    .run(
      "obs-1",
      "row-1",
      receipt,
      JSON.stringify(observedProduct),
      "{}",
      null,
      now,
    );
  store.db
    .prepare("INSERT INTO opportunity_evidence VALUES(?,?,?,?,?)")
    .run(
      "evidence-1",
      "row-1",
      "source-product-verified",
      now,
      JSON.stringify({ sourceSku: sku, detailReceiptId: receipt }),
    );
  store.setMeta("competitive-price-policy:shop-a", {
    version: 1,
    cohortKey: "approved-wave",
    targetDiscountBps: 100,
    maxJdDiscountBps: 1500,
    approvedAt: now,
    approval: "user approved bounded new-product pricing",
  });
  return { store, pricing, product, payload, receipt };
}

test("build persists an immutable bounded review and verify recomputes it", () => {
  const f = fixture();
  try {
    const result = f.pricing.build("shop-a", f.product, "category-1", "支");
    assert.ok(result);
    assert.equal(result.price.value, "89.10");
    assert.equal(result.price.basis, "competitor-bounded");
    assert.equal(result.rulesVersion, "catalog-competitive-v1");
    assert.match(result.price.evidence, /不表示全网最低或含运价/u);
    const row: any = f.store.db
      .prepare("SELECT payload FROM competitive_price_reviews WHERE id=?")
      .get(result.competitivePricingReviewId);
    const review = JSON.parse(row.payload);
    assert.equal(review.decision.floorLimited, false);
    assert.equal(review.decision.competitorDeltaCents, 90);
    assert.doesNotThrow(() =>
      f.pricing.verify("shop-a", f.product, {
        shop: "shop-a",
        catalogBinding: { categoryId: "category-1" },
        unit: "支",
        competitivePricingReviewId: result.competitivePricingReviewId,
        price: result.price,
      }),
    );
  } finally {
    f.store.close();
  }
});

test("same-price fresh quote rebuilds an unpublished competitive review from raw observation", () => {
  const f = fixture();
  try {
    const original = f.pricing.build("shop-a", f.product, "category-1", "支")!;
    const saved = f.store.put("shop-a", f.product);
    const plan: any = {
      shop: "shop-a",
      catalogBinding: { categoryId: "category-1" },
      unit: "支",
      ...original,
    };
    f.store.setPlan(saved.id, plan);
    const capturedAt = new Date().toISOString();
    const quote = structuredClone(f.product);
    quote.price = { ...quote.price!, capturedAt };
    quote.capturedAt = capturedAt;
    const refreshed = { ...f.product, price: { ...quote.price } };
    f.store.db
      .prepare("INSERT INTO opportunity_evidence VALUES(?,?,?,?,?)")
      .run(
        "source-match-1",
        "row-1",
        "source-match",
        capturedAt,
        JSON.stringify({
          detailReceiptId: f.receipt,
          targetSku: f.product.sku,
        }),
      );
    const context = {
      shop: "shop-a",
      sku: f.product.sku,
      source: "browser" as const,
      accountContext: "account-a",
      regionContext: "region-a",
    };
    const rebuilt = f.store.tx(() => {
      new JdCaptureStore(f.store).saveProduct(context, refreshed, "price");
      return f.pricing.refreshUnpublishedSamePrice(
        "shop-a",
        f.product,
        refreshed,
        quote,
        plan,
      );
    });
    assert.notEqual(
      rebuilt.competitivePricingReviewId,
      original.competitivePricingReviewId,
    );
    assert.equal(rebuilt.price.value, original.price.value);
    const latest: any = f.store.db
      .prepare(
        "SELECT product FROM opportunity_source_observations WHERE row_id='row-1' ORDER BY created_at DESC,rowid DESC LIMIT 1",
      )
      .get();
    assert.equal(JSON.parse(latest.product).price.capturedAt, capturedAt);
  } finally {
    f.store.close();
  }
});

test("changed fresh quote rolls back competitive recovery evidence", () => {
  const f = fixture();
  try {
    const original = f.pricing.build("shop-a", f.product, "category-1", "支")!;
    const saved = f.store.put("shop-a", f.product);
    const plan: any = {
      shop: "shop-a",
      catalogBinding: { categoryId: "category-1" },
      unit: "支",
      ...original,
    };
    f.store.setPlan(saved.id, plan);
    const quote = structuredClone(f.product);
    quote.price = {
      ...quote.price!,
      value: "101.00",
      capturedAt: new Date().toISOString(),
    };
    const before = Number(
      (
        f.store.db
          .prepare("SELECT count(*) n FROM opportunity_source_observations")
          .get() as any
      ).n,
    );
    assert.throws(
      () =>
        f.store.tx(() => {
          new JdCaptureStore(f.store).saveProduct(
            {
              shop: "shop-a",
              sku: f.product.sku,
              source: "browser",
              accountContext: "account-a",
              regionContext: "region-a",
            },
            { ...f.product, price: { ...quote.price! } },
            "price",
          );
          f.pricing.refreshUnpublishedSamePrice(
            "shop-a",
            f.product,
            { ...f.product, price: { ...quote.price! } },
            quote,
            plan,
          );
        }),
      /基准不同/u,
    );
    const after = Number(
      (
        f.store.db
          .prepare("SELECT count(*) n FROM opportunity_source_observations")
          .get() as any
      ).n,
    );
    assert.equal(after, before);
  } finally {
    f.store.close();
  }
});

test("stale market comparison rolls back same-price recovery evidence", () => {
  const f = fixture();
  try {
    const original = f.pricing.build("shop-a", f.product, "category-1", "支")!;
    const saved = f.store.put("shop-a", f.product);
    const plan: any = {
      shop: "shop-a",
      catalogBinding: { categoryId: "category-1" },
      unit: "支",
      ...original,
    };
    f.store.setPlan(saved.id, plan);
    f.store.db
      .prepare("INSERT INTO opportunity_evidence VALUES(?,?,?,?,?)")
      .run(
        "source-match-stale",
        "row-1",
        "source-match",
        new Date().toISOString(),
        JSON.stringify({
          detailReceiptId: f.receipt,
          targetSku: f.product.sku,
        }),
      );
    f.store.db
      .prepare("UPDATE market_details SET checked_at=? WHERE id=?")
      .run("2000-01-01T00:00:00.000Z", f.receipt);
    const quote = structuredClone(f.product);
    quote.price = { ...quote.price!, capturedAt: new Date().toISOString() };
    const before = Number(
      (
        f.store.db
          .prepare("SELECT count(*) n FROM opportunity_source_observations")
          .get() as any
      ).n,
    );
    assert.throws(() =>
      f.store.tx(() => {
        new JdCaptureStore(f.store).saveProduct(
          {
            shop: "shop-a",
            sku: f.product.sku,
            source: "browser",
            accountContext: "account-a",
            regionContext: "region-a",
          },
          quote,
          "price",
        );
        f.pricing.refreshUnpublishedSamePrice(
          "shop-a",
          f.product,
          quote,
          quote,
          plan,
        );
      }),
    );
    const after = Number(
      (
        f.store.db
          .prepare("SELECT count(*) n FROM opportunity_source_observations")
          .get() as any
      ).n,
    );
    assert.equal(after, before);
  } finally {
    f.store.close();
  }
});

for (const protectedState of ["remote", "pending"] as const) {
  test(`competitive quote recovery rejects an unpublished ${protectedState} write boundary`, () => {
    const f = fixture();
    try {
      const original = f.pricing.build(
        "shop-a",
        f.product,
        "category-1",
        "支",
      )!;
      const saved = f.store.put("shop-a", f.product);
      const plan: any = {
        shop: "shop-a",
        catalogBinding: { categoryId: "category-1" },
        unit: "支",
        ...original,
      };
      f.store.setPlan(saved.id, plan);
      if (protectedState === "remote")
        f.store.db
          .prepare("UPDATE products SET remote_id='remote' WHERE id=?")
          .run(saved.id);
      else f.store.intent(saved.id, "save");
      const quote = structuredClone(f.product);
      quote.price = { ...quote.price!, capturedAt: new Date().toISOString() };
      assert.throws(
        () =>
          f.pricing.refreshUnpublishedSamePrice(
            "shop-a",
            f.product,
            quote,
            quote,
            plan,
          ),
        /仅未保存且无未决写入/u,
      );
    } finally {
      f.store.close();
    }
  });
}

test("accepts supported pen normalization plus a captured fresh quote refresh", () => {
  const f = fixture();
  try {
    const raw = structuredClone(f.product);
    raw.title.value = "示例牌 PX1 0.5mm黑色中性笔 12支装/盒";
    raw.price = {
      ...raw.price!,
      value: "101.00",
      capturedAt: new Date(Date.now() - 60_000).toISOString(),
    };
    raw.specs = {
      品牌: { ...raw.title, value: "示例牌" },
      型号: { ...raw.title, value: "PX1" },
      笔芯颜色: { ...raw.title, value: "黑色" },
      书写粗细: { ...raw.title, value: "0.5mm" },
      数量: { ...raw.title, value: "12支" },
      包装形式: { ...raw.title, value: "盒装" },
      包装清单: { ...raw.title, value: "12支装/盒" },
      京东销售规格: { ...raw.title, value: "PX1/黑色/12支装" },
    };
    const current = normalizeProduct(prepareSaleText(raw), [], {
      categoryId: "10041013",
    }).product;
    current.price = { ...f.product.price! };
    f.payload.data.itemPublishVo.brandName = "示例牌";
    (f.payload.data.itemPublishVo as any).categoryFullName = "办公用品>中性笔";
    (f.payload.data.itemPublishVo as any).itemName =
      "示例牌 中性笔 PX1 0.5mm 黑色 12支装 (单位:盒)";
    f.payload.data.itemPublishVo.skuSpecMap["market-sku-1"] = [
      { attrName: "型号", attrValue: "PX1" },
      { attrName: "规格", attrValue: "12支装" },
      { attrName: "笔芯颜色", attrValue: "黑色" },
      { attrName: "书写粗细", attrValue: "0.5mm" },
    ];
    Object.assign(f.payload.data.itemSkuInfoList[0], {
      skuName: "示例牌 中性笔 PX1 0.5mm 黑色 12支装 (单位:盒)",
      skuUnit: "盒",
      modelCode: "PX1",
      specAttributes: "型号:PX1;规格:12支装;笔芯颜色:黑色;书写粗细:0.5mm;",
    });
    f.store.db
      .prepare("UPDATE market_details SET payload=? WHERE id=?")
      .run(JSON.stringify(f.payload), f.receipt);
    f.store.db
      .prepare(
        "UPDATE opportunity_source_observations SET product=? WHERE id='obs-1'",
      )
      .run(JSON.stringify(raw));
    f.store.db.exec(
      "DELETE FROM jd_capture_facts; DELETE FROM jd_capture_checkpoints; DELETE FROM jd_price_snapshots;",
    );
    new JdCaptureStore(f.store).saveProduct(
      {
        shop: "shop-a",
        sku: current.sku,
        source: "browser",
        accountContext: "account-a",
        regionContext: "region-a",
      },
      current,
      "price",
    );
    assert.equal(current.specs.规格.value, "PX1/黑色/12支装");
    const result = f.pricing.build("shop-a", current, "10041013", "盒");
    assert.ok(result);
    const stored: any = f.store.db
      .prepare("SELECT payload FROM competitive_price_reviews WHERE id=?")
      .get(result.competitivePricingReviewId);
    const review = JSON.parse(stored.payload);
    assert.notEqual(
      review.rawObservationIdentityHash,
      review.preparedIdentityHash,
    );
  } finally {
    f.store.close();
  }
});

test("returns null outside an enabled policy or its frozen cohort", () => {
  const f = fixture();
  try {
    f.store.setMeta("competitive-price-policy:shop-a", null);
    assert.equal(
      f.pricing.build("shop-a", f.product, "category-1", "支"),
      null,
    );
    f.store.setMeta("competitive-price-policy:shop-a", {
      version: 1,
      cohortKey: "another-wave",
      targetDiscountBps: 100,
      maxJdDiscountBps: 1500,
      approvedAt: new Date().toISOString(),
      approval: "explicit",
    });
    assert.equal(
      f.pricing.build("shop-a", f.product, "category-1", "支"),
      null,
    );
  } finally {
    f.store.close();
  }
});

test("the JD floor blocks a review that cannot achieve one percent advantage", () => {
  const f = fixture({ competitor: 85 });
  try {
    assert.throws(
      () => f.pricing.build("shop-a", f.product, "category-1", "支"),
      /15%.*低1%/u,
    );
    assert.equal(
      f.store.db
        .prepare("SELECT COUNT(*) n FROM competitive_price_reviews")
        .get()?.n,
      0,
    );
  } finally {
    f.store.close();
  }
});

test("conditional purchases and ambiguous opportunity rows fail closed", () => {
  const conditioned = fixture({ condition: true });
  try {
    assert.throws(
      () =>
        conditioned.pricing.build(
          "shop-a",
          conditioned.product,
          "category-1",
          "支",
        ),
      /起购量|条件价/u,
    );
  } finally {
    conditioned.store.close();
  }
  const ambiguous = fixture();
  try {
    ambiguous.store.db
      .prepare(
        "INSERT INTO opportunity_rows VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        "row-2",
        "approved-wave",
        2,
        "opp-2",
        "market-2",
        "other-shop",
        "market-sku-2",
        2,
        ambiguous.product.sku,
        "BLOCKED",
        "[]",
        null,
        null,
        new Date().toISOString(),
      );
    assert.throws(
      () =>
        ambiguous.pricing.build(
          "shop-a",
          ambiguous.product,
          "category-1",
          "支",
        ),
      /不唯一/u,
    );
  } finally {
    ambiguous.store.close();
  }
});

test("verify rejects plan, policy, product, or live market drift", () => {
  for (const scenario of [
    "price",
    "unit",
    "policy",
    "product",
    "market",
  ] as const) {
    const f = fixture();
    try {
      const result = f.pricing.build("shop-a", f.product, "category-1", "支")!;
      const plan: any = {
        shop: "shop-a",
        catalogBinding: { categoryId: "category-1" },
        unit: "支",
        competitivePricingReviewId: result.competitivePricingReviewId,
        price: { ...result.price },
      };
      if (scenario === "price") plan.price.value = "1.00";
      if (scenario === "unit") plan.unit = "盒";
      if (scenario === "policy") {
        const policy = f.store.meta("competitive-price-policy:shop-a");
        policy.approval = "changed approval";
        f.store.setMeta("competitive-price-policy:shop-a", policy);
      }
      if (scenario === "product") f.product.title.value += " changed";
      if (scenario === "market")
        f.store.db
          .prepare("UPDATE market_details SET checked_at=? WHERE id=?")
          .run("2000-01-01T00:00:00.000Z", f.receipt);
      assert.throws(() => f.pricing.verify("shop-a", f.product, plan));
    } finally {
      f.store.close();
    }
  }
});

test("build refuses a new review once the source SKU already has a remote item", () => {
  const f = fixture();
  try {
    const saved = f.store.put("shop-a", f.product);
    f.store.db
      .prepare("UPDATE products SET remote_id='remote-1' WHERE id=?")
      .run(saved.id);
    assert.throws(
      () => f.pricing.build("shop-a", f.product, "category-1", "支"),
      /仅授权新品/u,
    );
  } finally {
    f.store.close();
  }
});
