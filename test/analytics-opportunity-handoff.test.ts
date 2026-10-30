import assert from "node:assert/strict";
import test from "node:test";
import { AnalyticsStore } from "../src/analytics/core.js";
import { AnalyticsOpportunityHandoff } from "../src/analytics/opportunity-handoff.js";
import { OpportunityExecution } from "../src/opportunity-execution.js";
import { Store } from "../src/store.js";

function fixture() {
  const analytics = new AnalyticsStore(":memory:");
  analytics.importObservations(
    [
      {
        platform: "hezi",
        shop: "market-shop-7",
        itemId: "market-item-9",
        skuId: "market-sku-3",
        title: "测试卷纸 12卷",
        brand: "测试品牌",
        category: "纸品",
        packaging: "12卷",
        saleUnit: "提",
        sourceEntry: "hezi-shop-list-v1",
        field: "displaySales",
        fieldVersion: "v1",
        semanticsVersion: "cumulative-display-sales-v1",
        currency: "CNY",
        value: 100,
        priceMinor: 1990,
      },
    ],
    {
      id: "run-1",
      source: "fixture",
      observedAt: "2026-09-20T04:00:00.000Z",
      coverage: "complete",
      expectedCount: 1,
    },
  );
  const candidate = analytics.listMarket({
    scope: "historical",
    sourceEntry: "hezi-shop-list-v1",
  }).items[0];
  const opportunity = analytics.upsertOpportunity(candidate.id, {
    brand: candidate.brand,
    route: "prepare",
    nextAction: "核对来源",
    reason: "测试候选",
    demandRank: 1,
    authorizationStatus: "needs-review",
    ownMatchStatus: "none",
  });
  const state = new Store(":memory:");
  const ledger = new OpportunityExecution(state);
  let operationalRows: any[] = [];
  const handoff = new AnalyticsOpportunityHandoff(
    analytics,
    ledger,
    "own-shop",
    () => ({ rows: operationalRows }),
  );
  const evidence = handoff.snapshot(opportunity.candidateId)!;
  return {
    analytics,
    state,
    ledger,
    handoff,
    opportunity,
    evidence,
    setOperationalRows(rows: any[]) {
      operationalRows = rows;
    },
  };
}

test("analytics transfer freezes server-resolved identities and retries idempotently", () => {
  const f = fixture();
  try {
    const input = {
      selections: [
        {
          id: f.opportunity.id,
          revision: f.opportunity.revision,
          evidence: f.evidence,
          targetSku: "client-must-not-control-this",
          authorizationStatus: "verified",
        },
      ],
    };
    const first = f.handoff.transfer(input);
    const second = f.handoff.transfer(input);
    assert.equal(first.reused, false);
    assert.equal(second.reused, true);
    assert.equal(second.cohortKey, first.cohortKey);
    const [row] = f.ledger.rows(first.cohortKey);
    assert.equal(row.shop, "own-shop");
    assert.equal(row.marketShopId, "market-shop-7");
    assert.equal(row.marketSkuId, "market-sku-3");
    assert.equal(row.targetSku, null);
    const transferEvidence: any = f.state.db
      .prepare(
        "SELECT payload FROM opportunity_evidence WHERE row_id=? AND kind='analytics-transfer'",
      )
      .get(row.id);
    assert.deepEqual(JSON.parse(transferEvidence.payload), {
      analyticsOpportunityId: f.opportunity.id,
      revision: f.opportunity.revision,
      evidence: f.evidence,
    });
  } finally {
    f.analytics.close();
    f.state.close();
  }
});

test("analytics transfer rejects stale revisions and foreign evidence snapshots", () => {
  const f = fixture();
  try {
    assert.throws(
      () =>
        f.handoff.transfer({
          selections: [
            { id: f.opportunity.id, revision: 99, evidence: f.evidence },
          ],
        }),
      /版本已更新/,
    );
    assert.throws(
      () =>
        f.handoff.transfer({
          selections: [
            {
              id: f.opportunity.id,
              revision: f.opportunity.revision,
              evidence: {
                ...f.evidence,
                observationIds: ["foreign-observation"],
              },
            },
          ],
        }),
      /证据已更新或不属于/,
    );
    assert.equal(
      f.state.db.prepare("SELECT count(*) n FROM opportunity_rows").get().n,
      0,
    );
  } finally {
    f.analytics.close();
    f.state.close();
  }
});

test("operational projection keeps queued work pending and does not infer on-sale", () => {
  const f = fixture();
  try {
    f.setOperationalRows([
      {
        opportunityId: f.opportunity.id,
        cohortId: "cohort-1",
        id: "row-1",
        status: "QUEUED",
        jobId: "job-1",
        remoteId: null,
        updatedAt: "2026-09-20T05:00:00.000Z",
      },
    ]);
    const projected = f.handoff
      .project([f.opportunity.id])
      .get(f.opportunity.id);
    assert.equal(projected?.status, "QUEUED");
    assert.equal(projected?.pending, true);
  } finally {
    f.analytics.close();
    f.state.close();
  }
});

