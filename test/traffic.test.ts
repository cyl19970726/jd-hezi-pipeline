import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.js";
import { configureHzAccessPolicy, Traffic } from "../src/traffic.js";
import { auditKnown } from "../src/reconcile.js";
import { example } from "../src/demo.js";
import { PipelineError } from "../src/model.js";
test("traffic spaces operations and retains hourly budget across instances", async () => {
  const s = new Store(":memory:");
  let now = 100000;
  const starts: number[] = [];
  const clock = {
    now: () => now,
    sleep: async (ms: number) => {
      now += ms;
    },
  };
  try {
    for (let i = 0; i < 2; i++)
      await new Traffic(s, "shop", clock, {
        intervalMs: 5000,
        hourlyLimit: 2,
      }).run("read", async () => {
        starts.push(now);
      });
    assert.deepEqual(starts, [100000, 105000]);
    await assert.rejects(
      new Traffic(s, "shop", clock, { intervalMs: 5000, hourlyLimit: 2 }).run(
        "read",
        async () => {
          starts.push(now);
        },
      ),
      /预算/,
    );
    assert.equal(starts.length, 2);
  } finally {
    s.close();
  }
});
test("traffic budgets are shared per shop and platform without cross-shop leakage", async () => {
  const s = new Store(":memory:");
  let now = 100000;
  const starts: Array<[string, number]> = [];
  const clock = {
    now: () => now,
    sleep: async (ms: number) => {
      now += ms;
    },
  };
  try {
    await new Traffic(s, "shop-a", clock, {
      intervalMs: 5000,
      hourlyLimit: 1,
    }).run("read", async () => starts.push(["a", now]));
    await new Traffic(s, "shop-b", clock, {
      intervalMs: 5000,
      hourlyLimit: 1,
    }).run("read", async () => starts.push(["b", now]));
    assert.deepEqual(starts, [
      ["a", 100000],
      ["b", 100000],
    ]);
    assert.deepEqual(
      s.db
        .prepare(
          "SELECT shop,kind,started_at,finished_at,outcome FROM traffic_log ORDER BY id",
        )
        .all()
        .map((row) => ({ ...row })),
      [
        {
          shop: "shop-a",
          kind: "read",
          started_at: 100000,
          finished_at: 100000,
          outcome: "ok",
        },
        {
          shop: "shop-b",
          kind: "read",
          started_at: 100000,
          finished_at: 100000,
          outcome: "ok",
        },
      ],
    );
  } finally {
    s.close();
  }
});
test("default HZ policy is nonzero, persistent and applied by new instances", async () => {
  const s = new Store(":memory:");
  let now = 100000;
  const starts: number[] = [];
  const clock = {
    now: () => now,
    sleep: async (ms: number) => {
      now += ms;
    },
  };
  try {
    await new Traffic(s, "shop", clock).run("read", async () =>
      starts.push(now),
    );
    await new Traffic(s, "shop", clock).run("read", async () =>
      starts.push(now),
    );
    configureHzAccessPolicy(s, "shop", {
      intervalMs: 2500,
      hourlyLimit: 10,
    });
    await new Traffic(s, "shop", clock).run("read", async () =>
      starts.push(now),
    );
    assert.deepEqual(starts, [100000, 101000, 103500]);
  } finally {
    s.close();
  }
});
test("risk response pauses subsequent traffic; no automatic retry", async () => {
  const s = new Store(":memory:");
  let calls = 0;
  try {
    const t = new Traffic(s, "shop");
    await assert.rejects(
      t.run("read", async () => {
        calls++;
        throw Object.assign(Error("blocked"), { response: { status: 403 } });
      }),
    );
    await assert.rejects(
      t.run("read", async () => {
        calls++;
      }),
    );
    assert.equal(calls, 1);
  } finally {
    s.close();
  }
});
test("429 persists Retry-After evidence and never auto-replays the operation", async () => {
  const s = new Store(":memory:");
  let calls = 0;
  try {
    await assert.rejects(
      new Traffic(s, "shop", { now: () => 1000, sleep: async () => {} }).run(
        "save",
        async () => {
          calls++;
          throw {
            response: {
              status: 429,
              headers: { get: () => "12" },
            },
          };
        },
      ),
    );
    assert.equal(calls, 1);
    assert.deepEqual(s.pauseReasons("hz:shop")["traffic:risk"], {
      code: "RISK_CONTROL",
      message: "流量控制检测拦截，停止后续访问",
      status: 429,
      retryAfter: "12",
      retryNotBefore: 13000,
    });
    s.resumeReason("hz:shop", "traffic:risk");
    await assert.rejects(
      new Traffic(s, "shop", { now: () => 2000, sleep: async () => {} }).run(
        "save",
        async () => calls++,
      ),
      (error: any) =>
        error.code === "RATE_LIMITED" && error.details.remainingMs === 11000,
    );
    assert.equal(calls, 1);
  } finally {
    s.close();
  }
});
test("plain unknown write pauses separately without being mislabeled as risk control", async () => {
  const s = new Store(":memory:"),
    { product, plan } = example();
  let calls = 0;
  try {
    const row = s.put(plan.shop, product);
    s.setPlan(row.id, plan);
    const operationId = s.intent(row.id, "save");
    await assert.rejects(
      new Traffic(s, plan.shop).run("save", async () => {
        calls++;
        throw new PipelineError(
          "UNKNOWN_OUTCOME",
          "保存业务拒绝 4-1101，结果待对账",
        );
      }),
      (error: unknown) =>
        error instanceof PipelineError && error.code === "UNKNOWN_OUTCOME",
    );
    assert.deepEqual(
      s.pauseReasons("hz:" + plan.shop)["traffic:unknown-outcome"],
      {
        code: "UNKNOWN_OUTCOME",
        message: "写入结果不明，停止后续赫兹写入；必须先对账",
        kind: "save",
        status: null,
      },
    );
    assert.equal(s.pauseReasons("hz:" + plan.shop)["traffic:risk"], undefined);
    assert.equal(s.pending(row.id)?.id, operationId);
    await assert.rejects(
      new Traffic(s, plan.shop).run("save", async () => {
        calls++;
      }),
    );
    assert.equal(calls, 1);
    assert.equal(s.pending(row.id)?.id, operationId);
  } finally {
    s.close();
  }
});

