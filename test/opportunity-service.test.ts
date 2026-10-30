import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Jobs } from "../src/jobs.js";
import { MarketDetails } from "../src/market-details.js";
import type { Product } from "../src/model.js";
import { OpportunityService } from "../src/opportunity-service.js";
import { SourceReuse, sourceContext } from "../src/source-reuse.js";
import { Store } from "../src/store.js";

const at = "2026-09-20T04:00:00.000Z";

function manifest(shop = "shop-a", rows = [row("opp-1", "101")]) {
  return {
    cohortKey: "opportunity-cohort-v1",
    shop,
    sourceReportId: "sanitized-report-v1",
    importedAt: at,
    rows,
  };
}

function row(opportunityId: string, marketSkuId: string) {
  return {
    opportunityId,
    rank: 1,
    marketShopId: "market-shop-7",
    marketItemId: "market-item-9-" + marketSkuId,
    marketSkuId,
    targetSku: null,
    title: "消毒湿巾",
    brand: "示例品牌",
  };
}

async function fixture(input = manifest()) {
  const root = await mkdtemp(join(tmpdir(), "hezi-opportunity-service-"));
  await writeFile(
    join(root, "opportunity-execution.json"),
    JSON.stringify(input),
  );
  const store = new Store(join(root, "state.sqlite"));
  const jobs = new Jobs(store, "shop-a");
  return {
    root,
    store,
    jobs,
    service: new OpportunityService(store, jobs, root, "shop-a"),
  };
}

async function close(f: Awaited<ReturnType<typeof fixture>>) {
  f.store.close();
  await rm(f.root, { recursive: true, force: true });
}

function jdFact(value: string, checkedAt: string) {
  return {
    value,
    sourceUrl: "https://item.jd.com/123456.html",
    capturedAt: checkedAt,
    evidence: "JD商品页的可见字段",
  };
}

function collectedProduct(checkedAt: string): Product {
  return {
    sku: "123456",
    variant: "",
    url: "https://item.jd.com/123456.html",
    title: jdFact("示例湿巾", checkedAt),
    price: { ...jdFact("29.90", checkedAt), basis: "jd-price" },
    specs: {
      品牌: jdFact("示例品牌", checkedAt),
      型号: jdFact("M1", checkedAt),
      规格: jdFact("1盒", checkedAt),
    },
    assets: [],
    capturedAt: checkedAt,
  };
}

async function sourceCandidate(f: Awaited<ReturnType<typeof fixture>>) {
  const opportunity = f.service.read().rows[0];
  const checkedAt = new Date().toISOString();
  f.service.ledger.catalog.import({
    shop: "shop-a",
    categories: [
      {
        id: "category-1",
        parentId: null,
        name: "类目",
        path: "类目",
        selectable: true,
        sourceUrl: "https://merchant.example/category",
        checkedAt,
      },
    ],
    brands: [],
    grants: [],
  });
  const receiptId = new MarketDetails(f.store).save(
    "shop-a",
    opportunity.marketItemId,
    opportunity.marketShopId,
    {
      code: 0,
      data: {
        itemId: opportunity.marketItemId,
        itemPublishVo: {
          id: opportunity.marketItemId,
          shopId: opportunity.marketShopId,
          brandId: "brand-1",
          cid: "category-1",
          brandName: "示例品牌",
          saleStatus: 60,
        },
        itemSkuInfoList: [
          {
            id: opportunity.marketSkuId,
            itemId: opportunity.marketItemId,
            shopId: opportunity.marketShopId,
            targetSKU: "123456",
            skuName: "型号M1，规格1盒",
            sellPrice: "19.90",
            inventory: 1,
            skuStatus: 1,
            skuShelfStatus: 20,
            skuUnit: "盒",
            skuPicUrls: [{ url: "https://item.jd.com/123456.html" }],
            specAttributesList: [
              { attributeName: "型号", attributeValue: "M1" },
              { attributeName: "规格", attributeValue: "1盒" },
            ],
          },
        ],
      },
    },
    checkedAt,
    [opportunity.marketSkuId],
  );
  f.service.ledger.acceptExactSource(opportunity.id, {
    detailReceiptId: receiptId,
    brandId: "brand-1",
    categoryId: "category-1",
    unit: "盒",
  });
  await writeFile(
    join(f.root, "opportunity-session.json"),
    JSON.stringify({
      spaceId: 1,
      hzPage: "hz-page",
      jdPage: "jd-page",
      profileId: "profile",
    }),
  );
  return { opportunity, checkedAt };
}

