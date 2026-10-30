import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.js";
import { example } from "../src/demo.js";
import { JdCaptureStore } from "../src/jd-capture.js";

const context = {
  shop: "ours",
  sku: example().product.sku,
  source: "browser" as const,
  accountContext: "account-a",
  regionContext: "cn-31",
};

test("capture checkpoint reuses only a fresh price in the same SKU and context", () => {
  const store = new Store(":memory:");
  try {
    const capture = new JdCaptureStore(store);
    const product = example().product;
    capture.saveProduct(context, product);
    const observed = Date.parse(product.price!.capturedAt);
    assert.equal(
      capture.product(context, { now: observed + 1000 })?.sku,
      product.sku,
    );
    assert.equal(
      capture.product({ ...context, sku: "999" }, { now: observed + 1000 }),
      null,
    );
    assert.equal(
      capture.product(
        { ...context, accountContext: "", regionContext: "" },
        { now: observed + 1000 },
      ),
      null,
    );
    assert.equal(
      capture.product(
        { ...context, regionContext: "cn-11" },
        { now: observed + 1000 },
      ),
      null,
    );
    assert.equal(
      capture.product(context, { now: observed + 30 * 60 * 1000 + 1 }),
      null,
    );
  } finally {
    store.close();
  }
});

test("a different source snapshot cannot renew an embedded browser quote", () => {
  const store = new Store(":memory:");
  try {
    const capture = new JdCaptureStore(store),
      p = example().product;
    capture.saveProduct(context, p);
    capture.saveProduct(
      { ...context, source: "android" },
      {
        ...p,
        price: { ...p.price!, value: "88.00", evidence: "手机明确京东价" },
      },
    );
    const at = Date.parse(p.price!.capturedAt) + 1000;
    assert.equal(
      capture.product(context, { now: at })?.price?.value,
      p.price!.value,
    );
    const row: any = store.db
      .prepare(
        "SELECT product_json FROM jd_capture_checkpoints WHERE source='browser'",
      )
      .get();
    const stale = JSON.parse(String(row.product_json));
    stale.price.value = "88.00";
    store.db
      .prepare(
        "UPDATE jd_capture_checkpoints SET product_json=? WHERE source='browser'",
      )
      .run(JSON.stringify(stale));
    assert.equal(capture.product(context, { now: at }), null);
  } finally {
    store.close();
  }
});

test("legacy price table migrates transactionally as non-reusable evidence", () => {
  const store = new Store(":memory:");
  try {
    store.db.exec(
      `CREATE TABLE jd_price_snapshots(shop TEXT NOT NULL,sku TEXT NOT NULL,basis TEXT NOT NULL,value TEXT NOT NULL,source_url TEXT NOT NULL,evidence TEXT NOT NULL,account_context TEXT NOT NULL,region_context TEXT NOT NULL,observed_at TEXT NOT NULL,parser_version TEXT NOT NULL,PRIMARY KEY(shop,sku));`,
    );
    store.db
      .prepare("INSERT INTO jd_price_snapshots VALUES(?,?,?,?,?,?,?,?,?,?)")
      .run(
        context.shop,
        context.sku,
        "jd-price",
        "21.90",
        example().product.url,
        "旧版明确京东价",
        context.accountContext,
        context.regionContext,
        example().product.capturedAt,
        "jd-product-v1",
      );
    const capture = new JdCaptureStore(store);
    const columns = store.db
      .prepare("PRAGMA table_info(jd_price_snapshots)")
      .all()
      .map((row: any) => String(row.name));
    assert.ok(columns.includes("source"));
    const migrated: any = store.db
      .prepare("SELECT * FROM jd_price_snapshots")
      .get();
    assert.equal(migrated.source, "legacy-unknown");
    assert.equal(migrated.value, "21.90");
    assert.equal(capture.price(context), null);
  } finally {
    store.close();
  }
});

test("page reuse requires explicit matching response identity and freshness", () => {
  const store = new Store(":memory:");
  try {
    const capture = new JdCaptureStore(store),
      url = example().product.url;
    const at = "2026-09-11T00:00:00.000Z";
    capture.observePage(context, url, context.sku, at);
    assert.equal(
      capture.reusablePage(context, url, { now: Date.parse(at) + 1000 }),
      true,
    );
    assert.equal(
      capture.reusablePage({ ...context, accountContext: "account-b" }, url, {
        now: Date.parse(at) + 1000,
      }),
      false,
    );
    assert.equal(
      capture.reusablePage(context, url, {
        now: Date.parse(at) + 10 * 60 * 1000 + 1,
      }),
      false,
    );
    assert.throws(() => capture.observePage(context, url, "999"), /身份不一致/);
  } finally {
    store.close();
  }
});

