import test from "node:test";
import assert from "node:assert/strict";
import {
  AnalyticsStore,
  type ObservationInput,
} from "../src/analytics/core.js";
import {
  AnalyticsCollection,
  CollectionAdapterError,
  type CollectionPageAdapter,
} from "../src/analytics/collection.js";

const observation = (page: number, index = 0): ObservationInput => ({
  platform: "hezi",
  shop: "shop-a",
  itemId: `item-${page}-${index}`,
  skuId: `sku-${page}-${index}`,
  title: `商品 ${page}-${index}`,
  brand: "品牌",
  category: "分类",
  packaging: "一件",
  saleUnit: "件",
  sourceEntry: "verified-shop-list-v1",
  field: "displaySales",
  fieldVersion: "v1",
  semanticsVersion: "cumulative-v1",
  currency: "CNY",
  value: page * 10 + index,
  priceMinor: 1000,
  raw: { page, index },
});
function fixture(
  adapter: CollectionPageAdapter,
  now = Date.parse("2026-09-19T00:00:00Z"),
  options: Record<string, unknown> = {},
) {
  const store = new AnalyticsStore(":memory:");
  const clock = { value: now };
  const collection = new AnalyticsCollection(store, adapter, undefined, {
    now: () => clock.value,
    ownerId: "owner-a",
    ...options,
  });
  collection.configure({
    id: "daily-shop-a",
    source: "verified-list",
    shopId: "shop-a",
    intervalMs: 3_600_000,
    pageSize: 50,
  });
  collection.start("daily-shop-a");
  return { store, collection, clock };
}

test("tick reads at most three pages, resumes from its durable checkpoint, then promotes only the whole scope", async () => {
  const calls: number[] = [];
  const adapter: CollectionPageAdapter = {
    async readPage(r) {
      calls.push(r.page);
      return {
        page: r.page,
        totalPages: 5,
        totalCount: 5,
        observedAt: `2026-09-19T00:0${r.page}:00Z`,
        completeScope: r.page === 5,
        observations: [observation(r.page)],
      };
    },
  };
  const f = fixture(adapter);
  try {
    const first = await f.collection.tick();
    assert.deepEqual(calls, [1, 2, 3]);
    assert.equal(first.status, "progress");
    assert.equal(
      f.store.db
        .prepare(
          "SELECT count(*) n FROM analytics_collection_runs WHERE coverage='partial'",
        )
        .get()!.n,
      3,
    );
    const second = await f.collection.tick();
    assert.deepEqual(calls, [1, 2, 3, 4, 5]);
    assert.equal(second.status, "completed");
    assert.equal(
      f.store.db
        .prepare(
          "SELECT count(*) n FROM analytics_collection_runs WHERE coverage='complete'",
        )
        .get()!.n,
      5,
    );
    assert.equal(f.collection.health().completeRuns, 1);
  } finally {
    f.store.close();
  }
});

test("same-page retry after interrupted import is idempotent and does not skip ahead", async () => {
  let calls = 0;
  const adapter: CollectionPageAdapter = {
    async readPage(r) {
      calls++;
      return {
        page: r.page,
        totalPages: 1,
        totalCount: 1,
        observedAt: "2026-09-19T00:00:00Z",
        completeScope: true,
        observations: [observation(1)],
      };
    },
  };
  const f = fixture(adapter);
  try {
    const schedule = f.collection.list()[0];
    const runId = "daily-shop-a:interrupted";
    f.store.db
      .prepare(
        "INSERT INTO analytics_collection_scheduler_run(id,schedule_id,status,started_at) VALUES(?,?,'running',?)",
      )
      .run(runId, schedule.id, "2026-09-19T00:00:00Z");
    f.store.db
      .prepare(
        "UPDATE analytics_collection_schedule SET active_run_id=? WHERE id=?",
      )
      .run(runId, schedule.id);
    f.store.importObservations([observation(1)], {
      id: `${runId}:page:1`,
      source: "verified-list",
      observedAt: "2026-09-19T00:00:00Z",
      coverage: "partial",
      expectedCount: 1,
    });
    const result = await f.collection.tick();
    assert.equal(result.status, "completed");
    assert.equal(calls, 1);
    assert.equal(f.store.health().observations, 1);
  } finally {
    f.store.close();
  }
});