test("imports the manifest once and projects its immutable total on repeated reads", async () => {
  const f = await fixture();
  try {
    await f.service.initialize();
    await f.service.initialize();
    const view = f.service.read();
    assert.equal(view.cohorts.length, 1);
    assert.equal(view.summary.total, 1);
    assert.equal(view.rows.length, 1);
    assert.equal(view.rows[0].opportunityId, "opp-1");
  } finally {
    await close(f);
  }
});

test("rejects a manifest from a foreign shop before importing any cohort", async () => {
  const f = await fixture(manifest("shop-b"));
  try {
    await assert.rejects(f.service.initialize(), /店铺/);
    assert.equal(f.service.read().cohorts.length, 0);
  } finally {
    await close(f);
  }
});

test("a user-controlled browser prevents hydration before the bridge is called", async () => {
  const f = await fixture();
  try {
    await f.service.initialize();
    f.store.setMeta("opportunity-browser:shop-a", {
      status: "user_control",
      message: "operator owns browser",
    });
    let calls = 0;
    await assert.rejects(
      f.service.hydrate(
        { cohortId: "opportunity-cohort-v1", limit: 1 },
        {} as any,
        {
          async call() {
            calls++;
            return { receipts: [] };
          },
        },
      ),
      /用户控制/,
    );
    assert.equal(calls, 0);
  } finally {
    await close(f);
  }
});

test("a user-controlled browser prevents source collection before the bridge is called", async () => {
  const f = await fixture();
  try {
    await f.service.initialize();
    f.store.setMeta("opportunity-browser:shop-a", {
      status: "user_control",
      message: "operator owns browser",
    });
    let calls = 0;
    await assert.rejects(
      f.service.collectSource(
        { cohortId: "opportunity-cohort-v1" },
        {} as any,
        {
          async call() {
            calls++;
            return {};
          },
        },
      ),
      /用户控制/,
    );
    assert.equal(calls, 0);
  } finally {
    await close(f);
  }
});

test("source collection rejects a foreign cohort or explicit row before browser work", async () => {
  const f = await fixture();
  try {
    await f.service.initialize();
    let calls = 0;
    const bridge = {
      async call() {
        calls++;
        return {};
      },
    };
    await assert.rejects(
      f.service.collectSource(
        { cohortId: "foreign-cohort" },
        {} as any,
        bridge,
      ),
      /本店机会批次不存在/,
    );
    await assert.rejects(
      f.service.collectSource(
        { cohortId: "opportunity-cohort-v1", rowId: "foreign-row" },
        {} as any,
        bridge,
      ),
      /机会行不存在|不属于/,
    );
    assert.equal(calls, 0);
  } finally {
    await close(f);
  }
});

test("an explicit foreign hydrate refresh row is rejected before the bridge is called", async () => {
  const f = await fixture();
  try {
    await f.service.initialize();
    let calls = 0;
    await assert.rejects(
      f.service.hydrate(
        { cohortId: "opportunity-cohort-v1", rowIds: ["foreign-row"] },
        {} as any,
        {
          async call() {
            calls++;
            return { receipts: [] };
          },
        },
      ),
      /刷新目标必须是本批次/,
    );
    assert.equal(calls, 0);
  } finally {
    await close(f);
  }
});

test("a publisher pause prevents source collection before the bridge is called", async () => {
  const f = await fixture();
  try {
    await f.service.initialize();
    await sourceCandidate(f);
    f.store.pause("all", "operator stop");
    let calls = 0;
    await assert.rejects(
      f.service.collectSource(
        { cohortId: "opportunity-cohort-v1" },
        {} as any,
        {
          async call() {
            calls++;
            return {};
          },
        },
      ),
      /队列已暂停/,
    );
    assert.equal(calls, 0);
  } finally {
    await close(f);
  }
});

test("CONTROL_REQUIRED records user control and releases the source collector lock", async () => {
  const f = await fixture();
  try {
    await f.service.initialize();
    await sourceCandidate(f);
    let calls = 0;
    const error: any = new Error("operator took control");
    error.code = "CONTROL_REQUIRED";
    await assert.rejects(
      f.service.collectSource(
        { cohortId: "opportunity-cohort-v1" },
        {} as any,
        {
          async call() {
            calls++;
            throw error;
          },
        },
      ),
      /operator took control/,
    );
    assert.equal(calls, 1);
    assert.equal(
      f.store.meta("opportunity-browser:shop-a")?.status,
      "user_control",
    );
    assert.equal(
      (
        f.store.db
          .prepare("SELECT COUNT(*) n FROM locks WHERE name='publisher'")
          .get() as any
      ).n,
      0,
    );
  } finally {
    await close(f);
  }
});

