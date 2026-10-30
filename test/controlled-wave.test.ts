import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.js";
import { Jobs } from "../src/jobs.js";
import { controlledWaveProgress } from "../src/controlled-wave.js";

const recipe = {
  source: "browser" as const,
  brandId: "brand",
  categoryId: "category",
  policyId: "policy",
  unit: "件",
  through: "submit" as const,
};

function fixture() {
  const store = new Store(":memory:");
  const jobs = new Jobs(store, "shop");
  const plan = {
    status: "in-progress",
    targetCount: 3,
    completed: ["不应信任"],
    candidates: ["1", "2", "3"].map((sku) => ({
      sku,
      brandId: "brand",
      evidence: { runId: "run" },
    })),
    groups: [] as any[],
  };
  store.setMeta("controlled-wave:2026-09-11-expanded", plan);
  return { store, jobs, plan };
}

function assign(
  store: Store,
  jobs: Jobs,
  plan: any,
  sku: string,
  options: { source?: boolean; recipeOverride?: any } = {},
) {
  const result = jobs.enqueue([sku], options.recipeOverride ?? recipe, {
    runId: "run",
    brandId: "brand",
  });
  if (options.source === false)
    store.db
      .prepare(
        "DELETE FROM job_events WHERE job_id=? AND kind='source-assigned'",
      )
      .run(result.items[0].id);
  plan.groups.push({
    batch: result.batch,
    startedAt: "2026-09-11T00:00:00.000Z",
    items: [{ id: result.items[0].id, sku }],
  });
  store.setMeta("controlled-wave:2026-09-11-expanded", plan);
  return result.items[0].id;
}

test("projects only strictly linked wave jobs and ignores meta completion", () => {
  const { store, jobs, plan } = fixture();
  try {
    const valid = assign(store, jobs, plan, "1");
    assign(store, jobs, plan, "2", { source: false });
    const wrongBrand = jobs.enqueue(["3"], { ...recipe, brandId: "other" });
    plan.groups.push({
      batch: wrongBrand.batch,
      items: [{ id: wrongBrand.items[0].id, sku: "3" }],
    });
    store.setMeta("controlled-wave:2026-09-11-expanded", plan);

    const result = controlledWaveProgress(store, "shop")!;
    assert.equal(result.startedCount, 1);
    assert.equal(result.completedCount, 0);
    assert.equal(result.remainingCount, 3);
    assert.equal(result.currentGroup?.items[0].id, valid);
    assert.equal(result.status, "in-progress");
  } finally {
    store.close();
  }
});

test("completion requires verified remote state and no pending operation", () => {
  const { store, jobs, plan } = fixture();
  try {
    const ids = ["1", "2", "3"].map((sku) => assign(store, jobs, plan, sku));
    for (let i = 0; i < ids.length; i++) {
      const productId = `p${i}`;
      store.db
        .prepare(
          "INSERT INTO products(id,shop,sku,variant,state,data_hash,remote_id,verified_hash,updated_at) VALUES(?,?,?,?,?,?,?,?,?)",
        )
        .run(
          productId,
          "shop",
          String(i + 1),
          "default",
          ["SUBMITTED", "APPROVED", "ON_SALE"][i],
          "hash",
          String(100 + i),
          "hash",
          new Date().toISOString(),
        );
      jobs.update(ids[i], "DONE", "done", null, productId);
    }
    store.db
      .prepare("INSERT INTO operations VALUES(?,?,?,?,?,?,?)")
      .run(
        "op",
        "p2",
        "submit",
        "hash",
        "pending",
        null,
        new Date().toISOString(),
      );

    let result = controlledWaveProgress(store, "shop")!;
    assert.deepEqual(result.counts, {
      running: 0,
      queued: 0,
      needsInput: 0,
      unknown: 0,
      submitted: 1,
      approved: 1,
      onSale: 0,
    });
    assert.equal(result.completedCount, 2);
    assert.equal(result.remainingCount, 1);

    store.db
      .prepare("UPDATE operations SET status='observed' WHERE id='op'")
      .run();
    result = controlledWaveProgress(store, "shop")!;
    assert.equal(result.completedCount, 3);
    assert.equal(result.counts.onSale, 1);
    assert.equal(result.status, "complete");
  } finally {
    store.close();
  }
});