test("overlapping transfers reuse an opportunity row and import only novel work", () => {
  const f = fixture();
  try {
    const firstInput = {
      id: f.opportunity.id,
      revision: f.opportunity.revision,
      evidence: f.evidence,
    };
    f.handoff.transfer({ selections: [firstInput] });
    f.analytics.importObservations(
      [
        {
          platform: "hezi",
          shop: "market-shop-8",
          itemId: "market-item-10",
          skuId: "market-sku-4",
          title: "第二个商品",
          saleUnit: "盒",
          sourceEntry: "hezi-shop-list-v1",
          field: "displaySales",
          fieldVersion: "v1",
          semanticsVersion: "cumulative-display-sales-v1",
          currency: "CNY",
          value: 50,
        },
      ],
      {
        id: "run-2",
        source: "fixture",
        observedAt: "2026-09-20T05:00:00.000Z",
        coverage: "complete",
        expectedCount: 1,
      },
    );
    const candidate = f.analytics.listMarket({
      scope: "historical",
      sourceEntry: "hezi-shop-list-v1",
      shop: "market-shop-8",
    }).items[0];
    const second = f.analytics.upsertOpportunity(candidate.id, {
      route: "prepare",
      nextAction: "核对来源",
      reason: "第二候选",
      authorizationStatus: "needs-review",
      ownMatchStatus: "none",
    });
    const result = f.handoff.transfer({
      selections: [
        firstInput,
        {
          id: second.id,
          revision: second.revision,
          evidence: f.handoff.snapshot(second.candidateId),
        },
      ],
    });
    assert.equal(result.existingCount, 1);
    assert.equal(result.rowCount, 1);
    assert.equal(
      f.state.db.prepare("SELECT count(*) n FROM opportunity_rows").get().n,
      2,
    );
    assert.equal(
      f.state.db
        .prepare(
          "SELECT count(*) n FROM opportunity_rows WHERE opportunity_id=?",
        )
        .get(f.opportunity.id).n,
      1,
    );
  } finally {
    f.analytics.close();
    f.state.close();
  }
});

test("an existing manifest row is reused and receives the analytics evidence binding", () => {
  const f = fixture();
  try {
    f.ledger.importCohort({
      cohortKey: "previous-manifest",
      shop: "own-shop",
      sourceReportId: "previous-report",
      importedAt: "2026-09-19T04:00:00.000Z",
      rows: [
        {
          opportunityId: f.opportunity.id,
          marketItemId: "market-item-9",
          marketShopId: "market-shop-7",
          marketSkuId: "market-sku-3",
          rank: 1,
          targetSku: null,
        },
      ],
    });
    const result = f.handoff.transfer({
      selections: [
        {
          id: f.opportunity.id,
          revision: f.opportunity.revision,
          evidence: f.evidence,
        },
      ],
    });
    assert.equal(result.reused, true);
    assert.equal(result.rowCount, 0);
    assert.equal(result.existingCount, 1);
    assert.equal(
      f.state.db.prepare("SELECT count(*) n FROM opportunity_rows").get().n,
      1,
    );
    assert.equal(
      f.state.db
        .prepare(
          "SELECT count(*) n FROM opportunity_evidence WHERE kind='analytics-transfer'",
        )
        .get().n,
      1,
    );
  } finally {
    f.analytics.close();
    f.state.close();
  }
});

test("a later analytics revision cannot silently create another operational row", () => {
  const f = fixture();
  try {
    f.handoff.transfer({
      selections: [
        {
          id: f.opportunity.id,
          revision: f.opportunity.revision,
          evidence: f.evidence,
        },
      ],
    });
    const revised = f.analytics.updateOpportunity(f.opportunity.id, {
      expectedRevision: f.opportunity.revision,
      nextAction: "修订后的动作",
    });
    assert.throws(
      () =>
        f.handoff.transfer({
          selections: [
            {
              id: revised.id,
              revision: revised.revision,
              evidence: f.handoff.snapshot(revised.candidateId),
            },
          ],
        }),
      /已有不同版本或证据.*人工解决/,
    );
    assert.equal(
      f.state.db.prepare("SELECT count(*) n FROM opportunity_rows").get().n,
      1,
    );
  } finally {
    f.analytics.close();
    f.state.close();
  }
});

