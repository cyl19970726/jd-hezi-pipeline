import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.js";
import { JdTraffic } from "../src/jd-traffic.js";
import { Jobs } from "../src/jobs.js";
import { Worker } from "../src/worker.js";
test("JD pause leaves queued job checkpoints and attempt counts untouched", async () => {
  const s = new Store(":memory:");
  try {
    const jobs = new Jobs(s, "ours");
    const batch = jobs.enqueue(["123"], {
      brandId: "b",
      categoryId: "c",
      policyId: "p",
      unit: "件",
      through: "submit",
    });
    s.pause("jd:ours", "verification");
    const w = new Worker(
      s,
      jobs,
      {
        shop: "ours",
        session: { spaceId: 3, hzPage: "p3", jdPage: "p7", profileId: "4" },
        listUrl: "",
        newUrl: "",
        editUrl: "",
        maxPages: 1,
      },
      "/tmp/unused",
    );
    await w.tick();
    const j = jobs.get(batch.items[0].id);
    assert.equal(j.status, "QUEUED");
    assert.equal(j.attempt, 0);
    assert.equal(jobs.events(j.id).length, 0);
  } finally {
    s.close();
  }
});
test("a durable JD-only pause prevents dispatch without blocking independent Hezi work", async () => {
  const s = new Store(":memory:");
  try {
    s.pause("jd:ours", { message: "京东验证" });
    assert.doesNotThrow(() => s.assertRunning("ours"));
    let calls = 0;
    await assert.rejects(
      new JdTraffic(s, "ours").navigate(
        "https://item.jd.com/123.html",
        async () => {
          calls++;
        },
      ),
    );
    assert.equal(calls, 0);
    s.resume("jd:ours");
    await new JdTraffic(s, "ours").navigate(
      "https://item.jd.com/123.html",
      async () => {
        calls++;
      },
    );
    assert.equal(calls, 1);
    s.pause("all", "operator pause");
    assert.throws(() => s.assertRunning("ours"));
  } finally {
    s.close();
  }
});
test("JD navigation spacing persists across instances and risk slows future work without retry", async () => {
  const s = new Store(":memory:");
  let now = 100000,
    calls = 0;
  const clock = {
    now: () => now,
    sleep: async (ms: number) => {
      now += ms;
    },
  };
  try {
    const a = new JdTraffic(s, "ours", clock);
    await a.navigate("https://item.jd.com/123.html", async () => {
      calls++;
    });
    const b = new JdTraffic(s, "ours", clock);
    await b.navigate("https://item.jd.com/456.html", async () => {
      calls++;
    });
    assert.equal(now, 115000);
    b.risk("验证");
    assert.equal(calls, 2);
    assert.ok(s.meta("pause:jd-account:ours"));
    s.resume("jd-account:ours");
    await b.navigate("https://item.jd.com/789.html", async () => {
      calls++;
    });
    assert.equal(now, 145000);
    assert.equal(b.state().navigations, 3);
    assert.deepEqual(
      s.db
        .prepare(
          "SELECT shop,kind,started_at,outcome FROM traffic_log ORDER BY id",
        )
        .all()
        .map((row) => ({ ...row })),
      [
        {
          shop: "ours",
          kind: "jd:navigation",
          started_at: 100000,
          outcome: "ok",
        },
        {
          shop: "ours",
          kind: "jd:navigation",
          started_at: 115000,
          outcome: "ok",
        },
        {
          shop: "ours",
          kind: "jd:navigation",
          started_at: 145000,
          outcome: "ok",
        },
      ],
    );
  } finally {
    s.close();
  }
});
test("JD budget and adaptive risk state are isolated by shop", async () => {
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
    const a = new JdTraffic(s, "shop-a", clock);
    const b = new JdTraffic(s, "shop-b", clock);
    await a.navigate("https://item.jd.com/1.html", async () =>
      starts.push(["a", now]),
    );
    a.risk("验证");
    assert.equal(a.state().intervalMs, 30000);
    assert.equal(b.state().intervalMs, 15000);
    await b.navigate("https://item.jd.com/2.html", async () =>
      starts.push(["b", now]),
    );
    assert.deepEqual(starts, [
      ["a", 100000],
      ["b", 100000],
    ]);
  } finally {
    s.close();
  }
});
test("JD risk stores server cooldown evidence across instances", () => {
  const s = new Store(":memory:");
  try {
    const traffic = new JdTraffic(s, "ours", {
      now: () => 1000,
      sleep: async () => {},
    });
    traffic.risk("HTTP 429", "7");
    assert.deepEqual(traffic.state().lastRisk, {
      at: new Date(1000).toISOString(),
      message: "HTTP 429",
      retryAfter: "7",
      retryNotBefore: 8000,
    });
    s.resume("jd-account:ours");
    assert.throws(
      () => traffic.assertRunning(),
      (error: any) =>
        error.code === "RATE_LIMITED" && error.details.remainingMs === 7000,
    );
  } finally {
    s.close();
  }
});
test("pause during JD spacing cancels navigation before any network action", async () => {
  const s = new Store(":memory:");
  let calls = 0;
  try {
    const a = new JdTraffic(s, "ours", {
      now: () => 100000,
      sleep: async () => {
        s.pause("ours", { message: "暂停" });
      },
    });
    await a.navigate("https://item.jd.com/123.html", async () => {
      calls++;
    });
    await assert.rejects(
      a.navigate("https://item.jd.com/456.html", async () => {
        calls++;
      }),
    );
    assert.equal(calls, 1);
  } finally {
    s.close();
  }
});

