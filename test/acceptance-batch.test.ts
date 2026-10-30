import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.js";
import { Jobs } from "../src/jobs.js";
import { activeAcceptanceBatchProgress } from "../src/acceptance-batch.js";

const recipe = {
  source: "browser" as const,
  brandId: "brand",
  categoryId: "category",
  policyId: "policy",
  unit: "件",
  through: "submit" as const,
};

function setup() {
  const store = new Store(":memory:");
  const jobs = new Jobs(store, "shop");
  const ids = ["101", "102", "103"].map(
    (sku) => jobs.enqueue([sku], recipe).items[0].id,
  );
  store.setMeta("active-acceptance-batch:shop", {
    key: "first-real-batch",
    target: 3,
    startedAt: "2026-09-16T10:00:00.000Z",
    candidates: [
      { sku: "101", jobId: ids[0] },
      { sku: "102", jobId: ids[1] },
      { sku: "103", jobId: ids[2] },
    ],
  });
  return { store, jobs, ids };
}

function remote(
  store: Store,
  jobs: Jobs,
  jobId: string,
  sku: string,
  options: {
    state?: "SUBMITTED" | "APPROVED" | "ON_SALE";
    verified?: boolean;
    receiptAt?: string;
  } = {},
) {
  const productId = `p-${sku}`;
  store.db
    .prepare(
      `INSERT INTO products
       (id,shop,sku,variant,state,data_hash,remote_id,verified_hash,updated_at)
       VALUES(?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      productId,
      "shop",
      sku,
      "",
      options.state ?? "SUBMITTED",
      "hash",
      `9${sku}`,
      options.verified === false ? "old-hash" : "hash",
      "2026-09-16T10:02:00.000Z",
    );
  jobs.update(jobId, "DONE", "done", null, productId);
  store.db
    .prepare("INSERT INTO operations VALUES(?,?,?,?,?,?,?)")
    .run(
      `save-${sku}`,
      productId,
      "save",
      "hash",
      "observed",
      JSON.stringify({ itemId: `9${sku}` }),
      options.receiptAt ?? "2026-09-16T10:01:00.000Z",
    );
}

test("counts only distinct frozen SKUs and verified new remote results", () => {
  const { store, jobs, ids } = setup();
  try {
    remote(store, jobs, ids[0], "101");
    remote(store, jobs, ids[1], "102", { state: "APPROVED" });
    remote(store, jobs, ids[2], "103", { state: "ON_SALE" });
    const meta = store.meta("active-acceptance-batch:shop");
    meta.candidates.push({ sku: "101", jobId: ids[0] });
    store.setMeta("active-acceptance-batch:shop", meta);

    const progress = activeAcceptanceBatchProgress(store, "shop")!;
    assert.equal(progress.status, "complete");
    assert.equal(progress.candidateCount, 3);
    assert.equal(progress.duplicateCount, 1);
    assert.equal(progress.completedCount, 3);
    assert.equal(progress.currentGroup.items.length, 3);
    assert.deepEqual(progress.counts, {
      running: 0,
      queued: 0,
      needsInput: 0,
      unknown: 0,
      submitted: 1,
      approved: 1,
      onSale: 1,
    });
  } finally {
    store.close();
  }
});

test("historical remote saves and unverified rows do not count", () => {
  const { store, jobs, ids } = setup();
  try {
    remote(store, jobs, ids[0], "101", {
      receiptAt: "2026-09-16T09:59:59.000Z",
    });
    remote(store, jobs, ids[1], "102", { verified: false });
    const progress = activeAcceptanceBatchProgress(store, "shop")!;
    assert.equal(progress.completedCount, 0);
    assert.equal(progress.remainingCount, 3);
    assert.equal(progress.status, "in-progress");
    assert.equal(progress.currentGroup.items[0].complete, false);
    assert.equal(progress.currentGroup.items[1].complete, false);
  } finally {
    store.close();
  }
});

test("cross-shop and mismatched job identities are excluded; active beats holds", () => {
  const { store, jobs, ids } = setup();
  try {
    jobs.update(ids[0], "NEEDS_INPUT", "collect", "hold");
    const foreignId = new Jobs(store, "other").enqueue(["104"], recipe).items[0]
      .id;
    const meta = store.meta("active-acceptance-batch:shop");
    meta.candidates[1].sku = "999";
    meta.candidates.push({ sku: "777", jobId: ids[2] });
    meta.candidates.push({ sku: "104", jobId: foreignId });
    store.setMeta("active-acceptance-batch:shop", meta);
    const progress = activeAcceptanceBatchProgress(store, "shop")!;
    assert.equal(progress.status, "in-progress");
    assert.equal(progress.startedCount, 2);
    assert.equal(progress.excludedCount, 3);
    assert.equal(progress.counts.needsInput, 1);
    assert.equal(progress.counts.queued, 1);

    jobs.update(ids[2], "NEEDS_INPUT", "collect", "another hold");
    assert.equal(
      activeAcceptanceBatchProgress(store, "shop")!.status,
      "needs-input",
    );
  } finally {
    store.close();
  }
});