test("a database lease prevents parallel capture", async () => {
  let calls = 0;
  const f = fixture({
    async readPage() {
      calls++;
      throw new Error("must not run");
    },
  });
  try {
    f.store.db
      .prepare(
        "INSERT INTO analytics_collection_scheduler_lease VALUES('market','other',?)",
      )
      .run(f.clock.value + 60_000);
    assert.equal((await f.collection.tick()).status, "busy");
    assert.equal(calls, 0);
  } finally {
    f.store.close();
  }
});

test("paused schedules make no adapter or guard call and resume explicitly", async () => {
  let reads = 0,
    guards = 0;
  const store = new AnalyticsStore(":memory:");
  const adapter = {
    async readPage() {
      reads++;
      throw new Error("unexpected");
    },
  };
  const guard = {
    async acquire() {
      guards++;
      return null;
    },
  };
  const c = new AnalyticsCollection(store, adapter, guard, {
    now: () => 0,
    ownerId: "owner",
  });
  try {
    c.configure({
      id: "s",
      source: "x",
      shopId: "shop",
      intervalMs: 3_600_000,
    });
    c.start("s");
    c.pause("s", "manual review");
    assert.equal((await c.tick()).status, "idle");
    assert.equal(reads, 0);
    assert.equal(guards, 0);
    assert.equal(c.resume("s").status, "active");
  } finally {
    store.close();
  }
});

test("auth, rate limit, user control and unavailable failures pause without retry spin", async () => {
  for (const kind of [
    "auth",
    "rate_limit",
    "user_control",
    "unavailable",
  ] as const) {
    let calls = 0;
    const f = fixture({
      async readPage() {
        calls++;
        throw new CollectionAdapterError(kind, `${kind} stop`);
      },
    });
    try {
      const result = await f.collection.tick();
      assert.equal(result.status, "paused");
      assert.equal(result.reason, kind);
      assert.equal(calls, 1);
      assert.match(f.collection.list()[0].pauseReason!, new RegExp(kind));
      assert.equal((await f.collection.tick()).status, "idle");
      assert.equal(calls, 1);
    } finally {
      f.store.close();
    }
  }
});

test("timeouts retry the same page with bounded backoff and pause after the third attempt", async () => {
  let calls = 0;
  const f = fixture({
    async readPage() {
      calls++;
      throw new CollectionAdapterError("timeout", "slow", 3_600_000);
    },
  });
  try {
    for (let attempt = 1; attempt <= 2; attempt++) {
      const r = await f.collection.tick();
      assert.equal(r.reason, "timeout_backoff");
      assert.equal(f.collection.list()[0].status, "active");
      f.clock.value += 3_600_000;
    }
    const last = await f.collection.tick();
    assert.equal(last.status, "paused");
    assert.equal(last.reason, "timeout");
    assert.equal(calls, 3);
    const run: any = f.store.db
      .prepare(
        "SELECT next_page,timeout_attempts FROM analytics_collection_scheduler_run",
      )
      .get();
    assert.equal(run.next_page, 1);
    assert.equal(run.timeout_attempts, 3);
  } finally {
    f.store.close();
  }
});

test("final-page claims cannot turn missing pages or count drift into complete coverage", async () => {
  const f = fixture({
    async readPage() {
      return {
        page: 1,
        totalPages: 1,
        totalCount: 2,
        observedAt: "2026-09-19T00:00:00Z",
        completeScope: true,
        observations: [observation(1)],
      };
    },
  });
  try {
    const r = await f.collection.tick();
    assert.equal(r.status, "paused");
    assert.match(
      f.collection.list()[0].pauseReason!,
      /unavailable: complete scope checkpoint coverage/,
    );
    assert.equal(
      f.store.db
        .prepare("SELECT coverage FROM analytics_collection_runs")
        .get()!.coverage,
      "partial",
    );
  } finally {
    f.store.close();
  }
});

test("guard acquisition and release wrap real adapter work", async () => {
  const events: string[] = [];
  const store = new AnalyticsStore(":memory:");
  const c = new AnalyticsCollection(
    store,
    {
      async readPage(r) {
        events.push("read");
        return {
          page: r.page,
          totalPages: 1,
          totalCount: 1,
          observedAt: "2026-09-19T00:00:00Z",
          completeScope: true,
          observations: [observation(1)],
        };
      },
    },
    {
      async acquire() {
        events.push("acquire");
        return {
          release() {
            events.push("release");
          },
        };
      },
    },
    { now: () => 0, ownerId: "owner" },
  );
  try {
    c.configure({
      id: "s",
      source: "x",
      shopId: "shop-a",
      intervalMs: 3_600_000,
    });
    c.start("s");
    assert.equal((await c.tick()).status, "completed");
    assert.deepEqual(events, ["acquire", "read", "release"]);
  } finally {
    store.close();
  }
});

