import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  AnalyticsStore,
  type ObservationInput,
} from "../src/analytics/core.js";

const day = 86_400_000;
function observation(
  overrides: Partial<ObservationInput> = {},
): ObservationInput {
  return {
    platform: "hezi",
    shop: "shop-a",
    itemId: "item-1",
    skuId: "sku-1",
    title: "维达卷纸 12卷",
    brand: "维达",
    category: "纸品",
    packaging: "12卷",
    saleUnit: "提",
    sourceEntry: "hezi-shop-list-cohort-v1",
    field: "displaySales",
    fieldVersion: "v1",
    semanticsVersion: "cumulative-display-sales-v1",
    currency: "CNY",
    value: 100,
    priceMinor: 2_950,
    raw: { sales: 100 },
    ...overrides,
  };
}
function importAt(
  store: AnalyticsStore,
  id: string,
  at: string,
  rows: ObservationInput[],
  coverage: "complete" | "partial" = "complete",
) {
  return store.importObservations(rows, {
    id,
    source: "fixture",
    observedAt: at,
    coverage,
    expectedCount: rows.length,
  });
}

test("observation ingestion is replay-idempotent and isolates conflicting payloads", () => {
  const store = new AnalyticsStore(":memory:");
  try {
    const at = "2026-09-17T00:00:00.000Z",
      row = observation();
    assert.equal(importAt(store, "run-1", at, [row]).inserted, 1);
    assert.deepEqual(importAt(store, "run-1", at, [row]), {
      runId: "run-1",
      received: 1,
      inserted: 1,
      duplicates: 0,
      conflicts: 0,
      rejected: 0,
      status: "accepted",
    });
    assert.equal(importAt(store, "run-2", at, [row]).duplicates, 1);
    const conflict = importAt(store, "run-3", at, [
      observation({ value: 101, raw: { sales: 101 } }),
    ]);
    assert.equal(conflict.conflicts, 1);
    assert.equal(store.health().observations, 1);
    assert.equal(store.health().conflicts, 1);
    assert.equal(store.listMarket({ scope: "historical" }).total, 0);
  } finally {
    store.close();
  }
});

test("fixed-window comparison rejects changed units, keeps sources separate, and flags negative deltas", () => {
  const store = new AnalyticsStore(":memory:");
  try {
    const start = "2026-09-17T00:00:00.000Z",
      end = "2026-09-19T00:00:00.000Z";
    importAt(store, "s", start, [
      observation(),
      observation({ itemId: "item-2", skuId: "sku-2", value: 80 }),
      observation({
        itemId: "item-3",
        skuId: "sku-3",
        sourceEntry: "other",
        value: 1,
      }),
    ]);
    importAt(store, "e", end, [
      observation({ saleUnit: "箱", value: 110 }),
      observation({ itemId: "item-2", skuId: "sku-2", value: 70 }),
      observation({
        itemId: "item-3",
        skuId: "sku-3",
        sourceEntry: "other",
        value: 4,
      }),
    ]);
    const result = store.listMarket({
      scope: "recent",
      startAt: start,
      endAt: end,
      toleranceMs: day,
    });
    assert.equal(result.available, true);
    assert.deepEqual(
      result.items.map((x) => [x.skuId, x.status, x.reason]),
      [
        ["sku-3", "comparable", null],
        ["sku-2", "anomalous", "cumulative value decreased"],
        [
          "sku-1",
          "incomparable",
          "comparison contract changed (packaging, unit, entry, field semantics, or currency)",
        ],
      ],
    );
    assert.equal(result.items[0].delta, 3);
    assert.equal(result.items[0].valueIndexMinor, 8_850);
  } finally {
    store.close();
  }
});

test("missing baseline is unavailable for the requested window and partial runs stay off the main list", () => {
  const store = new AnalyticsStore(":memory:");
  try {
    const start = "2026-09-01T00:00:00.000Z",
      end = "2026-09-08T00:00:00.000Z";
    importAt(store, "end", end, [observation()]);
    importAt(
      store,
      "partial",
      start,
      [observation({ itemId: "partial", skuId: "partial" })],
      "partial",
    );
    const result = store.listMarket({
      scope: "recent",
      startAt: start,
      endAt: end,
      toleranceMs: 1_000,
    });
    assert.equal(result.available, false);
    assert.equal(result.total, 1);
    assert.equal(result.items[0].status, "incomparable");
    assert.equal(result.items[0].reason, "missing fixed-window baseline");
    const historical = store.listMarket({ scope: "historical" });
    assert.equal(historical.total, 2);
    assert.deepEqual(historical.items.map((item) => item.coverage).sort(), [
      "complete",
      "partial",
    ]);
    assert.equal(
      store.listMarket({ scope: "historical", coverage: "complete" }).total,
      1,
    );
    const none = store.listMarket({
      scope: "recent",
      startAt: "2025-01-01T00:00:00Z",
      endAt: "2025-01-08T00:00:00Z",
      toleranceMs: 1_000,
    });
    assert.equal(none.available, false);
  } finally {
    store.close();
  }
});

