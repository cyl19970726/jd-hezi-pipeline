import test from "node:test";
import assert from "node:assert/strict";
import { OpportunityExecution } from "../src/opportunity-execution.js";
import { Store } from "../src/store.js";
import { Jobs } from "../src/jobs.js";

const at = "2026-09-20T04:00:00.000Z";
const now = Date.parse(at);

function setup() {
  const store = new Store(":memory:");
  const execution = new OpportunityExecution(store);
  execution.importCohort({
    cohortKey: "first281-v1",
    shop: "shop-a",
    sourceReportId: "sanitized-report-v1",
    importedAt: at,
    rows: [
      {
        opportunityId: "opp-001",
        rank: 1,
        marketShopId: "market-shop-7",
        marketItemId: "market-item-9",
        marketSkuId: "market-sku-3",
        targetSku: null,
      },
    ],
  });
  return { store, execution, rowId: execution.rows("first281-v1")[0].id };
}

function saveDetail(
  execution: OpportunityExecution,
  options: {
    item?: string;
    shop?: string;
    links?: string[];
    cid?: string;
  } = {},
) {
  const item = options.item ?? "market-item-9";
  const marketShop = options.shop ?? "market-shop-7";
  return execution.details.save(
    "shop-a",
    item,
    marketShop,
    {
      code: 0,
      data: {
        itemId: item,
        itemPublishVo: {
          id: item,
          shopId: marketShop,
          brandId: "brand-1",
          cid: options.cid ?? "category-1",
          brandName: "示例品牌",
          saleStatus: 60,
        },
        itemSkuInfoList: [
          {
            id: "market-sku-3",
            itemId: item,
            shopId: marketShop,
            skuName: "相似标题不构成来源证明",
            sellPrice: "19.90",
            inventory: 2,
            skuStatus: 1,
            skuShelfStatus: 20,
            skuUnit: "盒",
            skuPicUrls: (
              options.links ?? ["https://item.jd.com/123456.html"]
            ).map((url) => ({ url })),
          },
        ],
      },
    },
    at,
    ["market-sku-3"],
  );
}

function makeReadyFacts(
  store: Store,
  execution: OpportunityExecution,
  rowId: string,
  detailId: string,
) {
  execution.catalog.import({
    shop: "shop-a",
    categories: [
      {
        id: "category-1",
        parentId: null,
        name: "示例类目",
        path: "示例类目",
        selectable: true,
        sourceUrl: "https://merchant.example/category",
        checkedAt: at,
      },
    ],
    brands: [
      {
        id: "brand-1",
        name: "示例品牌",
        sourceUrl: "https://merchant.example/brand",
        checkedAt: at,
      },
    ],
    grants: [
      {
        id: "grant-1",
        brandId: "brand-1",
        status: "approved",
        validFrom: "2026-01-01T00:00:00.000Z",
        validUntil: "2027-01-01T00:00:00.000Z",
        scopes: [{ categoryId: "category-1", descendants: false }],
        sourceUrl: "https://merchant.example/grant",
        checkedAt: at,
      },
    ],
  });
  execution.acceptExactSource(rowId, {
    detailReceiptId: detailId,
    brandId: "brand-1",
    categoryId: "category-1",
    unit: "盒",
  });
  execution.verifySourceProduct(rowId, {
    sourceSku: "123456",
    detailReceiptId: detailId,
    checkedAt: at,
    fields: [
      {
        field: "brand",
        marketValue: "示例品牌",
        sourceValue: "示例品牌",
        marketEvidenceUrl:
          "https://b.csgmall.com.cn/mall-view/product/detail?itemId=market-item-9&skuId=market-sku-3",
        sourceEvidenceUrl: "https://item.jd.com/123456.html",
      },
      {
        field: "packaging",
        marketValue: "1盒",
        sourceValue: "1盒",
        marketEvidenceUrl:
          "https://b.csgmall.com.cn/mall-view/product/detail?itemId=market-item-9&skuId=market-sku-3",
        sourceEvidenceUrl: "https://item.jd.com/123456.html",
      },
      {
        field: "model",
        marketValue: "M1",
        sourceValue: "M1",
        marketEvidenceUrl:
          "https://b.csgmall.com.cn/mall-view/product/detail?itemId=market-item-9&skuId=market-sku-3",
        sourceEvidenceUrl: "https://item.jd.com/123456.html",
      },
    ],
  });
  store.setMeta("listing-price:shop-a", "jd-regular-preferred");
  const scan = execution.sources.begin("shop-a");
  execution.sources.finish(scan, [
    { partition: "visible-normal", expected: 0, seen: 0 },
    { partition: "visible-draft", expected: 0, seen: 0 },
    { partition: "hidden-normal", expected: 0, seen: 0 },
    { partition: "hidden-draft", expected: 0, seen: 0 },
  ]);
}