test("two item-group pages complete while retaining a separate larger SKU observation count", async () => {
  const adapter: CollectionPageAdapter = {
    async readPage(r) {
      return {
        page: r.page,
        totalPages: 2,
        totalCount: 2,
        observedAt: `2026-09-19T00:0${r.page}:00Z`,
        completeScope: r.page === 2,
        countSemantics: "item-groups",
        coverageCount: 1,
        observations: [observation(r.page, 0), observation(r.page, 1)],
      };
    },
  };
  const f = fixture(adapter);
  try {
    assert.equal((await f.collection.tick()).status, "completed");
    assert.equal(f.collection.health().observations, 4);
    const checkpoints: any[] = f.store.db
      .prepare(
        "SELECT coverage_count,count_semantics,observation_count FROM analytics_collection_page_checkpoint ORDER BY page",
      )
      .all();
    assert.deepEqual(
      checkpoints.map((row) => [
        row.coverage_count,
        row.count_semantics,
        row.observation_count,
      ]),
      [
        [1, "item-groups", 2],
        [1, "item-groups", 2],
      ],
    );
  } finally {
    f.store.close();
  }
});

test("duplicate SKU identity across pages pauses without importing the duplicate page", async () => {
  const adapter: CollectionPageAdapter = {
    async readPage(r) {
      return {
        page: r.page,
        totalPages: 2,
        totalCount: 2,
        observedAt: `2026-09-19T00:0${r.page}:00Z`,
        completeScope: r.page === 2,
        countSemantics: "item-groups",
        coverageCount: 1,
        observations: [observation(1)],
      };
    },
  };
  const f = fixture(adapter);
  try {
    const result = await f.collection.tick();
    assert.equal(result.status, "paused");
    assert.equal(result.reason, "unavailable");
    assert.match(
      f.collection.list()[0].pauseReason!,
      /duplicate observation identities across pages/,
    );
    assert.equal(f.store.health().observations, 1);
  } finally {
    f.store.close();
  }
});

test("item-group total changes between pages pause the run", async () => {
  const adapter: CollectionPageAdapter = {
    async readPage(r) {
      return {
        page: r.page,
        totalPages: 2,
        totalCount: r.page === 1 ? 2 : 3,
        observedAt: `2026-09-19T00:0${r.page}:00Z`,
        completeScope: r.page === 2,
        countSemantics: "item-groups",
        coverageCount: 1,
        observations: [observation(r.page)],
      };
    },
  };
  const f = fixture(adapter);
  try {
    const result = await f.collection.tick();
    assert.equal(result.status, "paused");
    assert.match(
      f.collection.list()[0].pauseReason!,
      /collection scope changed during a run/,
    );
    assert.equal(f.store.health().observations, 1);
  } finally {
    f.store.close();
  }
});

test("additive checkpoint migration preserves legacy observation coverage", () => {
  const store = new AnalyticsStore(":memory:");
  store.db.exec(`CREATE TABLE analytics_collection_page_checkpoint(
    run_id TEXT NOT NULL,page INTEGER NOT NULL,import_run_id TEXT NOT NULL,
    observed_at TEXT NOT NULL,observation_count INTEGER NOT NULL,total_pages INTEGER NOT NULL,
    total_count INTEGER NOT NULL,payload_hash TEXT NOT NULL,complete_scope INTEGER NOT NULL,
    completed_at TEXT NOT NULL,PRIMARY KEY(run_id,page));`);
  store.db
    .prepare(
      "INSERT INTO analytics_collection_page_checkpoint VALUES(?,?,?,?,?,?,?,?,?,?)",
    )
    .run(
      "legacy",
      1,
      "import",
      "2026-09-19T00:00:00Z",
      3,
      1,
      3,
      "hash",
      1,
      "2026-09-19T00:00:01Z",
    );
  try {
    new AnalyticsCollection(store, {
      async readPage() {
        throw new Error("unused");
      },
    });
    const row: any = store.db
      .prepare(
        "SELECT coverage_count,count_semantics,identity_keys FROM analytics_collection_page_checkpoint",
      )
      .get();
    assert.equal(row.coverage_count, 3);
    assert.equal(row.count_semantics, "observations");
    assert.equal(row.identity_keys, "[]");
  } finally {
    store.close();
  }
});