test("unknown outcome with explicit WAF evidence remains risk control", async () => {
  const s = new Store(":memory:");
  try {
    await assert.rejects(
      new Traffic(s, "shop").run("save", async () => {
        throw new PipelineError(
          "UNKNOWN_OUTCOME",
          "HTTP 403 WAF blocked after dispatch",
        );
      }),
    );
    assert.equal(
      s.pauseReasons("hz:shop")["traffic:risk"].code,
      "RISK_CONTROL",
    );
    assert.equal(
      s.pauseReasons("hz:shop")["traffic:unknown-outcome"],
      undefined,
    );
  } finally {
    s.close();
  }
});
test("paused audit makes zero adapter calls", async () => {
  const s = new Store(":memory:");
  s.pause("shop", "risk");
  let calls = 0;
  try {
    await assert.rejects(
      auditKnown(
        s,
        {
          checkShop: async () => {
            calls++;
          },
        } as any,
        "shop",
      ),
    );
    assert.equal(calls, 0);
  } finally {
    s.close();
  }
});

test("batch cannot hide multiple detail requests behind one budget reservation", async () => {
  const { sourceLinksBatch } = await import("../src/browser/source-scan.js");
  await assert.rejects(
    sourceLinksBatch({
      items: [
        { itemId: "1", draft: false },
        { itemId: "2", draft: false },
      ],
      reader: "async()=>({})",
    }),
    /禁用/,
  );
});
test("pause during spacing prevents the next operation", async () => {
  const s = new Store(":memory:");
  let now = 100000,
    calls = 0;
  try {
    const t = new Traffic(
      s,
      "shop",
      {
        now: () => now,
        sleep: async (ms) => {
          now += ms;
          s.pause("shop", "stop");
        },
      },
      { intervalMs: 5000, hourlyLimit: null },
    );
    await t.run("read", async () => {
      calls++;
    });
    await assert.rejects(
      t.run("read", async () => {
        calls++;
      }),
    );
    assert.equal(calls, 1);
  } finally {
    s.close();
  }
});