test("cohort retry is idempotent but frozen identity drift is rejected", () => {
  const { store, execution } = setup();
  try {
    const original = {
      cohortKey: "first281-v1",
      shop: "shop-a",
      sourceReportId: "sanitized-report-v1",
      importedAt: at,
      rows: [
        {
          opportunityId: "opp-001",
          rank: 1,
          marketShopId: "market-shop-7",
          marketItemId: "market-item-9",
          marketSkuId: "market-sku-3",
          targetSku: null,
        },
      ],
    };
    assert.equal(execution.importCohort(original).reused, true);
    assert.throws(
      () =>
        execution.importCohort({
          ...original,
          rows: [{ ...original.rows[0], marketSkuId: "changed" }],
        }),
      /已经冻结/,
    );
    assert.equal(execution.rows("first281-v1").length, 1);
  } finally {
    store.close();
  }
});

test("exact detail identities and sole external JD link are required before binding", () => {
  const { store, execution, rowId } = setup();
  try {
    const wrong = saveDetail(execution, { item: "other-item" });
    assert.throws(
      () =>
        execution.acceptExactSource(rowId, {
          detailReceiptId: wrong,
          brandId: "b",
          categoryId: "c",
          unit: "盒",
        }),
      /身份不一致/,
    );
    const ambiguous = saveDetail(execution, {
      links: [
        "https://item.jd.com/123456.html",
        "https://item.jd.com/654321.html",
      ],
    });
    assert.throws(
      () =>
        execution.acceptExactSource(rowId, {
          detailReceiptId: ambiguous,
          brandId: "b",
          categoryId: "c",
          unit: "盒",
        }),
      /有且仅有一个/,
    );
    assert.equal(execution.row(rowId).targetSku, null);
  } finally {
    store.close();
  }
});

function mappedCandidateFixture(
  selectedSku: string,
  observedSku: string,
  comparisonAt: string,
  acceptedAt: string,
) {
  const { store, execution, rowId } = setup();
  const detailId = saveDetail(execution, { cid: "10015" });
  execution.catalog.import({
    shop: "shop-a",
    categories: [
      {
        id: "10015",
        parentId: null,
        name: "办公用纸",
        path: "办公用品>办公耗材>办公用纸",
        selectable: false,
        sourceUrl: "https://merchant.example/category",
        checkedAt: acceptedAt,
      },
      {
        id: "10015007",
        parentId: "10015",
        name: "复印纸",
        path: "办公用品>办公耗材>办公用纸>复印纸",
        selectable: true,
        sourceUrl: "https://merchant.example/category",
        checkedAt: acceptedAt,
      },
    ],
    brands: [],
    grants: [],
  });
  store.db.exec(`CREATE TABLE opportunity_source_observations(
    id TEXT PRIMARY KEY,row_id TEXT,detail_receipt_id TEXT,product TEXT,
    comparison TEXT,price_issue TEXT,created_at TEXT)`);
  const mapping = {
    marketCategoryId: "10015",
    publishCategoryId: "10015007",
    rule: "copy-paper-parent-to-leaf/barcode-and-full-signature-v1",
    barcode: "6900000000123",
    marketEvidencePath: "selected.specAttributes",
    sourceEvidenceSpec: "商品条码",
  };
  store.db
    .prepare(
      "INSERT INTO opportunity_source_observations VALUES(?,?,?,?,?,?,?)",
    )
    .run(
      "observation-1",
      rowId,
      detailId,
      JSON.stringify({ sku: observedSku }),
      JSON.stringify({
        matched: true,
        sourceSku: observedSku,
        detailReceiptId: detailId,
        checkedAt: comparisonAt,
        categoryMapping: mapping,
      }),
      null,
      comparisonAt,
    );
  execution.recordSourceCandidateSearch(
    rowId,
    {
      receiptId: "candidate-search",
      query: "bounded candidate",
      checkedAt: acceptedAt,
      candidates: [
        {
          sku: selectedSku,
          url: `https://item.jd.com/${selectedSku}.html`,
          title: "bounded candidate",
        },
      ],
    },
    acceptedAt,
  );
  execution.selectSourceCandidate(
    rowId,
    { receiptId: "candidate-search", sku: selectedSku },
    acceptedAt,
  );
  return { store, execution, rowId, detailId };
}

