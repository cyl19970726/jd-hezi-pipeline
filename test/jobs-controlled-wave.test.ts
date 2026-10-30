import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.js";
import { Jobs } from "../src/jobs.js";

const recipe = {
  brandId: "brand",
  categoryId: "category",
  policyId: "policy",
  unit: "件",
  through: "submit" as const,
};
const source = { runId: "run", brandId: "brand", waveKey: "wave" };

function fixture() {
  const store = new Store(":memory:");
  const wave = {
    status: "planned",
    candidates: ["1", "2"].map((sku) => ({
      sku,
      brandId: "brand",
      suggestedCategoryId: "category",
      evidence: { runId: "run" },
    })),
    groups: [],
  };
  store.setMeta("wave", wave);
  return { store, jobs: new Jobs(store, "shop") };
}

test("controlled enqueue atomically persists its group and source identity", () => {
  const { store, jobs } = fixture();
  try {
    const result = jobs.enqueue(["1", "2"], recipe, source);
    const wave = store.meta("wave");
    assert.equal(wave.status, "in-progress");
    assert.equal(wave.groups.length, 1);
    assert.equal(wave.groups[0].batch, result.batch);
    assert.deepEqual(wave.groups[0].items, result.items);
    assert.ok(Date.parse(wave.groups[0].startedAt));
    for (const item of result.items) {
      const event = jobs
        .events(item.id)
        .find((row) => row.kind === "source-assigned");
      assert.deepEqual(JSON.parse(event.detail), {
        ...source,
        sku: item.sku,
      });
    }
  } finally {
    store.close();
  }
});

test("controlled enqueue rejects missing candidates and identity mismatches", () => {
  const cases = [
    { input: ["3"], source, recipe, message: /不属于/ },
    {
      input: ["1"],
      source: { ...source, brandId: "other" },
      recipe,
      message: /品牌、来源或类目/,
    },
    {
      input: ["1"],
      source: { ...source, runId: "other" },
      recipe,
      message: /品牌、来源或类目/,
    },
    {
      input: ["1"],
      source,
      recipe: { ...recipe, categoryId: "other" },
      message: /品牌、来源或类目/,
    },
    {
      input: ["1"],
      source: { ...source, waveKey: "missing" },
      recipe,
      message: /计划不存在/,
    },
  ];
  for (const value of cases) {
    const { store, jobs } = fixture();
    try {
      assert.throws(
        () => jobs.enqueue(value.input, value.recipe, value.source),
        value.message,
      );
      assert.equal(jobs.list().length, 0);
      assert.equal(
        store.db.prepare("SELECT count(*) n FROM batches").get().n,
        0,
      );
    } finally {
      store.close();
    }
  }
});

test("wave metadata failure rolls back jobs, batch links and events", () => {
  const { store, jobs } = fixture();
  try {
    store.db.exec(`CREATE TRIGGER fail_wave BEFORE UPDATE ON meta
      WHEN NEW.key='wave' BEGIN SELECT RAISE(ABORT,'meta failed'); END`);
    assert.throws(() => jobs.enqueue(["1"], recipe, source), /meta failed/);
    for (const table of ["jobs", "batches", "batch_jobs", "job_events"])
      assert.equal(
        store.db.prepare(`SELECT count(*) n FROM ${table}`).get().n,
        0,
      );
    assert.equal(store.meta("wave").status, "planned");
  } finally {
    store.close();
  }
});

test("legacy enqueue remains independent of controlled wave metadata", () => {
  const store = new Store(":memory:");
  try {
    const jobs = new Jobs(store, "shop");
    const result = jobs.enqueue(["1"], recipe, {
      runId: "run",
      brandId: "brand",
    });
    assert.equal(result.items.length, 1);
    assert.equal(store.meta("wave"), null);
  } finally {
    store.close();
  }
});
