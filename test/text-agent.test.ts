import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.js";
import {
  TextAgentTasks,
  prepare,
  validateTextAgentResult,
  type TextAgentInput,
} from "../src/text-agent.js";

const base = (overrides: Partial<TextAgentInput> = {}): TextAgentInput => ({
  jobId: "job-1",
  shop: "shop-a",
  sku: "SKU-1",
  title: "蓝色收纳盒 30L",
  selectedVariant: "蓝色",
  parameters: { 容量: "30L" },
  packaging: "单个装",
  ...overrides,
});

test("new input makes a queued task stale", () => {
  const store = new Store(":memory:");
  try {
    const tasks = new TextAgentTasks(store);
    const old = tasks.enqueue(base(), {
      taskType: "normalize_title",
      version: "v1",
    });
    tasks.enqueue(base({ title: "蓝色收纳盒 30L 加厚" }), {
      taskType: "normalize_title",
      version: "v1",
    });
    assert.equal(tasks.get(old.id).status, "stale");
    assert.equal(tasks.claim(old.id), null);
  } finally {
    store.close();
  }
});

test("completed output is reused from cache across jobs", async () => {
  const store = new Store(":memory:");
  try {
    const tasks = new TextAgentTasks(store);
    const first = tasks.enqueue(base(), {
      taskType: "normalize_title",
      version: "v1",
    });
    let calls = 0;
    await tasks.runOne(async () => {
      calls++;
      return {
        value: "蓝色收纳盒 30L",
        sources: [{ field: "title", quote: "蓝色收纳盒 30L" }],
      };
    }, first.id);
    const second = tasks.enqueue(base({ jobId: "job-2" }), {
      taskType: "normalize_title",
      version: "v1",
    });
    assert.equal(second.status, "cached");
    assert.equal(second.attempts, 0);
    assert.equal(tasks.result(second.id)?.value, "蓝色收纳盒 30L");
    assert.equal(calls, 1);
  } finally {
    store.close();
  }
});

test("unsupported numeric specifications and non-whitelisted quotes fail", () => {
  const input = prepare(base());
  assert.throws(
    () =>
      validateTextAgentResult(
        {
          value: "蓝色收纳盒 50L",
          sources: [{ field: "title", quote: "蓝色收纳盒" }],
        },
        input,
      ),
    /无来源数字规格.*50/,
  );
  assert.throws(
    () =>
      validateTextAgentResult(
        { value: "蓝色", sources: [{ field: "shop", quote: "shop" }] },
        input,
      ),
    /白名单/,
  );
});

test("explicit startup recovery converts abandoned running work to failure", () => {
  const store = new Store(":memory:");
  try {
    const tasks = new TextAgentTasks(store);
    const queued = tasks.enqueue(base(), {
      taskType: "normalize_title",
      version: "v1",
    });
    assert.equal(tasks.claim(queued.id)?.status, "running");
    const reopenedTasks = new TextAgentTasks(store);
    assert.equal(reopenedTasks.get(queued.id).status, "running");
    assert.equal(reopenedTasks.recoverRunning(), 1);
    const reopened = reopenedTasks.get(queued.id);
    assert.equal(reopened.status, "failed");
    assert.equal(reopened.error, "recovery_required");
    assert.equal(reopened.attempts, 1);
  } finally {
    store.close();
  }
});

test("new input stales a running task and its eventual output is discarded", async () => {
  const store = new Store(":memory:");
  try {
    const tasks = new TextAgentTasks(store);
    const old = tasks.enqueue(base(), {
      taskType: "normalize_title",
      version: "v1",
    });
    let release!: () => void;
    const wait = new Promise<void>((resolve) => (release = resolve));
    const running = tasks.runOne(async () => {
      await wait;
      return {
        value: "蓝色收纳盒 30L",
        sources: [{ field: "title", quote: "蓝色收纳盒 30L" }],
      };
    }, old.id);
    while (tasks.get(old.id).status !== "running") await Promise.resolve();
    tasks.enqueue(base({ title: "蓝色收纳盒 30L 加厚" }), {
      taskType: "normalize_title",
      version: "v1",
    });
    release();
    const stale = await running;
    assert.equal(stale?.status, "stale");
    assert.equal(stale?.result, null);
  } finally {
    store.close();
  }
});

test("runner failure is recorded once and never loops automatically", async () => {
  const store = new Store(":memory:");
  try {
    const tasks = new TextAgentTasks(store);
    const queued = tasks.enqueue(base(), {
      taskType: "normalize_title",
      version: "v1",
    });
    const failed = await tasks.runOne(async () => {
      throw new Error("provider unavailable");
    }, queued.id);
    assert.equal(failed?.status, "failed");
    assert.equal(failed?.attempts, 1);
    assert.match(failed?.error ?? "", /provider unavailable/);
    assert.equal(
      await tasks.runOne(async () => ({ value: "x", sources: [] }), queued.id),
      null,
    );
  } finally {
    store.close();
  }
});

test("explicit retry is durable, idempotent, and preserves failure evidence", async () => {
  const store = new Store(":memory:");
  try {
    const tasks = new TextAgentTasks(store);
    const queued = tasks.enqueue(base(), {
      taskType: "normalize_title",
      version: "v1",
    });
    const failed = await tasks.runOne(async () => {
      throw new Error("temporary provider failure");
    }, queued.id);
    assert.equal(failed?.attempts, 1);

    const retried = tasks.retry(queued.id);
    assert.equal(retried.status, "pending");
    assert.equal(retried.attempts, 1);
    assert.equal(retried.error, null);
    assert.equal(retried.durationMs, null);
    assert.deepEqual(
      JSON.parse(
        String(
          store.db
            .prepare(
              "SELECT detail FROM agent_task_events WHERE task_id=? AND event='retry_requested'",
            )
            .get(queued.id)?.detail,
        ),
      ),
      { previousError: "temporary provider failure", previousAttempts: 1 },
    );

    assert.equal(tasks.retry(queued.id).status, "pending");
    assert.equal(
      Number(
        store.db
          .prepare(
            "SELECT COUNT(*) n FROM agent_task_events WHERE task_id=? AND event='retry_requested'",
          )
          .get(queued.id)?.n,
      ),
      1,
    );
    assert.equal(tasks.claim(queued.id)?.status, "running");
    assert.equal(tasks.retry(queued.id).status, "running");
    assert.equal(tasks.get(queued.id).attempts, 2);
  } finally {
    store.close();
  }
});

test("stale Luna work cannot be revived by retry", () => {
  const store = new Store(":memory:");
  try {
    const tasks = new TextAgentTasks(store);
    const old = tasks.enqueue(base(), {
      taskType: "normalize_title",
      version: "v1",
    });
    tasks.enqueue(base({ title: "已更新标题" }), {
      taskType: "normalize_title",
      version: "v1",
    });
    assert.equal(tasks.get(old.id).status, "stale");
    assert.throws(() => tasks.retry(old.id), /不能重试/);
    assert.equal(tasks.get(old.id).status, "stale");
  } finally {
    store.close();
  }
});
