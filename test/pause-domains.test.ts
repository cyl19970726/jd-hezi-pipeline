import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.js";
import { JdTraffic } from "../src/jd-traffic.js";

test("independent reasons stack and targeted recovery leaves the other stop active", () => {
  const store = new Store(":memory:");
  try {
    store.pause("hz:shop", { code: "UI_CHANGED" }, "ui");
    store.pause("hz:shop", { code: "WAF" }, "waf");
    assert.deepEqual(Object.keys(store.pauseReasons("hz:shop")).sort(), [
      "ui",
      "waf",
    ]);
    assert.equal(store.resumeReason("hz:shop", "ui"), true);
    assert.equal(store.isPaused("hz:shop"), true);
    assert.throws(() => store.assertScopes("hz:shop"), /队列已暂停/);
    assert.equal(store.resumeReason("hz:shop", "waf"), true);
    assert.equal(store.isPaused("hz:shop"), false);
  } finally {
    store.close();
  }
});

test("new HZ-domain stops do not block JD reads, while legacy shop pauses remain fail-closed", async () => {
  const store = new Store(":memory:");
  try {
    const jd = new JdTraffic(store, "shop");
    store.pause("hz:shop", { code: "UI_CHANGED" }, "platform");
    await jd.navigate("https://item.jd.com/123.html", async () => {});
    store.pause("shop", "existing operator stop");
    await assert.rejects(
      jd.navigate("https://item.jd.com/456.html", async () => {}),
      /队列已暂停/,
    );
  } finally {
    store.close();
  }
});

test("shared JD account pause blocks browser, Android, and CDN work", async () => {
  const store = new Store(":memory:");
  try {
    const browser = new JdTraffic(store, "shop");
    const android = new JdTraffic(store, "shop", undefined, "android");
    browser.pauseAccount("RATE_LIMITED", "verification");
    await assert.rejects(
      browser.navigate("https://item.jd.com/123.html", async () => {}),
      /队列已暂停/,
    );
    await assert.rejects(
      android.navigate("https://item.jd.com/123.html", async () => {}),
      /队列已暂停/,
    );
    await assert.rejects(
      browser.asset(async () => {}),
      /队列已暂停/,
    );
  } finally {
    store.close();
  }
});

test("legacy JD account channels recover one channel without clearing mixed reasons", () => {
  const store = new Store(":memory:");
  try {
    const browser = new JdTraffic(store, "shop");
    store.setMeta("pause:jd-account:shop", {
      channels: {
        browser: { code: "AUTH_REQUIRED" },
        android: { code: "RATE_LIMITED" },
      },
    });
    browser.pauseAccount("RATE_LIMITED", "new browser evidence");
    assert.equal(browser.resumeAccountChannel(), true);
    assert.deepEqual(browser.accountPause(), {
      channels: {
        browser: {
          code: "RATE_LIMITED",
          message: "new browser evidence",
          at: browser.accountPause().channels.browser.at,
        },
        android: { code: "RATE_LIMITED" },
      },
    });
    assert.equal(browser.resumeAccountChannel(), true);
    assert.deepEqual(browser.accountPause(), {
      channels: { android: { code: "RATE_LIMITED" } },
    });
  } finally {
    store.close();
  }
});

test("unknown legacy JD account pause cannot be cleared by channel recovery", () => {
  const store = new Store(":memory:");
  try {
    const browser = new JdTraffic(store, "shop");
    store.setMeta("pause:jd-account:shop", { code: "legacy-unknown" });
    assert.equal(browser.resumeAccountChannel(), false);
    assert.deepEqual(browser.accountPause(), { code: "legacy-unknown" });
  } finally {
    store.close();
  }
});

test("a default reason replaces only the legacy reason while keeping its scope paused", () => {
  const store = new Store(":memory:");
  try {
    store.setMeta("pause:shop", { message: "old global stop" });
    store.pause("shop", { message: "operator stop" });
    assert.equal(store.isPaused("shop"), true);
    assert.deepEqual(store.pauseReasons("shop"), {
      legacy: { message: "operator stop" },
    });
    assert.throws(() => store.assertRunning("shop"), /队列已暂停/);
  } finally {
    store.close();
  }
});

test("legacy pause records remain visible and explicit whole-scope resume still clears them", () => {
  const store = new Store(":memory:");
  try {
    store.setMeta("pause:shop", { message: "pre-existing stop" });
    assert.equal(store.meta("pause:shop").message, "pre-existing stop");
    assert.deepEqual(store.pauseReasons("shop"), {
      legacy: { message: "pre-existing stop" },
    });
    store.pause("shop", { code: "WAF" }, "waf");
    assert.equal(store.resumeReason("shop", "waf"), true);
    assert.equal(store.isPaused("shop"), true);
    assert.deepEqual(store.pauseReasons("shop"), {
      legacy: { message: "pre-existing stop" },
    });
    store.resume("shop");
    assert.equal(store.meta("pause:shop"), null);
  } finally {
    store.close();
  }
});