test("projection prefers submitted truth over a duplicate pending row", () => {
  const f = fixture();
  try {
    f.setOperationalRows([
      {
        opportunityId: f.opportunity.id,
        cohortId: "new-pending",
        id: "row-new",
        status: "IMPORTED",
        updatedAt: "2026-09-21T00:00:00.000Z",
      },
      {
        opportunityId: f.opportunity.id,
        cohortId: "old-submitted",
        id: "row-old",
        status: "SUBMITTED",
        jobId: "submitted-job",
        updatedAt: "2026-09-20T00:00:00.000Z",
      },
    ]);
    const projected = f.handoff
      .project([f.opportunity.id])
      .get(f.opportunity.id);
    assert.equal(projected?.status, "SUBMITTED");
    assert.equal(projected?.pending, false);
  } finally {
    f.analytics.close();
    f.state.close();
  }
});

for (const latestStatus of ["REJECTED", "UNKNOWN_OUTCOME"]) {
  test(`projection uses newer ${latestStatus} observation over older on-sale for the same job`, () => {
    const f = fixture();
    try {
      f.setOperationalRows([
        {
          opportunityId: f.opportunity.id,
          cohortId: "old",
          id: "old-row",
          status: "ON_SALE",
          jobId: "same-job",
          remoteId: "remote-1",
          remoteObservedAt: "2026-09-20T00:00:00.000Z",
          updatedAt: "2026-09-20T00:00:00.000Z",
        },
        {
          opportunityId: f.opportunity.id,
          cohortId: "new",
          id: "new-row",
          status: latestStatus,
          jobId: "same-job",
          remoteId: "remote-1",
          remoteObservedAt: "2026-09-21T00:00:00.000Z",
          updatedAt: "2026-09-21T00:00:00.000Z",
        },
      ]);
      const projected = f.handoff
        .project([f.opportunity.id])
        .get(f.opportunity.id);
      assert.equal(projected?.status, latestStatus);
    } finally {
      f.analytics.close();
      f.state.close();
    }
  });
}

test("projection reports conflict for distinct remote operational identities", () => {
  const f = fixture();
  try {
    f.setOperationalRows([
      {
        opportunityId: f.opportunity.id,
        cohortId: "one",
        id: "row-one",
        status: "ON_SALE",
        jobId: "job-one",
        remoteId: "remote-one",
        updatedAt: "2026-09-20T00:00:00.000Z",
      },
      {
        opportunityId: f.opportunity.id,
        cohortId: "two",
        id: "row-two",
        status: "REJECTED",
        jobId: "job-two",
        remoteId: "remote-two",
        updatedAt: "2026-09-21T00:00:00.000Z",
      },
    ]);
    const projected = f.handoff
      .project([f.opportunity.id])
      .get(f.opportunity.id);
    assert.equal(projected?.status, "CONFLICT");
    assert.equal(projected?.needsReconciliation, true);
    assert.equal(projected?.remoteId, null);
  } finally {
    f.analytics.close();
    f.state.close();
  }
});

test("transfer rejects ambiguous pre-existing duplicate rows instead of choosing one", () => {
  const f = fixture();
  try {
    for (const cohortKey of ["old-one", "old-two"])
      f.ledger.importCohort({
        cohortKey,
        shop: "own-shop",
        sourceReportId: cohortKey,
        importedAt:
          cohortKey === "old-one"
            ? "2026-09-18T00:00:00.000Z"
            : "2026-09-19T00:00:00.000Z",
        rows: [
          {
            opportunityId: f.opportunity.id,
            marketItemId: "market-item-9",
            marketShopId: "market-shop-7",
            marketSkuId: "market-sku-3",
            rank: 1,
            targetSku: null,
          },
        ],
      });
    assert.throws(
      () =>
        f.handoff.transfer({
          selections: [
            {
              id: f.opportunity.id,
              revision: f.opportunity.revision,
              evidence: f.evidence,
            },
          ],
        }),
      /多个运营关系.*人工对账/,
    );
  } finally {
    f.analytics.close();
    f.state.close();
  }
});

test("projection does not choose an optimistic status when duplicate timestamps are invalid", () => {
  const f = fixture();
  try {
    f.setOperationalRows([
      {
        opportunityId: f.opportunity.id,
        id: "row-one",
        status: "ON_SALE",
        jobId: "same-job",
        remoteId: "same-remote",
        updatedAt: "invalid",
      },
      {
        opportunityId: f.opportunity.id,
        id: "row-two",
        status: "REJECTED",
        jobId: "same-job",
        remoteId: "same-remote",
        updatedAt: "also-invalid",
      },
    ]);
    const projected = f.handoff
      .project([f.opportunity.id])
      .get(f.opportunity.id);
    assert.equal(projected?.status, "CONFLICT");
    assert.equal(projected?.needsReconciliation, true);
  } finally {
    f.analytics.close();
    f.state.close();
  }
});