test("parent-to-leaf candidate proof cannot cross source SKUs", () => {
  const acceptedAt = "2026-09-20T04:00:00.000Z";
  const f = mappedCandidateFixture(
    "222222",
    "111111",
    "2026-09-20T03:30:00.000Z",
    acceptedAt,
  );
  try {
    assert.throws(
      () =>
        f.execution.acceptDiscoveredExactSource(
          f.rowId,
          {
            receiptId: "candidate-search",
            sourceSku: "222222",
            detailReceiptId: f.detailId,
          },
          acceptedAt,
        ),
      /映射证明/,
    );
  } finally {
    f.store.close();
  }
});

test("parent-to-leaf candidate proof expires without refreshing its evidence time", () => {
  const acceptedAt = "2026-09-20T04:00:00.000Z";
  const f = mappedCandidateFixture(
    "222222",
    "222222",
    "2026-09-20T02:59:59.999Z",
    acceptedAt,
  );
  try {
    assert.throws(
      () =>
        f.execution.acceptDiscoveredExactSource(
          f.rowId,
          {
            receiptId: "candidate-search",
            sourceSku: "222222",
            detailReceiptId: f.detailId,
          },
          acceptedAt,
        ),
      /映射证明/,
    );
  } finally {
    f.store.close();
  }
});

test("valid parent-to-leaf candidate keeps the comparison checkedAt", () => {
  const acceptedAt = "2026-09-20T04:00:00.000Z";
  const comparisonAt = "2026-09-20T03:30:00.000Z";
  const f = mappedCandidateFixture(
    "222222",
    "222222",
    comparisonAt,
    acceptedAt,
  );
  try {
    const result = f.execution.acceptDiscoveredExactSource(
      f.rowId,
      {
        receiptId: "candidate-search",
        sourceSku: "222222",
        detailReceiptId: f.detailId,
      },
      acceptedAt,
    );
    assert.equal(result.categoryId, "10015007");
    assert.equal(result.marketCategoryId, "10015");
    assert.equal(result.checkedAt, comparisonAt);
  } finally {
    f.store.close();
  }
});

test("preparation gate blocks stale evidence and accepts fresh authorized deduplicated rows", () => {
  const { store, execution, rowId } = setup();
  try {
    const detailId = saveDetail(execution);
    makeReadyFacts(store, execution, rowId, detailId);
    const verified = execution
      .evidence(rowId)
      .find((entry) => entry.kind === "source-product-verified")!
      .payload as any;
    assert.throws(
      () =>
        execution.verifySourceProduct(rowId, {
          ...verified,
          fields: verified.fields.map((field: any, index: number) =>
            index === 0
              ? {
                  ...field,
                  marketEvidenceUrl:
                    "https://foreign.example/mall-view/product/detail?itemId=market-item-9&skuId=market-sku-3",
                }
              : field,
          ),
        }),
      /没有精确指向/,
    );
    assert.throws(
      () =>
        execution.verifySourceProduct(rowId, {
          ...verified,
          fields: verified.fields.map((field: any, index: number) =>
            index === 0
              ? {
                  ...field,
                  marketEvidenceUrl:
                    "https://b.csgmall.com.cn/mall-view/product/detail?itemId=wrong-item&skuId=market-sku-3",
                }
              : field,
          ),
        }),
      /没有精确指向/,
    );
    assert.equal(
      execution.evaluateForPreparation(rowId, { now }).status,
      "READY_FOR_PREPARATION",
    );
    const readinessEvidence = execution
      .evidence(rowId)
      .filter((entry) => entry.kind === "readiness")
      .at(-1)?.payload as any;
    assert.equal(
      readinessEvidence.operationalReadiness.scope,
      "authorization-and-exact-source-duplicate",
    );
    assert.deepEqual(readinessEvidence.operationalReadiness.authorization, {
      status: "authorized",
      grantId: "grant-1",
      brandId: "brand-1",
      categoryId: "category-1",
      checkedAt: at,
    });
    assert.equal(
      readinessEvidence.operationalReadiness.sourceDuplicate.status,
      "clear",
    );
    const stale = execution.evaluateForPreparation(rowId, {
      now: now + 3_600_001,
    });
    assert.equal(stale.status, "BLOCKED");
    assert.ok(
      stale.blockers.some((blocker) => blocker.code === "STALE_EVIDENCE"),
    );
  } finally {
    store.close();
  }
});