test("historical candidates paginate, filter, and rank deterministically by value index", () => {
  const store = new AnalyticsStore(":memory:");
  try {
    const at = "2026-09-17T00:00:00Z";
    importAt(store, "history", at, [
      observation({
        itemId: "b",
        skuId: "b",
        title: "纸品 B",
        value: 2,
        priceMinor: 100,
      }),
      observation({
        itemId: "a",
        skuId: "a",
        title: "纸品 A",
        value: 2,
        priceMinor: 100,
      }),
      observation({
        itemId: "c",
        skuId: "c",
        title: "清洁 C",
        category: "清洁",
        value: 1,
        priceMinor: 500,
      }),
    ]);
    const first = store.listMarket({
      scope: "historical",
      search: "纸品",
      page: 1,
      pageSize: 1,
    });
    const second = store.listMarket({
      scope: "historical",
      search: "纸品",
      page: 2,
      pageSize: 1,
    });
    assert.equal(first.total, 2);
    assert.equal(first.pages, 2);
    assert.equal(first.items[0].skuId, "a");
    assert.equal(second.items[0].skuId, "b");
    assert.deepEqual(first.facets?.category, [
      { value: "纸品", count: 2, denominator: 2, percent: 1 },
    ]);
    assert.equal(
      store.listMarket({ scope: "historical", search: "%" }).total,
      0,
    );
  } finally {
    store.close();
  }
});

test("identical evidence rebuilds stable candidate and opportunity identities", () => {
  const build = () => {
    const store = new AnalyticsStore(":memory:");
    importAt(store, "stable-run", "2026-09-17T00:00:00Z", [observation()]);
    const candidate = store.listMarket({ scope: "historical" }).items[0];
    const opportunity = store.upsertOpportunity(candidate.id, {
      route: "review",
      nextAction: "核验",
      reason: "固定证据",
      authorizationStatus: "needs-review",
      ownMatchStatus: "needs-review",
    });
    return { store, candidateId: candidate.id, opportunityId: opportunity.id };
  };
  const first = build(),
    second = build();
  try {
    assert.equal(first.candidateId, second.candidateId);
    assert.equal(first.opportunityId, second.opportunityId);
  } finally {
    first.store.close();
    second.store.close();
  }
});

test("opportunities have stable identities and brand readiness is conservative", () => {
  const store = new AnalyticsStore(":memory:");
  try {
    const one = store.upsertOpportunity("candidate-1", {
      brand: "维达",
      route: "bd",
      nextAction: "核验授权",
      reason: "需求高但授权缺失",
      demandRank: 1,
      authorizationStatus: "missing",
      ownMatchStatus: "none",
    });
    const two = store.upsertOpportunity("candidate-1", {
      brand: "维达",
      route: "prepare",
      nextAction: "准备",
      reason: "已核验",
      demandRank: 1,
      authorizationStatus: "verified",
      ownMatchStatus: "none",
    });
    assert.equal(one.id, two.id);
    assert.equal(two.revision, 2);
    assert.equal(store.listOpportunities({ search: "准备" }).total, 1);
    assert.equal(
      store.updateBrandTask("维达", { status: "usable" }).readiness,
      "needs-identity-review",
    );
    assert.equal(
      store.updateBrandTask("维达", {
        identityVerified: true,
        identitySource: "manual",
      }).readiness,
      "needs-authorization",
    );
    assert.equal(
      store.updateBrandTask("维达", {
        scope: "shop-a/纸品",
        authorizationVerifiedAt: "2026-09-19T00:00:00Z",
        authorizationValidUntil: "2099-01-01T00:00:00Z",
      }).readiness,
      "needs-authorization",
    );
    assert.equal(
      store.projectBrandAuthorization("维达", {
        scope: "shop-a/纸品",
        verifiedAt: new Date().toISOString(),
        validUntil: "2099-01-01T00:00:00Z",
        source: "platform",
        sourceRef: "grant-1",
      }).readiness,
      "ready",
    );
    assert.equal(store.overview().recentComparable, null);
  } finally {
    store.close();
  }
});

