import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequestQueue } from "../src/browser/request-queue.js";
test("serial dispatch stays below three starts in every rolling second", async () => {
  let now = 10000,
    active = 0,
    max = 0;
  const starts: number[] = [];
  const q = createRequestQueue({
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    },
    load: () => null,
    save: () => {},
  });
  await Promise.all(
    Array.from({ length: 12 }, () =>
      q.run(async () => {
        starts.push(now);
        max = Math.max(max, ++active);
        await Promise.resolve();
        active--;
        return 1;
      }),
    ),
  );
  assert.equal(max, 1);
  for (const start of starts)
    assert.ok(starts.filter((x) => x >= start && x < start + 1000).length <= 3);
});
test("reload retains dispatch window and pause blocks queued work", async () => {
  let now = 10000,
    state: any = null,
    calls = 0;
  const env = {
    now: () => now,
    sleep: async (ms: number) => {
      now += ms;
    },
    load: () => state,
    save: (s: any) => {
      state = structuredClone(s);
    },
  };
  await createRequestQueue(env).run(async () => {
    calls++;
  });
  await createRequestQueue(env).run(async () => {
    calls++;
  });
  assert.ok(now >= 10334);
  const q = createRequestQueue(env);
  q.pause("HTTP 403");
  await assert.rejects(
    q.run(async () => {
      calls++;
    }),
    /403/,
  );
  assert.equal(calls, 2);
});
test("named pauses stack and only the verified reason can resume", async () => {
  const q = createRequestQueue({
    now: () => 10000,
    sleep: async () => {},
    load: () => null,
    save: () => {},
  });
  q.pause("HTTP 403", "http-403");
  q.pause("认证跳转", "auth-redirect");
  assert.deepEqual(q.resumeReasons(["http-403"]), ["http-403"]);
  await assert.rejects(
    q.run(async () => {}),
    /认证跳转/,
  );
  assert.deepEqual(q.resumeReasons(["auth-redirect"]), ["auth-redirect"]);
  await q.run(async () => {});
});
test("legacy blocked state remains paused until its legacy reason is explicitly cleared", async () => {
  const q = createRequestQueue({
    now: () => 10000,
    sleep: async () => {},
    load: () => ({ blocked: "旧页面暂停" }),
    save: () => {},
  });
  await assert.rejects(
    q.run(async () => {}),
    /旧页面暂停/,
  );
  assert.equal(q.resume("legacy"), true);
  await q.run(async () => {});
});
test("retry-after cooldown delays following request without retrying failed operation", async () => {
  let now = 10000,
    calls = 0;
  const q = createRequestQueue({
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    },
    load: () => null,
    save: () => {},
  });
  await assert.rejects(
    q.run(async () => {
      calls++;
      q.cooldown(5000);
      throw Error("429");
    }),
  );
  await q.run(async () => {
    calls++;
  });
  assert.equal(calls, 2);
  assert.ok(now >= 15000);
});
test("aborted queued request is not dispatched", async () => {
  const c = new AbortController();
  c.abort();
  let calls = 0;
  const q = createRequestQueue({
    now: () => 10000,
    sleep: async () => {},
    load: () => null,
    save: () => {},
  });
  await assert.rejects(
    q.run(async () => {
      calls++;
    }, c.signal),
  );
  assert.equal(calls, 0);
});
test("a cooldown extended during waiting is checked again before dispatch", async () => {
  let now = 10000,
    extended = false;
  const q = createRequestQueue({
    now: () => now,
    load: () => null,
    save: () => {},
    sleep: async (ms) => {
      now += ms;
      if (!extended) {
        extended = true;
        q.cooldown(5000);
      }
    },
  });
  await q.run(async () => {});
  let at = 0;
  await q.run(async () => {
    at = now;
  });
  assert.equal(at, 15334);
});
