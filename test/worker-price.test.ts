import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.js";
import { Jobs } from "../src/jobs.js";
import { Worker } from "../src/worker.js";
import { EgoBridge } from "../src/browser/bridge.js";
import { example } from "../src/demo.js";
import { Catalog } from "../src/catalog.js";
import { Planner } from "../src/planner.js";
import { SourceIndex } from "../src/source-index.js";
import { CompetitivePricing } from "../src/competitive-pricing.js";
import { JdCaptureStore } from "../src/jd-capture.js";
import { PipelineError, type Product } from "../src/model.js";
import { prepareSaleText } from "../src/sale-text.js";
const config = {
  shop: "ours",
  session: { spaceId: 3, hzPage: "p3", jdPage: "p8", profileId: "4" },
  listUrl: "",
  newUrl: "",
  editUrl: "",
  maxPages: 1,
};
function setupStructure(store: Store) {
  const now = new Date().toISOString();
  new SourceIndex(store);
  new Catalog(store).import({
    shop: "ours",
    categories: [
      {
        id: "category",
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
        scopes: [{ categoryId: "category", descendants: false }],
        sourceUrl: "https://b.csgmall.com.cn/",
        checkedAt: now,
      },
    ],
  });
  const planner = new Planner(store);
  planner.importTemplate("ours", "category", {
    categoryId: "category",
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
for (const protectedKind of [
  "none",
  "unknown-context",
  "planned",
  "remote",
  "pending",
] as const) {
  test(`incremental price path preserves existing facts and excludes ${protectedKind} inputs`, async () => {
    const s = new Store(":memory:");
    try {
      setupStructure(s);
      const { product, plan } = example();
      plan.shop = "ours";
      if (protectedKind === "none")
        product.price!.capturedAt = new Date(
          Date.now() - 3600000,
        ).toISOString();
      product.specs["商品毛重"] = { ...product.title, value: "1kg" };
      const row = s.put("ours", product);
      if (protectedKind === "planned") s.setPlan(row.id, plan);
      if (protectedKind === "remote")
        s.db
          .prepare("UPDATE products SET remote_id='known' WHERE id=?")
          .run(row.id);
      if (protectedKind === "pending")
        s.db
          .prepare(
            "INSERT INTO operations VALUES('intent',?,'save',?,'pending',NULL,?)",
          )
          .run(row.id, row.dataHash, new Date().toISOString());
      const before = s.get(row.id);
      const calls: string[] = [];
      const bridge = new EgoBridge();
      bridge.call = async (action, args: any) => {
        calls.push(action);
        if (action === "collect-regions")
          return {
            sku: product.sku,
            url: product.url,
            variant: product.variant,
            specs: {},
            observedAt: new Date().toISOString(),
            regions: args.regions,
            completeRegions: [],
          };
        if (action !== "refresh-price")
          throw Error("unexpected external operation");
        return {
          ...product,
          price: {
            ...product.price!,
            value: "21.90",
            capturedAt: new Date().toISOString(),
          },
          assets: [],
        };
      };
      const jobs = new Jobs(s, "ours");
      const batch = jobs.enqueue([product.sku], {
        brandId: "brand",
        categoryId: "category",
        policyId: "policy",
        unit: "件",
        through: "submit",
      });
      await new Worker(s, jobs, config, "/unused", bridge).run(
        jobs.get(batch.items[0].id),
      );
      const after = s.get(row.id);
      if (protectedKind === "none" || protectedKind === "unknown-context") {
        assert.deepEqual(calls, ["refresh-price", "collect-regions"]);
        assert.equal(after.product!.price!.value, "21.90");
        assert.deepEqual(after.product!.assets, product.assets);
        assert.deepEqual(after.product!.specs, product.specs);
      } else {
        assert.deepEqual(calls, []);
        assert.equal(after.dataHash, before.dataHash);
      }
    } finally {
      s.close();
    }
  });
}

test("unknown JD context refreshes and rebuilds an unchanged unpublished competitive plan", async () => {
  const s = new Store(":memory:");
  try {
    setupStructure(s);
    const now = new Date().toISOString();
    const sku = "900000009876";
    const url = `https://item.jd.com/${sku}.html`;
    const fact = (value: string) => ({
      value,
      sourceUrl: url,
      capturedAt: now,
      evidence: "合成当前SKU事实",
    });
    const raw: Product = {
      sku,
      variant: "",
      url,
      title: fact("示例品牌 AX1 单支装"),
      price: { ...fact("100.00"), basis: "jd-price" },
      specs: {
        品牌: fact("示例品牌"),
        型号: fact("AX1"),
        京东销售规格: fact("单支装"),
        商品毛重: fact("1kg"),
        包装名称: fact("笔"),
        包装数量: fact("1"),
      },
      assets: [],
      capturedAt: now,
    };
    const product = prepareSaleText(raw);
    s.db.exec(`
      CREATE TABLE opportunity_cohorts(cohort_key TEXT PRIMARY KEY,shop TEXT NOT NULL,source_report_id TEXT,imported_at TEXT,payload_hash TEXT,payload TEXT);
      CREATE TABLE opportunity_rows(id TEXT PRIMARY KEY,cohort_key TEXT,ordinal INTEGER,opportunity_id TEXT,market_item_id TEXT,market_shop_id TEXT,market_sku_id TEXT,rank INTEGER,target_sku TEXT,status TEXT,blockers TEXT,job_id TEXT,result_state TEXT,updated_at TEXT);
      CREATE TABLE opportunity_evidence(id TEXT PRIMARY KEY,row_id TEXT,kind TEXT,observed_at TEXT,payload TEXT);
      CREATE TABLE opportunity_source_observations(id TEXT PRIMARY KEY,row_id TEXT,detail_receipt_id TEXT,product TEXT,comparison TEXT,price_issue TEXT,created_at TEXT);
    `);
    s.db
      .prepare("INSERT INTO opportunity_cohorts VALUES(?,?,?,?,?,?)")
      .run("wave", "ours", "report", now, "hash", "{}");
    s.db
      .prepare(
        "INSERT INTO opportunity_rows VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        "row",
        "wave",
        1,
        "opp",
        "market",
        "competitor",
        "market-sku",
        1,
        sku,
        "READY_FOR_PREPARATION",
        "[]",
        null,
        null,
        now,
      );
    const pricing = new CompetitivePricing(s);
    const receipt = pricing.details.save(
      "ours",
      "market",
      "competitor",
      {
        code: 0,
        data: {
          itemId: "market",
          priceBenefitFlag: 0,
          itemPublishVo: {
            id: "market",
            shopId: "competitor",
            brandName: "示例品牌",
            saleStatus: 60,
            skuSpecMap: {
              "market-sku": [
                { attrName: "型号", attrValue: "AX1" },
                { attrName: "规格", attrValue: "单支装" },
              ],
            },
          },
          itemSkuInfoList: [
            {
              id: "market-sku",
              itemId: "market",
              shopId: "competitor",
              skuName: "示例品牌 AX1 单支装",
              sellPrice: 90,
              inventory: 10,
              skuStatus: 1,
              skuShelfStatus: 20,
              skuUnit: "件",
              specAttributes: "型号:AX1;规格:单支装;",
              modelCode: "AX1",
              minimumPurchase: 1,
              skuPicUrls: [{ url }],
            },
          ],
        },
      },
      now,
      ["market-sku"],
    );
    s.db
      .prepare(
        "INSERT INTO opportunity_source_observations VALUES(?,?,?,?,?,?,?)",
      )
      .run("obs", "row", receipt, JSON.stringify(raw), "{}", null, now);
    for (const [id, kind, payload] of [
      [
        "source-match",
        "source-match",
        { targetSku: sku, detailReceiptId: receipt },
      ],
      [
        "verified",
        "source-product-verified",
        { sourceSku: sku, detailReceiptId: receipt },
      ],
    ] as const)
      s.db
        .prepare("INSERT INTO opportunity_evidence VALUES(?,?,?,?,?)")
        .run(id, "row", kind, now, JSON.stringify(payload));
    s.setMeta("competitive-price-policy:ours", {
      version: 1,
      cohortKey: "wave",
      targetDiscountBps: 100,
      maxJdDiscountBps: 1500,
      approvedAt: now,
      approval: "用户批准新品有界竞品价",
    });
    s.setMeta("listing-price:ours", "jd-regular-preferred");
    new JdCaptureStore(s).saveProduct(
      {
        shop: "ours",
        sku,
        source: "browser",
        accountContext: "known-account",
        regionContext: "known-region",
      },
      raw,
      "facts",
    );
    const row = s.put("ours", product);
    const plan = new Planner(s).build(
      "ours",
      product,
      "brand",
      "category",
      "policy",
      "件",
    );
    s.setPlan(row.id, plan);
    const jobs = new Jobs(s, "ours");
    const item = jobs.enqueue([sku], {
      brandId: "brand",
      categoryId: "category",
      policyId: "policy",
      unit: "件",
      through: "draft",
    }).items[0];
    const calls: string[] = [];
    const bridge = new EgoBridge();
    bridge.call = async (action) => {
      calls.push(action);
      assert.equal(action, "refresh-price");
      const capturedAt = new Date().toISOString();
      return {
        ...raw,
        capturedAt,
        price: { ...raw.price!, capturedAt },
      };
    };
    await new Worker(s, jobs, config, "/unused", bridge, {
      collectAndroid: async () => raw,
      downloadAssets: async () => {
        throw new PipelineError("NEEDS_INPUT", "stop after price recovery");
      },
    }).run(jobs.get(item.id));
    assert.deepEqual(calls, ["refresh-price"]);
    const after = s.get(row.id);
    assert.equal(after.plan!.price.value, plan.price.value);
    assert.notEqual(
      after.plan!.competitivePricingReviewId,
      plan.competitivePricingReviewId,
    );
    assert.equal(jobs.get(item.id).stage, "assets");
    assert.doesNotMatch(
      String(jobs.get(item.id).error),
      /禁止静默覆盖售价|竞品定价的京东基准需刷新/u,
    );
  } finally {
    s.close();
  }
});