test("new evidence for the same market identity preserves human opportunity state", () => {
  const store = new AnalyticsStore(":memory:");
  try {
    importAt(store, "day-1", "2026-09-17T00:00:00Z", [observation()]);
    const firstCandidate = store.listMarket({ scope: "historical" }).items[0];
    const first = store.upsertOpportunity(firstCandidate.id, {
      brand: "维达",
      route: "review",
      nextAction: "机器初始动作",
      reason: "机器初始说明",
      demandRank: 10,
      authorizationStatus: "missing",
      ownMatchStatus: "needs-review",
    });
    const human = store.updateOpportunity(first.id, {
      status: "selected",
      owner: "业务甲",
      reason: "人工备注必须保留",
      decisionId: "decision-1",
      expectedRevision: first.revision,
    });
    importAt(store, "day-2", "2026-09-18T00:00:00Z", [
      observation({ value: 120, raw: { sales: 120 } }),
    ]);
    const secondCandidate = store.listMarket({ scope: "historical" }).items[0];
    assert.notEqual(firstCandidate.id, secondCandidate.id);
    const refreshed = store.upsertOpportunity(secondCandidate.id, {
      brand: "维达",
      route: "prepare",
      status: "open",
      owner: null,
      nextAction: "机器刷新动作",
      reason: "机器刷新说明",
      demandRank: 1,
      authorizationStatus: "verified",
      ownMatchStatus: "none",
      decisionId: null,
    });
    assert.equal(refreshed.id, first.id);
    assert.equal(store.listOpportunities().total, 1);
    assert.equal(refreshed.candidateId, secondCandidate.id);
    assert.equal(refreshed.status, "selected");
    assert.equal(refreshed.owner, "业务甲");
    assert.equal(refreshed.reason, "人工备注必须保留");
    assert.equal(refreshed.decisionId, "decision-1");
    assert.equal(refreshed.route, "prepare");
    assert.equal(refreshed.demandRank, 1);
    assert.equal(refreshed.revision, human.revision + 1);
    const unchanged = store.upsertOpportunity(secondCandidate.id, {
      brand: "维达",
      route: "prepare",
      nextAction: "机器刷新动作",
      reason: "不会覆盖人工备注",
      demandRank: 1,
      authorizationStatus: "verified",
      ownMatchStatus: "none",
    });
    assert.equal(unchanged.revision, refreshed.revision);
    assert.equal(
      (
        store.db
          .prepare(
            "SELECT count(*) n FROM analytics_opportunity_evidence WHERE opportunity_id=?",
          )
          .get(first.id) as any
      ).n,
      2,
    );
  } finally {
    store.close();
  }
});

test("different packaging remains a separate opportunity for the same SKU", () => {
  const store = new AnalyticsStore(":memory:");
  try {
    importAt(store, "pack-1", "2026-09-17T00:00:00Z", [
      observation({ packaging: "10卷/提" }),
    ]);
    importAt(store, "pack-2", "2026-09-18T00:00:00Z", [
      observation({ packaging: "12卷/提", value: 110, raw: { sales: 110 } }),
    ]);
    const candidates = store.listMarket({ scope: "historical" }).items;
    assert.equal(candidates.length, 2);
    const opportunities = candidates.map((candidate, index) =>
      store.upsertOpportunity(candidate.id, {
        route: "review",
        nextAction: "核验包装",
        reason: "包装身份独立",
        demandRank: index + 1,
        authorizationStatus: "needs-review",
        ownMatchStatus: "needs-review",
      }),
    );
    assert.notEqual(opportunities[0].id, opportunities[1].id);
    assert.notEqual(opportunities[0].identityKey, opportunities[1].identityKey);
    assert.equal(store.listOpportunities().total, 2);
  } finally {
    store.close();
  }
});

test("opportunity identity migration preserves legacy IDs and human fields", () => {
  const directory = mkdtempSync(join(tmpdir(), "analytics-opportunity-"));
  const path = join(directory, "analytics.sqlite");
  const legacy = new DatabaseSync(path);
  legacy.exec(`CREATE TABLE analytics_opportunities(
    id TEXT PRIMARY KEY,candidate_id TEXT NOT NULL,brand TEXT,route TEXT NOT NULL,
    status TEXT NOT NULL,owner TEXT,next_action TEXT NOT NULL,reason TEXT NOT NULL,
    demand_rank INTEGER,authorization_status TEXT NOT NULL,own_match_status TEXT NOT NULL,
    decision_id TEXT,revision INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
    INSERT INTO analytics_opportunities VALUES(
      'legacy-id','candidate-legacy','品牌','review','selected','业务甲','旧动作','人工备注',1,
      'missing','needs-review','decision-legacy',4,'2026-09-17T00:00:00Z','2026-09-17T00:00:00Z');`);
  legacy.close();
  const store = new AnalyticsStore(path);
  try {
    const migrated = store.listOpportunities().items[0];
    assert.equal(migrated.id, "legacy-id");
    assert.match(migrated.identityKey, /^legacy_/);
    const refreshed = store.upsertOpportunity("candidate-legacy", {
      brand: "品牌",
      route: "prepare",
      nextAction: "新动作",
      reason: "机器说明",
      demandRank: 1,
      authorizationStatus: "verified",
      ownMatchStatus: "none",
    });
    assert.equal(refreshed.id, "legacy-id");
    assert.equal(refreshed.status, "selected");
    assert.equal(refreshed.owner, "业务甲");
    assert.equal(refreshed.reason, "人工备注");
    assert.equal(refreshed.decisionId, "decision-legacy");
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
