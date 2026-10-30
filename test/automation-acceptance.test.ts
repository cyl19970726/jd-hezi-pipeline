import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.js";
import { Jobs } from "../src/jobs.js";
import {
  freezeAcceptance,
  reportAcceptance,
} from "../src/automation-acceptance.js";

const recipe = (categoryId = "category-a") => ({
  source: "browser" as const,
  brandId: "brand",
  categoryId,
  policyId: "policy-v1",
  unit: "件",
  through: "submit" as const,
});

function fixture() {
  const store = new Store(":memory:");
  const jobs = new Jobs(store, "shop");
  const one = jobs.enqueue(["1001"], recipe("category-a")).items[0].id;
  const two = jobs.enqueue(["1002"], recipe("category-b")).items[0].id;
  freezeAcceptance(
    store,
    jobs,
    {
      id: "acceptance-1",
      releaseId: "release-7",
      jobIds: [one, two],
      targetCount: 2,
      minCategories: 2,
    },
    "2026-09-16T00:00:00.000Z",
  );
  return { store, jobs, one, two };
}

function complete(
  store: Store,
  jobs: Jobs,
  jobId: string,
  sku: string,
  options: {
    release?: boolean;
    operationAt?: string;
    receiptHash?: string;
  } = {},
) {
  const productId = `product-${sku}`;
  store.db
    .prepare(
      "INSERT INTO products(id,shop,sku,variant,state,data_hash,remote_id,remote_code,verified_hash,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
    )
    .run(
      productId,
      "shop",
      sku,
      "",
      "SUBMITTED",
      "current-hash",
      `9${sku}`,
      `8${sku}`,
      "current-hash",
      "2026-09-16T00:01:00.000Z",
    );
  jobs.update(jobId, "DONE", "done", null, productId);
  store.db.prepare("UPDATE jobs SET attempt=1 WHERE id=?").run(jobId);
  if (options.release !== false)
    jobs.event(jobId, "release", "release-start", null, {
      releaseId: "release-7",
    });
  jobs.event(jobId, "collect", "completed", 10, null);
  jobs.event(jobId, "collect", "completed", 12, null);
  jobs.event(jobId, "submit", "completed", 7, null);
  const releaseAt = store.db
    .prepare(
      "SELECT at FROM job_events WHERE job_id=? AND stage='release' AND kind='release-start' ORDER BY seq DESC LIMIT 1",
    )
    .get(jobId) as { at: string } | undefined;
  const at = options.operationAt ?? releaseAt?.at ?? new Date().toISOString();
  const hash = options.receiptHash ?? "current-hash";
  store.db
    .prepare("INSERT INTO operations VALUES(?,?,?,?,?,?,?)")
    .run(
      `save-${sku}`,
      productId,
      "save",
      hash,
      "observed",
      JSON.stringify({ itemId: `9${sku}`, shop: "shop", sku }),
      at,
    );
  store.db.prepare("INSERT INTO operations VALUES(?,?,?,?,?,?,?)").run(
    `submit-${sku}`,
    productId,
    "submit",
    hash,
    "observed",
    JSON.stringify({
      itemId: `9${sku}`,
      shop: "shop",
      sku,
      status: "待审核",
    }),
    at,
  );
}

test("freezes a unique, fresh, immutable population and exact category target", () => {
  const store = new Store(":memory:");
  const jobs = new Jobs(store, "shop");
  try {
    const one = jobs.enqueue(["1"], recipe()).items[0].id;
    assert.throws(
      () =>
        freezeAcceptance(store, jobs, {
          id: "bad-count",
          releaseId: "r1",
          jobIds: [one],
          targetCount: 2,
          minCategories: 1,
        }),
      /数量、类目数或任务ID无效/,
    );
    store.db
      .prepare(
        "INSERT INTO products(id,shop,sku,variant,state,data_hash,updated_at) VALUES(?,?,?,?,?,?,?)",
      )
      .run("old", "shop", "1", "", "DISCOVERED", "h", new Date().toISOString());
    assert.throws(
      () =>
        freezeAcceptance(store, jobs, {
          id: "not-fresh",
          releaseId: "r1",
          jobIds: [one],
          targetCount: 1,
          minCategories: 1,
        }),
      /已有商品事实、方案或远端记录/,
    );
  } finally {
    store.close();
  }

  const f = fixture();
  try {
    assert.throws(
      () =>
        f.store.db
          .prepare("UPDATE automation_acceptances SET release_id='other'")
          .run(),
      /immutable/,
    );
    assert.throws(
      () =>
        freezeAcceptance(f.store, f.jobs, {
          id: "acceptance-1",
          releaseId: "release-8",
          jobIds: [f.one, f.two],
          targetCount: 2,
          minCategories: 2,
        }),
      /已冻结/,
    );
  } finally {
    f.store.close();
  }
});

test("passes only the frozen release with current save and submit evidence", () => {
  const { store, jobs, one, two } = fixture();
  try {
    complete(store, jobs, one, "1001");
    complete(store, jobs, two, "1002");
    const report = reportAcceptance(store, "acceptance-1");
    assert.equal(report.status, "passed");
    assert.equal(report.denominator, 2);
    assert.equal(report.passedCount, 2);
    assert.equal(report.categoryCount, 2);
    assert.deepEqual(report.candidates[0].stageDurations, {
      collect: 22,
      submit: 7,
    });
    assert.equal(report.candidates[0].retries, 0);
  } finally {
    store.close();
  }
});