test("a job bound to another SKU cannot inherit its verified remote completion", () => {
  const { store, jobs, plan } = fixture();
  try {
    const id = assign(store, jobs, plan, "1");
    store.db
      .prepare(
        "INSERT INTO products(id,shop,sku,variant,state,data_hash,remote_id,verified_hash,updated_at) VALUES(?,?,?,?,?,?,?,?,?)",
      )
      .run(
        "foreign-product",
        "shop",
        "different-sku",
        "default",
        "SUBMITTED",
        "hash",
        "100",
        "hash",
        new Date().toISOString(),
      );
    jobs.update(id, "DONE", "done", null, "foreign-product");

    const result = controlledWaveProgress(store, "shop")!;
    assert.equal(result.startedCount, 1);
    assert.equal(result.completedCount, 0);
    assert.equal(result.counts.submitted, 0);
  } finally {
    store.close();
  }
});

test("a malformed job recipe excludes only that item", () => {
  const { store, jobs, plan } = fixture();
  try {
    const broken = assign(store, jobs, plan, "1");
    const valid = assign(store, jobs, plan, "2");
    store.db.prepare("UPDATE jobs SET recipe='{' WHERE id=?").run(broken);

    const result = controlledWaveProgress(store, "shop")!;
    assert.equal(result.startedCount, 1);
    assert.equal(result.currentGroup?.items[0].id, valid);
  } finally {
    store.close();
  }
});

test("reports blockers and distinct active counts", () => {
  const { store, jobs, plan } = fixture();
  try {
    const one = assign(store, jobs, plan, "1");
    const two = assign(store, jobs, plan, "2");
    assign(store, jobs, plan, "3");
    jobs.update(one, "RUNNING", "collect");
    jobs.update(two, "NEEDS_INPUT", "assets", "缺商品毛重");
    const result = controlledWaveProgress(store, "shop")!;
    assert.equal(result.counts.running, 1);
    assert.equal(result.counts.queued, 1);
    assert.equal(result.counts.needsInput, 1);
    assert.deepEqual(result.blockedReasons, ["缺商品毛重"]);
    assert.equal(result.status, "needs-input");
  } finally {
    store.close();
  }
});

const baseline = (matches: unknown[] = []) => ({
  scanId: 7,
  startedAt: "2026-09-11T10:00:00.000Z",
  finishedAt: "2026-09-11T11:00:00.000Z",
  checkedAt: "2026-09-11T12:00:00.000Z",
  status: "complete",
  matches,
});
const candidate = (sku: string, matches: unknown[] = []) => ({
  sku,
  brandId: "brand",
  evidence: { runId: "run" },
  sourceIndexBaseline: baseline(matches),
});

test("explicit new target stays fixed as eligible candidates are supplemented", () => {
  const store = new Store(":memory:");
  try {
    const initial = [
      ...Array.from({ length: 12 }, (_, i) => candidate(`new-${i}`)),
      ...Array.from({ length: 8 }, (_, i) =>
        candidate(`existing-${i}`, [{ itemId: String(i) }]),
      ),
      candidate("duplicate", [{ itemId: "a" }, { itemId: "b" }]),
    ];
    const plan = { targetNewCount: 20, candidates: initial, groups: [] };
    store.setMeta("controlled-wave:2026-09-11-expanded", plan);
    let result = controlledWaveProgress(
      store,
      "shop",
      undefined,
      Date.parse("2026-09-11T12:30:00.000Z"),
    )!;
    assert.equal(result.targetCount, 20);
    assert.equal(result.candidateCount, 21);
    assert.equal(result.plannedCount, 12);
    assert.equal(result.existingCount, 8);
    assert.equal(result.duplicateCount, 1);
    assert.equal(result.gapCount, 8);

    plan.candidates.push(
      ...Array.from({ length: 8 }, (_, i) => candidate(`extra-${i}`)),
    );
    store.setMeta("controlled-wave:2026-09-11-expanded", plan);
    result = controlledWaveProgress(
      store,
      "shop",
      undefined,
      Date.parse("2026-09-11T12:30:00.000Z"),
    )!;
    assert.equal(result.targetCount, 20);
    assert.equal(result.candidateCount, 29);
    assert.equal(result.plannedCount, 20);
    assert.equal(result.gapCount, 0);
  } finally {
    store.close();
  }
});