test("a matched source read calls the built-in collector once and creates no publishing job", async () => {
  const f = await fixture();
  try {
    await f.service.initialize();
    const { opportunity, checkedAt } = await sourceCandidate(f);
    let calls = 0;
    const record = f.service.sources.record.bind(f.service.sources);
    (f.service.sources as any).record = (...args: any[]) => {
      assert.equal(
        (
          f.store.db
            .prepare("SELECT COUNT(*) n FROM locks WHERE name='publisher'")
            .get() as any
        ).n,
        1,
      );
      return record(...args);
    };
    let result: any;
    try {
      result = await f.service.collectSource(
        { cohortId: "opportunity-cohort-v1", rowId: opportunity.id },
        {} as any,
        {
          async call(action: string) {
            calls++;
            assert.equal(action, "collect");
            return collectedProduct(checkedAt);
          },
        },
      );
    } finally {
      (f.service.sources as any).record = record;
    }
    assert.equal(calls, 1);
    assert.equal(result.received, 1);
    assert.equal(result.matched, true);
    assert.equal(f.jobs.list().length, 0);
    assert.equal(
      f.service.sources.latest(opportunity.id)?.comparison.matched,
      true,
    );
    assert.equal(
      (
        f.store.db
          .prepare("SELECT COUNT(*) n FROM locks WHERE name='publisher'")
          .get() as any
      ).n,
      0,
    );
  } finally {
    await close(f);
  }
});

test("a malformed JD result or local record failure leaves the browser unavailable and releases the lock", async () => {
  const f = await fixture();
  try {
    await f.service.initialize();
    await sourceCandidate(f);
    await assert.rejects(
      f.service.collectSource(
        { cohortId: "opportunity-cohort-v1" },
        {} as any,
        {
          async call() {
            return { malformed: true };
          },
        },
      ),
    );
    assert.equal(
      f.store.meta("opportunity-browser:shop-a")?.status,
      "unavailable",
    );
    assert.equal(
      (
        f.store.db
          .prepare("SELECT COUNT(*) n FROM locks WHERE name='publisher'")
          .get() as any
      ).n,
      0,
    );

    f.store.resume("all");
    const record = f.service.sources.record.bind(f.service.sources);
    (f.service.sources as any).record = () => {
      throw Error("local comparison failure");
    };
    try {
      await assert.rejects(
        f.service.collectSource(
          { cohortId: "opportunity-cohort-v1" },
          {} as any,
          {
            async call() {
              return collectedProduct(new Date().toISOString());
            },
          },
        ),
        /local comparison failure/,
      );
    } finally {
      (f.service.sources as any).record = record;
    }
    assert.equal(
      f.store.meta("opportunity-browser:shop-a")?.status,
      "unavailable",
    );
    assert.equal(
      (
        f.store.db
          .prepare("SELECT COUNT(*) n FROM locks WHERE name='publisher'")
          .get() as any
      ).n,
      0,
    );
  } finally {
    await close(f);
  }
});

test("an unresolved opportunity cannot enqueue a publishing job", async () => {
  const f = await fixture();
  try {
    await f.service.initialize();
    const rowId = f.service.read().rows[0].id;
    assert.throws(
      () => f.service.prepare({ rowIds: [rowId] }),
      /尚未采集京东商品规格/,
    );
    assert.equal(f.jobs.list().length, 0);
  } finally {
    await close(f);
  }
});