test("preparation gate maps unified exact-source duplicates to the existing blocker contract", () => {
  const { store, execution, rowId } = setup();
  try {
    const detailId = saveDetail(execution);
    makeReadyFacts(store, execution, rowId, detailId);
    const scan = execution.sources.begin("shop-a");
    execution.sources.put(
      scan,
      "shop-a",
      {
        itemId: "existing-item",
        code: "existing-code",
        title: "现有商品标题可以不同",
        shop: "shop-a",
        status: "已发布",
        sku: "",
      },
      "revision-1",
      ["123456"],
      true,
    );
    execution.sources.finish(scan, [
      { partition: "visible-normal", expected: 1, seen: 1 },
      { partition: "visible-draft", expected: 0, seen: 0 },
      { partition: "hidden-normal", expected: 0, seen: 0 },
      { partition: "hidden-draft", expected: 0, seen: 0 },
    ]);
    const result = execution.evaluateForPreparation(rowId, { now });
    assert.equal(result.status, "BLOCKED");
    assert.deepEqual(
      result.blockers.filter((blocker) => blocker.code === "DUPLICATE"),
      [{ code: "DUPLICATE", message: "来源索引已有1条目标SKU" }],
    );
  } finally {
    store.close();
  }
});

test("submitted result remains distinct from on-sale and reconciliation only appends evidence", async () => {
  const { store, execution, rowId } = setup();
  try {
    const detailId = saveDetail(execution);
    makeReadyFacts(store, execution, rowId, detailId);
    const jobs = new Jobs(store, "shop-a");
    const jobId = jobs.enqueue(["123456"], {
      source: "browser",
      brandId: "brand-1",
      categoryId: "category-1",
      policyId: "policy-1",
      unit: "盒",
      through: "submit",
    }).items[0].id;
    execution.associateJob(rowId, jobId);
    execution.recordResult(
      rowId,
      "SUBMITTED",
      { remoteId: "remote-item-1", receipt: "fabricated-receipt" },
      "2026-09-20T04:30:00.000Z",
    );
    assert.equal(execution.row(rowId).resultState, "SUBMITTED");
    assert.notEqual(execution.row(rowId).resultState, "ON_SALE");
    execution.associateJob(rowId, jobId);
    execution.acceptExactSource(rowId, {
      detailReceiptId: detailId,
      brandId: "brand-1",
      categoryId: "category-1",
      unit: "盒",
    });
    assert.equal(execution.row(rowId).status, "RESULT");
    execution.recordResult(
      rowId,
      "REJECTED",
      { remoteId: "remote-item-1", reason: "fabricated review" },
      "2026-09-20T05:00:00.000Z",
    );
    execution.recordResult(
      rowId,
      "SUBMITTED",
      { remoteId: "remote-item-1", repair: "fabricated repair" },
      "2026-09-20T06:00:00.000Z",
    );
    assert.equal(execution.row(rowId).resultState, "SUBMITTED");
    assert.throws(
      () =>
        execution.recordResult(
          rowId,
          "ON_SALE",
          { remoteId: "different-remote" },
          "2026-09-20T07:00:00.000Z",
        ),
      /远端商品身份/,
    );

    const before = store.db
      .prepare("SELECT COUNT(*) n FROM operations")
      .get() as any;
    await execution.reconcile(rowId, () => ({
      state: "SUBMITTED",
      source: "read-only-detail",
    }));
    const after = store.db
      .prepare("SELECT COUNT(*) n FROM operations")
      .get() as any;
    assert.equal(after.n, before.n);
    assert.equal(execution.evidence(rowId).at(-1)?.kind, "reconciliation");
  } finally {
    store.close();
  }
});