test("a risk update during spacing extends the wait before dispatch", async () => {
  const s = new Store(":memory:");
  let now = 100000,
    waits = 0;
  let gate: JdTraffic;
  try {
    gate = new JdTraffic(s, "ours", {
      now: () => now,
      sleep: async (ms) => {
        now += ms;
        if (++waits === 1) {
          gate.risk("另一入口已报告验证");
          s.resume("jd-account:ours");
        }
      },
    });
    await gate.navigate("https://item.jd.com/123.html", async () => {});
    await gate.navigate("https://item.jd.com/456.html", async () => {});
    assert.equal(now, 130000);
    assert.equal(waits, 2);
  } finally {
    s.close();
  }
});

test("risk on either JD channel pauses the shared account before cross-channel work", async () => {
  const s = new Store(":memory:");
  try {
    new JdTraffic(s, "ours", undefined, "android").risk("手机验证");
    let browserCalls = 0;
    await assert.rejects(
      new JdTraffic(s, "ours", undefined, "browser").navigate(
        "https://item.jd.com/123.html",
        async () => browserCalls++,
      ),
      /队列已暂停/,
    );
    assert.equal(browserCalls, 0);
  } finally {
    s.close();
  }
});

test("shared account pauses accumulate and each channel clears only its own verified cause", () => {
  const s = new Store(":memory:");
  try {
    const browser = new JdTraffic(s, "ours"),
      android = new JdTraffic(s, "ours", undefined, "android");
    browser.pauseAccount("AUTH_REQUIRED", "浏览器登录");
    android.pauseAccount("RATE_LIMITED", "手机验证");
    assert.deepEqual(Object.keys(browser.accountPause().channels).sort(), [
      "android",
      "browser",
    ]);
    assert.equal(android.resumeAccountChannel(), true);
    assert.ok(browser.accountPause().channels.browser);
    assert.equal(browser.resumeAccountChannel(), true);
    assert.equal(browser.accountPause(), null);
    s.pause("jd-account:ours", { code: "legacy-unknown" });
    assert.equal(browser.resumeAccountChannel(), false);
    assert.ok(browser.accountPause());
  } finally {
    s.close();
  }
});

test("whole captures exclude other channels and CDN until completion, including after navigation", async () => {
  const s = new Store(":memory:");
  const browser = new JdTraffic(s, "ours"),
    android = new JdTraffic(s, "ours", undefined, "android");
  let calls = 0;
  try {
    await browser.exclusive("browser", async () => {
      await browser.navigate("https://item.jd.com/123.html", async () => {});
      await assert.rejects(
        android.exclusive("android", async () => {
          calls++;
        }),
        /已有执行者/,
      );
      await assert.rejects(
        browser.asset(async () => {
          calls++;
        }),
        /已有执行者/,
      );
    });
    await android.exclusive("android", async () => {
      calls++;
    });
    assert.equal(calls, 1);
    await assert.rejects(
      browser.exclusive("browser", async () => {
        throw Error("interrupted");
      }),
      /interrupted/,
    );
    await browser.asset(async () => {
      calls++;
    });
    assert.equal(calls, 2);
  } finally {
    s.close();
  }
});

test("CDN spacing survives instances and checks shared pause before a request", async () => {
  const s = new Store(":memory:");
  let now = 100000,
    calls = 0;
  const clock = {
    now: () => now,
    sleep: async (ms: number) => {
      now += ms;
    },
  };
  try {
    await new JdTraffic(s, "ours", clock).asset(async () => calls++);
    await new JdTraffic(s, "ours", clock, "android").asset(async () => calls++);
    assert.equal(now, 101000);
    new JdTraffic(s, "ours", clock, "android").pauseAccount(
      "RATE_LIMITED",
      "验证",
    );
    await assert.rejects(
      new JdTraffic(s, "ours", clock).asset(async () => calls++),
      /队列已暂停/,
    );
    assert.equal(calls, 2);
  } finally {
    s.close();
  }
});