test("a later prepare failure rolls back earlier job enqueue and association", async () => {
  const f = await fixture(
    manifest("shop-a", [
      row("opp-1", "101"),
      { ...row("opp-2", "102"), rank: 2 },
    ]),
  );
  try {
    await f.service.initialize();
    const rows = f.service.read().rows;
    for (const [index, item] of rows.entries()) {
      const targetSku = String(900001 + index);
      f.store.db
        .prepare("UPDATE opportunity_rows SET target_sku=? WHERE id=?")
        .run(targetSku, item.id);
      f.store.db
        .prepare("INSERT INTO opportunity_evidence VALUES(?,?,?,?,?)")
        .run(
          "source-" + item.id,
          item.id,
          "source-match",
          at,
          JSON.stringify({
            brandId: "brand-1",
            categoryId: "category-1",
            unit: "盒",
          }),
        );
    }
    f.store.db.exec(
      "CREATE TABLE shop_policies(shop TEXT,id TEXT,policy TEXT NOT NULL,checked_at TEXT NOT NULL,PRIMARY KEY(shop,id))",
    );
    f.store.db
      .prepare("INSERT INTO shop_policies VALUES(?,?,?,?)")
      .run("shop-a", "only-policy", "{}", at);
    const evaluate = f.service.ledger.evaluateForPreparation.bind(
      f.service.ledger,
    );
    (f.service.ledger as any).evaluateForPreparation = (rowId: string) => {
      if (rowId === rows[1].id) throw Error("second row deliberately fails");
      return { status: "READY_FOR_PREPARATION", blockers: [] };
    };
    const assertPrepared = f.service.sources.assertPrepared.bind(
      f.service.sources,
    );
    (f.service.sources as any).assertPrepared = (rowId: string) => {
      const sku = f.service.ledger.row(rowId).targetSku!;
      const product = collectedProduct(new Date().toISOString());
      product.sku = sku;
      product.url = `https://item.jd.com/${sku}.html`;
      product.title.sourceUrl = product.url;
      for (const fact of Object.values(product.specs))
        fact.sourceUrl = product.url;
      product.price!.sourceUrl = product.url;
      new SourceReuse(f.store).remember(
        sourceContext(f.store, "shop-a", sku),
        product,
      );
      return { product };
    };
    try {
      assert.throws(
        () => f.service.prepare({ rowIds: rows.map((item) => item.id) }),
        /deliberately fails/,
      );
    } finally {
      (f.service.ledger as any).evaluateForPreparation = evaluate;
      (f.service.sources as any).assertPrepared = assertPrepared;
    }
    assert.equal(f.jobs.list().length, 0);
    assert.equal(f.store.list().length, 0);
    assert.equal(f.service.ledger.row(rows[0].id).jobId, null);
  } finally {
    await close(f);
  }
});

test("a completed job is not projected as an on-sale result", async () => {
  const f = await fixture();
  try {
    await f.service.initialize();
    const opportunity = f.service.read().rows[0];
    f.store.db
      .prepare("UPDATE opportunity_rows SET target_sku=? WHERE id=?")
      .run("900001", opportunity.id);
    const jobId = f.jobs.enqueue(["900001"], {
      brandId: "brand-1",
      categoryId: "category-1",
      policyId: "policy-1",
      unit: "盒",
      through: "submit",
    }).items[0].id;
    f.service.ledger.associateJob(opportunity.id, jobId);
    f.jobs.update(jobId, "DONE", "complete");
    const view = f.service.read();
    assert.notEqual(view.rows[0].status, "ON_SALE");
    assert.equal(view.summary.onSale, 0);
  } finally {
    await close(f);
  }
});