test("fake DONE and an unversioned execution remain incomplete in the denominator", () => {
  const { store, jobs, one, two } = fixture();
  try {
    jobs.update(one, "DONE", "done");
    complete(store, jobs, two, "1002", { release: false });
    const report = reportAcceptance(store, "acceptance-1");
    assert.equal(report.status, "incomplete");
    assert.equal(report.denominator, 2);
    assert.equal(report.passedCount, 0);
    assert.ok(
      report.candidates[0].failures.includes("missing-current-save-receipt"),
    );
    assert.ok(report.candidates[1].failures.includes("missing-release-start"));
  } finally {
    store.close();
  }
});

test("allows repeated claims from the same release but permanently fails mixed releases", () => {
  const { store, jobs, one, two } = fixture();
  try {
    complete(store, jobs, one, "1001");
    jobs.event(one, "release", "release-start", null, {
      releaseId: "release-7",
    });
    complete(store, jobs, two, "1002");
    jobs.event(two, "release", "release-start", null, {
      releaseId: "release-8",
    });

    const report = reportAcceptance(store, "acceptance-1");
    assert.equal(report.status, "failed");
    assert.equal(report.candidates[0].status, "passed");
    assert.equal(report.candidates[1].status, "failed");
    assert.ok(
      report.candidates[1].failures.includes("mismatched-release-start"),
    );
  } finally {
    store.close();
  }
});

test("release evidence must precede stage execution and operation creation", () => {
  const { store, jobs, one } = fixture();
  try {
    jobs.event(one, "collect", "started");
    complete(store, jobs, one, "1001");
    const report = reportAcceptance(store, "acceptance-1");
    assert.equal(report.candidates[0].status, "failed");
    assert.ok(report.candidates[0].failures.includes("late-release-start"));
  } finally {
    store.close();
  }
});

test("manual assistance and late recipe changes permanently fail automatic acceptance", () => {
  const { store, jobs, one, two } = fixture();
  try {
    complete(store, jobs, one, "1001");
    complete(store, jobs, two, "1002");
    jobs.event(one, "manual", "evidence-added", null, {
      actor: "operator",
    });
    store.db
      .prepare("UPDATE jobs SET recipe=? WHERE id=?")
      .run(
        JSON.stringify({ ...recipe("category-b"), policyId: "hotfix" }),
        two,
      );
    const report = reportAcceptance(store, "acceptance-1");
    assert.equal(report.status, "failed");
    assert.equal(report.denominator, 2);
    assert.equal(report.candidates[0].status, "failed");
    assert.ok(report.candidates[0].failures.includes("manual-intervention"));
    assert.ok(report.candidates[1].failures.includes("recipe-version-changed"));
  } finally {
    store.close();
  }
});

test("manual media registry evidence fails without a job event while classifier evidence does not", () => {
  const { store, jobs, one, two } = fixture();
  try {
    complete(store, jobs, one, "1001");
    complete(store, jobs, two, "1002");
    store.db.exec(`
      CREATE TABLE automation_media_evidence(
        evidence_id TEXT PRIMARY KEY,
        shop TEXT NOT NULL,
        product_id TEXT NOT NULL REFERENCES products(id),
        record_id TEXT NOT NULL,
        product_snapshot_hash TEXT NOT NULL,
        origin_json TEXT NOT NULL,
        record_json TEXT NOT NULL,
        registered_at TEXT NOT NULL
      )
    `);
    const insert = store.db.prepare(
      "INSERT INTO automation_media_evidence VALUES(?,?,?,?,?,?,?,?)",
    );
    insert.run(
      "manual-evidence",
      "shop",
      "product-1001",
      "record-1",
      "snapshot-1",
      JSON.stringify({ kind: "manual", operator: "operator-li" }),
      "{}",
      "2026-09-16T00:02:00.000Z",
    );
    insert.run(
      "classifier-evidence",
      "shop",
      "product-1002",
      "record-2",
      "snapshot-2",
      JSON.stringify({
        kind: "classifier",
        provider: "classifier-a",
        providerOutputId: "output-1",
      }),
      "{}",
      "2026-09-16T00:02:00.000Z",
    );

    const report = reportAcceptance(store, "acceptance-1");
    assert.equal(report.status, "failed");
    assert.equal(report.candidates[0].status, "failed");
    assert.ok(report.candidates[0].failures.includes("manual-media-evidence"));
    assert.equal(report.candidates[1].status, "passed");
    assert.ok(!report.candidates[1].failures.includes("manual-media-evidence"));
  } finally {
    store.close();
  }
});

test("stale and wrong-version receipts cannot pass, and pending work stays visible", () => {
  const { store, jobs, one, two } = fixture();
  try {
    complete(store, jobs, one, "1001", {
      operationAt: "2026-09-15T23:59:59.000Z",
    });
    complete(store, jobs, two, "1002", { receiptHash: "old-hash" });
    store.db
      .prepare("INSERT INTO operations VALUES(?,?,?,?,?,?,?)")
      .run(
        "pending",
        "product-1002",
        "submit",
        "current-hash",
        "pending",
        null,
        "2026-09-16T00:02:00.000Z",
      );
    const report = reportAcceptance(store, "acceptance-1");
    assert.equal(report.status, "failed");
    assert.equal(report.passedCount, 0);
    assert.ok(
      report.candidates[0].failures.includes("missing-current-save-receipt"),
    );
    assert.ok(
      report.candidates[1].failures.includes("missing-current-submit-receipt"),
    );
    assert.ok(report.candidates[1].failures.includes("pending-operation"));
  } finally {
    store.close();
  }
});
