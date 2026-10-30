import test from "node:test";
import assert from "node:assert/strict";
import { Jobs, type Job } from "../src/jobs.js";
import { PipelineError } from "../src/model.js";
import { Store } from "../src/store.js";
import { Worker } from "../src/worker.js";

const config = {
  shop: "shop",
  session: { spaceId: 1, hzPage: "hz", jdPage: "jd", profileId: "p" },
  listUrl: "",
  newUrl: "",
  editUrl: "",
  maxPages: 1,
};

function enqueueTwo(jobs: Jobs) {
  return jobs.enqueue(["1001", "1002"], {
    brandId: "brand",
    categoryId: "category",
    policyId: "policy",
    unit: "件",
    through: "draft",
  });
}

test("concurrent ticks cannot both pass a delayed release check and claim work", async () => {
  const store = new Store(":memory:");
  try {
    const jobs = new Jobs(store, "shop");
    enqueueTwo(jobs);
    let releaseCheckStarted!: () => void;
    const started = new Promise<void>(
      (resolve) => (releaseCheckStarted = resolve),
    );
    let releaseCheck!: () => void;
    const releaseGate = new Promise<void>(
      (resolve) => (releaseCheck = resolve),
    );
    let releaseChecks = 0;
    const worker = new Worker(
      store,
      jobs,
      config as any,
      "/unused",
      undefined,
      {
        collectAndroid: async () => {
          throw new Error("not used");
        },
        release: {
          releaseId: "test-release",
          root: "/unused",
          assertCurrent: async () => {
            releaseChecks += 1;
            releaseCheckStarted();
            await releaseGate;
          },
        } as any,
      },
    );
    const claimed: Job[] = [];
    worker.run = async (job) => {
      claimed.push(job);
    };

    const first = worker.tick();
    await started;
    assert.equal(worker.busy, true);
    const second = worker.tick();
    releaseCheck();
    await Promise.all([first, second]);

    assert.equal(releaseChecks, 1);
    assert.equal(claimed.length, 1);
    assert.deepEqual(
      jobs
        .list()
        .map((job) => job.status)
        .sort(),
      ["QUEUED", "RUNNING"],
    );
    assert.equal(worker.busy, false);
  } finally {
    store.close();
  }
});

test("tick releases busy and propagates an unexpected release-check failure", async () => {
  const store = new Store(":memory:");
  try {
    const jobs = new Jobs(store, "shop");
    enqueueTwo(jobs);
    const unexpected = new Error("release storage unavailable");
    const worker = new Worker(
      store,
      jobs,
      config as any,
      "/unused",
      undefined,
      {
        collectAndroid: async () => {
          throw new Error("not used");
        },
        release: {
          releaseId: "test-release",
          root: "/unused",
          assertCurrent: async () => {
            throw unexpected;
          },
        } as any,
      },
    );

    await assert.rejects(worker.tick(), unexpected);
    assert.equal(worker.busy, false);
    assert.equal(store.meta("pause:shop"), null);
    assert.ok(jobs.list().every((job) => job.status === "QUEUED"));
  } finally {
    store.close();
  }
});

test("a release change pauses once and still releases busy", async () => {
  const store = new Store(":memory:");
  try {
    const jobs = new Jobs(store, "shop");
    enqueueTwo(jobs);
    const worker = new Worker(
      store,
      jobs,
      config as any,
      "/unused",
      undefined,
      {
        collectAndroid: async () => {
          throw new Error("not used");
        },
        release: {
          releaseId: "test-release",
          root: "/unused",
          assertCurrent: async () => {
            throw new PipelineError("PAUSED", "release changed");
          },
        } as any,
      },
    );

    await worker.tick();
    assert.equal(worker.busy, false);
    assert.deepEqual(store.pauseReasons("shop"), {
      "release:changed": {
        code: "RELEASE_CHANGED",
        message: "PipelineError: release changed",
      },
    });
    assert.ok(jobs.list().every((job) => job.status === "QUEUED"));
  } finally {
    store.close();
  }
});