test("a verified on-sale product is counted from its observed business state", async () => {
  const f = await fixture();
  try {
    await f.service.initialize();
    const opportunity = f.service.read().rows[0];
    f.store.db
      .prepare("UPDATE opportunity_rows SET target_sku=? WHERE id=?")
      .run("900001", opportunity.id);
    const jobId = f.jobs.enqueue(["900001"], {
      brandId: "brand-1",
      categoryId: "category-1",
      policyId: "policy-1",
      unit: "盒",
      through: "submit",
    }).items[0].id;
    f.service.ledger.associateJob(opportunity.id, jobId);
    f.store.db
      .prepare(
        `INSERT INTO products
         (id,shop,sku,variant,state,data_hash,remote_id,verified_hash,updated_at)
         VALUES(?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        "product-900001",
        "shop-a",
        "900001",
        "",
        "ON_SALE",
        "hash",
        "9900001",
        "hash",
        at,
      );
    f.jobs.update(jobId, "DONE", "complete", null, "product-900001");
    const view = f.service.read();
    assert.equal(view.rows[0].status, "ON_SALE");
    assert.equal(view.summary.onSale, 1);
  } finally {
    await close(f);
  }
});

test("a bridge receipt missing frozen identity cannot mark a row ready", async () => {
  const f = await fixture();
  try {
    await f.service.initialize();
    await writeFile(
      join(f.root, "opportunity-session.json"),
      JSON.stringify({
        spaceId: 1,
        hzPage: "hz-page",
        jdPage: "jd-page",
        profileId: "profile",
      }),
    );
    const rowId = f.service.read().rows[0].id;
    await assert.rejects(
      f.service.hydrate(
        { cohortId: "opportunity-cohort-v1", limit: 1 },
        {} as any,
        {
          async call() {
            return {
              receipts: [
                {
                  opportunityId: "opp-1",
                  skuId: "101",
                  marketShopId: "market-shop-7",
                },
              ],
            };
          },
        },
      ),
      /冻结身份/,
    );
    assert.equal(f.service.ledger.row(rowId).status, "IMPORTED");
    assert.equal(f.store.meta("opportunity-detail:" + rowId), null);
    assert.equal(f.jobs.list().length, 0);
  } finally {
    await close(f);
  }
});

test("recheck replays a saved detail after its category is imported without enqueuing", async () => {
  const f = await fixture();
  try {
    await f.service.initialize();
    await writeFile(
      join(f.root, "opportunity-session.json"),
      JSON.stringify({
        spaceId: 1,
        hzPage: "hz-page",
        jdPage: "jd-page",
        profileId: "profile",
      }),
    );
    const opportunity = f.service.read().rows[0];
    const checkedAt = new Date().toISOString();
    const receiptId = new MarketDetails(f.store).save(
      "shop-a",
      opportunity.marketItemId,
      opportunity.marketShopId,
      {
        code: 0,
        data: {
          itemId: opportunity.marketItemId,
          itemPublishVo: {
            id: opportunity.marketItemId,
            shopId: opportunity.marketShopId,
            brandId: "brand-1",
            cid: "category-1",
            brandName: "示例品牌",
            saleStatus: 60,
          },
          itemSkuInfoList: [
            {
              id: opportunity.marketSkuId,
              itemId: opportunity.marketItemId,
              shopId: opportunity.marketShopId,
              skuName: "销售规格",
              sellPrice: "19.90",
              inventory: 1,
              skuStatus: 1,
              skuShelfStatus: 20,
              skuUnit: "盒",
              skuPicUrls: [{ url: "https://item.jd.com/123456.html" }],
            },
          ],
        },
      },
      checkedAt,
      [opportunity.marketSkuId],
    );
    await f.service.hydrate(
      { cohortId: "opportunity-cohort-v1", limit: 1 },
      {} as any,
      {
        async call() {
          return {
            receipts: [
              {
                opportunityId: opportunity.opportunityId,
                itemId: opportunity.marketItemId,
                skuId: opportunity.marketSkuId,
                marketShopId: opportunity.marketShopId,
                receiptId,
                verified: {
                  checkedAt,
                  itemPublishVo: { brandId: "brand-1", cid: "category-1" },
                  sku: { unit: "盒" },
                },
              },
            ],
          };
        },
      },
    );
    assert.match(
      String(f.store.meta("opportunity-detail:" + opportunity.id)?.issue),
      /类目/,
    );
    f.service.ledger.catalog.import({
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
    assert.deepEqual(f.service.recheck({ cohortId: "opportunity-cohort-v1" }), {
      checked: 1,
    });
    assert.equal(f.service.ledger.row(opportunity.id).targetSku, "123456");
    assert.equal(
      f.store.meta("opportunity-detail:" + opportunity.id)?.issue,
      null,
    );
    assert.equal(f.service.read().rows[0].status, "BLOCKED");
    assert.equal(f.jobs.list().length, 0);
  } finally {
    await close(f);
  }
});

test("opportunity collection reuses shared SKU facts and only refreshes the unknown-context quote", async () => {
  const f = await fixture();
  try {
    await f.service.initialize();
    const { opportunity, checkedAt } = await sourceCandidate(f);
    f.store.setMeta("listing-price:shop-a", "jd-regular-preferred");
    const product = collectedProduct(checkedAt);
    const calls: string[] = [];
    const bridge = {
      async call(action: string) {
        calls.push(action);
        return product;
      },
    };
    const input = { cohortId: "opportunity-cohort-v1", rowId: opportunity.id };
    const first = await f.service.collectSource(input, {} as any, bridge);
    assert.equal(first.collectionMode, "full");
    assert.deepEqual(calls, ["collect"]);
    assert.equal(f.store.list().length, 0);
    const next = await f.service.collectSource(input, {} as any, bridge);
    assert.equal(next.collectionMode, "price");
    assert.equal(f.service.read().rows[0].sourceReuseMode, "price");
    assert.deepEqual(calls, ["collect", "refresh-price"]);
    assert.deepEqual(
      new SourceReuse(f.store).captures.facts(
        sourceContext(f.store, "shop-a", product.sku),
      ),
      product,
    );
  } finally {
    await close(f);
  }
});

test("known same-context source is local-only on a repeated opportunity collection", async () => {
  const f = await fixture();
  try {
    await f.service.initialize();
    const { opportunity, checkedAt } = await sourceCandidate(f);
    f.store.setMeta("listing-price:shop-a", "jd-regular-preferred");
    f.store.setMeta("jd-context:shop-a", { account: "A", region: "R" });
    const product = collectedProduct(checkedAt);
    let calls = 0;
    const bridge = {
      async call() {
        calls++;
        return product;
      },
    };
    const input = { cohortId: "opportunity-cohort-v1", rowId: opportunity.id };
    await f.service.collectSource(input, {} as any, bridge);
    await f.service.collectSource(input, {} as any, bridge);
    assert.equal(calls, 1);
    assert.equal(f.jobs.list().length, 0);
  } finally {
    await close(f);
  }
});

test("source collection never reuses facts older than the strict comparison window", async () => {
  const f = await fixture();
  try {
    await f.service.initialize();
    const { opportunity, checkedAt } = await sourceCandidate(f);
    f.store.setMeta("listing-price:shop-a", "jd-regular-preferred");
    const stale = collectedProduct(
      new Date(Date.now() - 3_600_001).toISOString(),
    );
    const fresh = collectedProduct(checkedAt);
    const calls: string[] = [];
    const bridge = {
      async call(action: string) {
        calls.push(action);
        return calls.length === 1 ? stale : fresh;
      },
    };
    const input = { cohortId: "opportunity-cohort-v1", rowId: opportunity.id };
    await f.service.collectSource(input, {} as any, bridge);
    const result = await f.service.collectSource(input, {} as any, bridge);
    assert.equal(result.collectionMode, "full");
    assert.deepEqual(calls, ["collect", "collect"]);
  } finally {
    await close(f);
  }
});

test("discovered exact source keeps supplier namespaces and stale candidates cannot be selected", async () => {
  const f = await fixture();
  try {
    await f.service.initialize();
    const { opportunity } = await sourceCandidate(f);
    // Exercise the independent path rather than the external-link binding made by the fixture.
    f.store.db
      .prepare("UPDATE opportunity_rows SET target_sku=NULL WHERE id=?")
      .run(opportunity.id);
    const originalMatch: any = f.service.ledger
      .evidence(opportunity.id)
      .find((entry) => entry.kind === "source-match");
    f.store.db
      .prepare(
        "DELETE FROM opportunity_evidence WHERE row_id=? AND kind='source-match'",
      )
      .run(opportunity.id);
    f.store.setMeta("opportunity-detail:" + opportunity.id, {
      receiptId: originalMatch.payload.detailReceiptId,
    });
    const old = "2026-09-20T00:00:00.000Z";
    f.service.ledger.recordSourceCandidateSearch(
      opportunity.id,
      {
        receiptId: "old-search",
        query: "示例品牌 M1 1盒",
        checkedAt: old,
        candidates: [
          {
            sku: "123456",
            url: "https://item.jd.com/123456.html",
            title: "示例品牌 M1 1盒",
          },
        ],
      },
      old,
    );
    assert.throws(
      () =>
        f.service.ledger.selectSourceCandidate(
          opportunity.id,
          { receiptId: "old-search", sku: "123456" },
          "2026-09-20T02:00:00.000Z",
        ),
      /过期/,
    );
    const checkedAt = new Date().toISOString();
    f.service.ledger.recordSourceCandidateSearch(opportunity.id, {
      receiptId: "fresh-search",
      query: "示例品牌 M1 1盒",
      checkedAt,
      candidates: [
        {
          sku: "123456",
          url: "https://item.jd.com/123456.html",
          title: "示例品牌 M1 1盒",
        },
      ],
    });
    f.service.ledger.selectSourceCandidate(opportunity.id, {
      receiptId: "fresh-search",
      sku: "123456",
    });
    const accepted = f.service.ledger.acceptDiscoveredExactSource(
      opportunity.id,
      {
        receiptId: "fresh-search",
        sourceSku: "123456",
        detailReceiptId: originalMatch.payload.detailReceiptId,
      },
    );
    assert.equal(accepted.brandId, "brand-1");
    assert.equal(accepted.categoryId, "category-1");
    assert.equal(accepted.categoryPath, "类目");
    assert.equal(accepted.unit, "盒");
    assert.equal(f.service.ledger.row(opportunity.id).targetSku, "123456");
    const detailRow: any = f.store.db
      .prepare("SELECT payload FROM market_details WHERE id=?")
      .get(originalMatch.payload.detailReceiptId);
    const detailPayload = JSON.parse(String(detailRow.payload));
    detailPayload.data.itemSkuInfoList[0].skuPicUrls = [];
    f.store.db
      .prepare("UPDATE market_details SET payload=? WHERE id=?")
      .run(
        JSON.stringify(detailPayload),
        originalMatch.payload.detailReceiptId,
      );
    f.store.setMeta("listing-price:shop-a", "jd-regular-preferred");
    f.service.ledger.catalog.import({
      shop: "shop-a",
      categories: [],
      brands: [
        {
          id: "brand-1",
          name: "示例品牌",
          sourceUrl: "https://merchant.example/brand",
          checkedAt,
        },
      ],
      grants: [
        {
          id: "grant-1",
          brandId: "brand-1",
          status: "approved",
          validFrom: new Date(Date.now() - 60_000).toISOString(),
          validUntil: new Date(Date.now() + 3_600_000).toISOString(),
          scopes: [{ categoryId: "category-1", descendants: false }],
          sourceUrl: "https://merchant.example/grant",
          checkedAt,
        },
      ],
    });
    const scan = f.service.ledger.sources.begin("shop-a");
    f.service.ledger.sources.finish(
      scan,
      ["visible-normal", "visible-draft", "hidden-normal", "hidden-draft"].map(
        (partition) => ({ partition, expected: 0, seen: 0 }),
      ),
    );
    const discoveredProduct = collectedProduct(checkedAt);
    f.service.sources.record(opportunity.id, discoveredProduct);
    new SourceReuse(f.store).remember(
      sourceContext(f.store, "shop-a", discoveredProduct.sku),
      discoveredProduct,
    );
    assert.equal(
      f.service.sources.latest(opportunity.id)?.comparison.matched,
      true,
    );
    const readiness = f.service.ledger.evaluateForPreparation(opportunity.id);
    assert.equal(
      readiness.status,
      "READY_FOR_PREPARATION",
      JSON.stringify(readiness.blockers),
    );
    assert.deepEqual(f.service.recheck({ cohortId: "opportunity-cohort-v1" }), {
      checked: 1,
    });
    assert.equal(
      f.store.meta("opportunity-detail:" + opportunity.id)?.issue,
      null,
    );
    f.store.db.exec(
      "CREATE TABLE IF NOT EXISTS shop_policies(shop TEXT,id TEXT,policy TEXT NOT NULL,checked_at TEXT NOT NULL,PRIMARY KEY(shop,id))",
    );
    f.store.db
      .prepare("INSERT INTO shop_policies VALUES(?,?,?,?)")
      .run("shop-a", "policy-1", "{}", checkedAt);
    const prepared = f.service.prepare({ rowIds: [opportunity.id] });
    assert.equal(prepared.items.length, 1);
    const job = f.jobs.get(prepared.items[0].jobId)!;
    assert.equal(job.sku, "123456");
    assert.equal(job.recipe.brandId, "brand-1");
    assert.equal(job.recipe.categoryId, "category-1");
    assert.equal(job.recipe.unit, "盒");
  } finally {
    await close(f);
  }
});

test("candidate collection checks user control before persisting a selection", async () => {
  const f = await fixture();
  try {
    await f.service.initialize();
    const opportunity = f.service.read().rows[0];
    f.store.setMeta("opportunity-browser:shop-a", { status: "user_control" });
    await assert.rejects(
      f.service.collectCandidate(
        {
          cohortId: "opportunity-cohort-v1",
          rowId: opportunity.id,
          receiptId: "receipt",
          sku: "123456",
        },
        {} as any,
        {
          async call() {
            throw Error("must not call");
          },
        },
      ),
      /用户控制/,
    );
    assert.equal(
      f.service.ledger
        .evidence(opportunity.id)
        .some((entry) => entry.kind === "source-candidate-selected"),
      false,
    );
  } finally {
    await close(f);
  }
});

test("saved selected-SKU JD links become candidates without search and still require strict matching", async () => {
  const f = await fixture();
  try {
    await f.service.initialize();
    const opportunity = f.service.read().rows[0];
    const checkedAt = new Date().toISOString();
    const receiptId = new MarketDetails(f.store).save(
      "shop-a",
      opportunity.marketItemId,
      opportunity.marketShopId,
      {
        code: 0,
        data: {
          itemId: opportunity.marketItemId,
          itemPublishVo: {
            id: opportunity.marketItemId,
            shopId: opportunity.marketShopId,
            brandId: "brand-1",
            cid: "category-1",
            brandName: "示例品牌",
            saleStatus: 60,
            skuSpecMap: {
              [opportunity.marketSkuId]: [
                { attrName: "型号", attrValue: "M2" },
                { attrName: "规格", attrValue: "1盒" },
              ],
            },
          },
          itemSkuInfoList: [
            {
              id: opportunity.marketSkuId,
              itemId: opportunity.marketItemId,
              shopId: opportunity.marketShopId,
              skuName: "示例商品 M2 1盒",
              sellPrice: "19.90",
              inventory: 1,
              skuStatus: 1,
              skuShelfStatus: 20,
              skuUnit: "盒",
              specAttributes: "型号:M2;规格:1盒;",
              skuPicUrls: [
                { url: "https://item.jd.com/123456.html?from=market" },
                { url: "https://item.jd.com/123456.html" },
                { url: "https://item.jd.com/654321.html" },
              ],
            },
            {
              id: "other-market-sku",
              itemId: opportunity.marketItemId,
              shopId: opportunity.marketShopId,
              skuName: "其他SKU",
              sellPrice: "1.00",
              inventory: 1,
              skuStatus: 1,
              skuShelfStatus: 20,
              skuUnit: "件",
              skuPicUrls: [{ url: "https://evil.example/not-selected" }],
            },
          ],
        },
      },
      checkedAt,
      [opportunity.marketSkuId],
    );
    f.store.setMeta("opportunity-detail:" + opportunity.id, { receiptId });
    let bridgeCalls = 0;
    const discovered = await f.service.discoverCandidates(
      { cohortId: "opportunity-cohort-v1", rowId: opportunity.id },
      {} as any,
      {
        async call() {
          bridgeCalls++;
          throw Error("must not search");
        },
      },
    );
    assert.equal(discovered.discoveryMode, "existing-links");
    assert.equal(discovered.checkedAt, checkedAt);
    assert.deepEqual(
      discovered.candidates.map((candidate) => candidate.sku),
      ["123456", "654321"],
    );
    assert.equal(bridgeCalls, 0);

    f.service.ledger.selectSourceCandidate(opportunity.id, {
      receiptId: discovered.receiptId,
      sku: "123456",
    });
    const observed = f.service.sources.recordCandidate(
      opportunity.id,
      collectedProduct(checkedAt),
    );
    assert.equal(observed.comparison.matched, false);
    assert.ok(
      observed.comparison.blockers.some((message) => message.includes("型号")),
    );
    assert.equal(f.service.ledger.row(opportunity.id).targetSku, null);
  } finally {
    await close(f);
  }
});

test("stale or invalid saved JD links block without searching or refreshing evidence time", async () => {
  for (const invalidUrl of [
    null,
    "https://evil.example/123.html",
    "https://item.jd.com/123456.html?skuId=654321",
    "https://item.jd.com/123456.html?from=market&id=654321",
  ] as const) {
    const f = await fixture();
    try {
      await f.service.initialize();
      const opportunity = f.service.read().rows[0];
      const checkedAt = new Date(Date.now() - 2 * 3_600_000).toISOString();
      const receiptId = new MarketDetails(f.store).save(
        "shop-a",
        opportunity.marketItemId,
        opportunity.marketShopId,
        {
          code: 0,
          data: {
            itemId: opportunity.marketItemId,
            itemPublishVo: {
              id: opportunity.marketItemId,
              shopId: opportunity.marketShopId,
              brandName: "示例品牌",
              saleStatus: 60,
            },
            itemSkuInfoList: [
              {
                id: opportunity.marketSkuId,
                itemId: opportunity.marketItemId,
                shopId: opportunity.marketShopId,
                skuName: "示例商品",
                sellPrice: "19.90",
                inventory: 1,
                skuStatus: 1,
                skuShelfStatus: 20,
                skuUnit: "盒",
                skuPicUrls: [
                  { url: invalidUrl ?? "https://item.jd.com/123456.html" },
                ],
              },
            ],
          },
        },
        checkedAt,
        [opportunity.marketSkuId],
      );
      f.store.setMeta("opportunity-detail:" + opportunity.id, { receiptId });
      let bridgeCalls = 0;
      await assert.rejects(
        f.service.discoverCandidates(
          { cohortId: "opportunity-cohort-v1", rowId: opportunity.id },
          {} as any,
          {
            async call() {
              bridgeCalls++;
              return {};
            },
          },
        ),
        invalidUrl ? /不支持/ : /已过期|无效/,
      );
      assert.equal(bridgeCalls, 0);
      assert.equal(
        f.service.ledger
          .evidence(opportunity.id)
          .some((entry) => entry.kind === "source-candidate-search"),
        false,
      );
    } finally {
      await close(f);
    }
  }
});