test("new completion requires an observed save receipt after baseline and group", () => {
  const store = new Store(":memory:"),
    jobs = new Jobs(store, "shop");
  try {
    const plan: any = {
      targetNewCount: 1,
      candidates: [candidate("1")],
      groups: [],
    };
    const batch = jobs.enqueue(["1"], recipe, {
      runId: "run",
      brandId: "brand",
    });
    plan.groups.push({
      batch: batch.batch,
      startedAt: "2026-09-11T11:59:00.000Z",
      items: [{ id: batch.items[0].id, sku: "1" }],
    });
    store.setMeta("controlled-wave:2026-09-11-expanded", plan);
    store.db
      .prepare(
        "INSERT INTO products(id,shop,sku,variant,state,data_hash,remote_id,verified_hash,updated_at) VALUES(?,?,?,?,?,?,?,?,?)",
      )
      .run(
        "product",
        "shop",
        "1",
        "default",
        "SUBMITTED",
        "hash",
        "100",
        "hash",
        "2026-09-11T12:02:00.000Z",
      );
    jobs.update(batch.items[0].id, "DONE", "done", null, "product");
    const read = () =>
      controlledWaveProgress(
        store,
        "shop",
        undefined,
        Date.parse("2026-09-11T12:30:00.000Z"),
      )!;
    assert.equal(read().completedCount, 0);
    store.db
      .prepare("INSERT INTO operations VALUES(?,?,?,?,?,?,?)")
      .run(
        "old",
        "product",
        "save",
        "hash",
        "observed",
        JSON.stringify({ itemId: "100" }),
        "2026-09-11T11:59:30.000Z",
      );
    assert.equal(read().completedCount, 0);
    store.db
      .prepare("INSERT INTO operations VALUES(?,?,?,?,?,?,?)")
      .run(
        "wrong",
        "product",
        "save",
        "hash",
        "observed",
        JSON.stringify({ itemId: "999" }),
        "2026-09-11T12:01:00.000Z",
      );
    assert.equal(read().completedCount, 0);
    store.db
      .prepare("INSERT INTO operations VALUES(?,?,?,?,?,?,?)")
      .run(
        "created",
        "product",
        "save",
        "hash",
        "observed",
        JSON.stringify({ itemId: "100" }),
        "2026-09-11T12:01:00.000Z",
      );
    assert.equal(read().completedCount, 1);
  } finally {
    store.close();
  }
});

test("new mode excludes incomplete, stale and future baselines", () => {
  const store = new Store(":memory:");
  try {
    const candidates: any[] = [
      candidate("valid"),
      {
        ...candidate("partial"),
        sourceIndexBaseline: { ...baseline(), status: "partial" },
      },
      {
        ...candidate("stale"),
        sourceIndexBaseline: {
          ...baseline(),
          finishedAt: "2026-09-09T00:00:00.000Z",
        },
      },
      {
        ...candidate("future"),
        sourceIndexBaseline: {
          ...baseline(),
          checkedAt: "2026-09-12T00:00:00.000Z",
        },
      },
    ];
    store.setMeta("controlled-wave:2026-09-11-expanded", {
      targetNewCount: 1,
      candidates,
      groups: [],
    });
    const result = controlledWaveProgress(
      store,
      "shop",
      undefined,
      Date.parse("2026-09-11T12:30:00.000Z"),
    )!;
    assert.equal(result.plannedCount, 1);
    assert.equal(result.excludedCount, 3);
  } finally {
    store.close();
  }
});