test("facts, staged media associations and access metrics remain SKU-scoped", () => {
  const store = new Store(":memory:");
  try {
    const capture = new JdCaptureStore(store),
      p = example().product;
    capture.saveProduct(context, p, "media");
    capture.metric(context, {
      stage: "assets",
      reason: "url-cache",
      cacheHits: 2,
      downloads: 0,
    });
    const checkpoint: any = store.db
      .prepare("SELECT * FROM jd_capture_checkpoints")
      .get();
    const media: any[] = store.db.prepare("SELECT * FROM jd_media_links").all();
    const metric: any = store.db
      .prepare("SELECT * FROM jd_access_metrics")
      .get();
    assert.equal(checkpoint.stage, "media");
    assert.ok(media.every((x) => x.sku === p.sku));
    assert.equal(metric.cache_hits, 2);
    assert.equal(metric.downloads, 0);
  } finally {
    store.close();
  }
});

test("conflicting stable facts and original media invalidate reuse instead of overwriting", () => {
  const store = new Store(":memory:");
  try {
    const capture = new JdCaptureStore(store),
      p = example().product;
    capture.saveProduct(context, p);
    assert.throws(
      () =>
        capture.saveProduct(context, {
          ...p,
          title: { ...p.title, value: "另一件商品" },
        }),
      /字段来源冲突/,
    );
    const withHash = {
      ...p,
      assets: p.assets.map((a, i) => ({
        ...a,
        originalSha256: `${i ? "b" : "a"}`.repeat(64),
      })),
    };
    capture.saveProduct(context, withHash);
    assert.throws(
      () =>
        capture.saveProduct(context, {
          ...withHash,
          assets: withHash.assets.map((a, i) =>
            i === 0 ? { ...a, originalSha256: "c".repeat(64) } : a,
          ),
        }),
      /原图内容冲突/,
    );
  } finally {
    store.close();
  }
});

test("rule-derived cache rows are removed without weakening raw source conflicts", () => {
  const store = new Store(":memory:");
  try {
    const capture = new JdCaptureStore(store),
      p = example().product;
    p.specs["京东销售规格"] = {
      ...p.title,
      value: "【升级大瓶】700ml/瓶（无香型）",
      evidence: "京东商品业务响应 color",
    };
    capture.saveProduct(context, p);
    store.db
      .prepare(
        `INSERT INTO jd_capture_facts VALUES(?,?,?,?,?,?,?,?)
         ON CONFLICT(shop,sku,field) DO UPDATE SET
           value_json=excluded.value_json,evidence=excluded.evidence`,
      )
      .run(
        context.shop,
        context.sku,
        "规格",
        JSON.stringify("升级大瓶700ml/瓶（无香型）"),
        p.url,
        "京东商品业务响应 color；销售文字规则 sale-text/3",
        p.capturedAt,
        "jd-product-v1",
      );

    const prepared = structuredClone(p);
    prepared.specs["规格"] = {
      ...p.specs["京东销售规格"],
      value: "700ml/瓶（无香型）",
      evidence: "京东商品业务响应 color；销售文字规则 sale-text/4",
    };
    assert.doesNotThrow(() => capture.saveProduct(context, prepared, "media"));
    assert.equal(
      store.db
        .prepare(
          "SELECT COUNT(*) AS n FROM jd_capture_facts WHERE shop=? AND sku=? AND field='规格'",
        )
        .get(context.shop, context.sku)?.n,
      0,
    );
    assert.equal(
      JSON.parse(
        String(
          store.db
            .prepare(
              "SELECT value_json FROM jd_capture_facts WHERE shop=? AND sku=? AND field='京东销售规格'",
            )
            .get(context.shop, context.sku)?.value_json,
        ),
      ),
      p.specs["京东销售规格"].value,
    );
    const pruneEvent: any = store.db
      .prepare(
        "SELECT detail FROM events WHERE event='JD_DERIVED_FACTS_PRUNED'",
      )
      .get();
    assert.deepEqual(JSON.parse(String(pruneEvent.detail)).facts, [
      {
        field: "规格",
        value: "升级大瓶700ml/瓶（无香型）",
        sourceUrl: p.url,
        evidence: "京东商品业务响应 color；销售文字规则 sale-text/3",
        observedAt: p.capturedAt,
        parserVersion: "jd-product-v1",
      },
    ]);

    const rawConflict = structuredClone(prepared);
    rawConflict.specs["京东销售规格"] = {
      ...rawConflict.specs["京东销售规格"],
      value: "另一个真实销售规格",
    };
    assert.throws(
      () => capture.saveProduct(context, rawConflict),
      /京东字段来源冲突.*京东销售规格/,
    );

    const markerDoesNotExemptRaw = structuredClone(prepared);
    markerDoesNotExemptRaw.specs["京东销售规格"] = {
      ...markerDoesNotExemptRaw.specs["京东销售规格"],
      value: "又一个真实销售规格",
      evidence: "原始京东字段恰含销售文字规则 sale-text/4字样",
    };
    assert.throws(
      () => capture.saveProduct(context, markerDoesNotExemptRaw),
      /京东字段来源冲突.*京东销售规格/,
    );
  } finally {
    store.close();
  }
});
