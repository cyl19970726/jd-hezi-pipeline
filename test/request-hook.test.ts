import { test } from "node:test";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { requestHookSource } from "../src/browser/request-hook.js";

function browser(seed?: { local?: any; session?: any }) {
  let now = 10000;
  const calls: { method: string; url: string; at: number }[] = [];
  const local = new Map<string, string>();
  const session = new Map<string, string>();
  const key = "hezi:request-queue:v1";
  if (seed?.local) local.set(key, JSON.stringify(seed.local));
  if (seed?.session) session.set(key, JSON.stringify(seed.session));
  class XHR extends EventTarget {
    status = 200;
    responseURL = "https://b.csgmall.com.cn/api";
    method = "";
    url = "";
    open(method: string, url: string) {
      this.method = method;
      this.url = url;
    }
    send() {
      calls.push({ method: this.method, url: this.url, at: now });
      queueMicrotask(() => this.dispatchEvent(new Event("loadend")));
    }
    abort() {}
    getResponseHeader() {
      return null;
    }
  }
  const w: any = {
    fetch: async (url: any, init?: any) => {
      calls.push({ method: init?.method ?? "GET", url: String(url), at: now });
      const response = new Response("ok", {
        status: String(url).includes("denied") ? 403 : 200,
      });
      if (String(url).includes("intercepted"))
        Object.defineProperty(response, "url", {
          value: "https://b.csgmall.com.cn/mall-view/intercept",
        });
      if (String(url).includes("login"))
        Object.defineProperty(response, "url", {
          value: "https://sso.csgmall.com.cn/login",
        });
      return response;
    },
  };
  const ctx = {
    window: w,
    location: {
      hostname: "b.csgmall.com.cn",
      href: "https://b.csgmall.com.cn/",
    },
    XMLHttpRequest: XHR,
    URL,
    Request,
    Response,
    Event,
    DOMException,
    AbortController,
    structuredClone,
    Date: { now: () => now, parse: Date.parse },
    sessionStorage: {
      getItem: (k: string) => session.get(k) ?? null,
      setItem: (k: string, v: string) => session.set(k, v),
      removeItem: (k: string) => session.delete(k),
    },
    localStorage: {
      getItem: (k: string) => local.get(k) ?? null,
      setItem: (k: string, v: string) => local.set(k, v),
      removeItem: (k: string) => local.delete(k),
    },
    setTimeout: (fn: () => void, ms: number) => {
      now += ms;
      queueMicrotask(fn);
    },
  };
  runInNewContext(requestHookSource(), ctx);
  return { w, XHR, calls, local, session, key };
}

test("main-world hook serializes mixed fetch and XHR without changing payload or off-site calls", async () => {
  const { w, XHR, calls } = browser();
  const a = w.fetch("/a", { method: "POST", body: "unchanged" });
  const b = new XHR();
  b.open("GET", "/b");
  const ended = new Promise<void>((r) =>
    b.addEventListener("loadend", () => r(), { once: true }),
  );
  b.send();
  const c = w.fetch("/c");
  await Promise.all([a, ended, c]);
  assert.deepEqual(
    calls.map((x) => [x.method, x.url, x.at]),
    [
      ["POST", "/a", 10000],
      ["GET", "/b", 10334],
      ["GET", "/c", 10668],
    ],
  );
  await w.fetch("https://example.com/other");
  assert.equal(w.__heziRequests.queue.snapshot().started, 3);
});

test("403 pauses later native dispatch without replaying a write", async () => {
  const { w, calls } = browser();
  const a = w.fetch("/denied", { method: "POST" });
  const b = w.fetch("/later");
  await a;
  await assert.rejects(b, /403/);
  assert.equal(calls.length, 1);
  assert.equal(
    w.__heziRequests.queue.snapshot().pauses["http-403"],
    "HTTP 403：网站拒绝访问，暂停业务请求",
  );
});

test("authentication redirect pauses later work without replaying a queued write", async () => {
  const { w, calls } = browser();
  const first = w.fetch("/login-check", { method: "POST" });
  const queued = w.fetch("/write", { method: "POST" });
  await first;
  await assert.rejects(queued, /登录状态失效/);
  assert.equal(calls.length, 1);
  assert.equal(
    w.__heziRequests.queue.snapshot().pauses["auth-redirect"],
    "登录状态失效：请求被导向认证页面，暂停业务请求",
  );
});

test("migration keeps the strictest local and legacy session state", async () => {
  const { w, calls, local, session, key } = browser({
    local: {
      starts: [9000],
      blocked: "",
      notBefore: 12000,
      started: 1,
      completed: 1,
      failed: 0,
    },
    session: {
      starts: [9500],
      blocked: "旧会话暂停",
      notBefore: 15000,
      started: 2,
      completed: 1,
      failed: 1,
    },
  });
  assert.equal(session.has(key), false);
  assert.equal(JSON.parse(local.get(key)!).notBefore, 15000);
  await assert.rejects(w.fetch("/write", { method: "POST" }), /旧会话暂停/);
  assert.equal(calls.length, 0);
});

test("queued XHR abort terminates listeners and never dispatches", async () => {
  const { XHR, calls } = browser();
  const b = new XHR();
  b.open("POST", "/write");
  const events: string[] = [];
  b.addEventListener("abort", () => events.push("abort"));
  b.addEventListener("loadend", () => events.push("loadend"));
  b.send();
  b.abort();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(events, ["abort", "loadend"]);
  assert.equal(calls.length, 0);
});

test("each Ego round registers its own document-start hook, including an already guarded document", async () => {
  const { ensureRequestHook } = await import("../src/browser/request-hook.js");
  const calls: string[] = [];
  const page = {
    cdp: async (method: string) => {
      calls.push(method);
      return { result: { value: { installed: true, existing: true } } };
    },
  };
  await ensureRequestHook(page);
  await ensureRequestHook(page);
  assert.equal(
    calls.filter((x) => x === "Page.addScriptToEvaluateOnNewDocument").length,
    2,
  );
});

test("Hezi intercept redirect pauses subsequent requests even with HTTP 200", async () => {
  const { w, calls, local, key } = browser();
  const result = await w.fetch("/intercepted");
  assert.equal(result.status, 200);
  await assert.rejects(w.fetch("/later"), /策略拦截/);
  assert.equal(calls.length, 1);
  assert.match(
    JSON.parse(local.get(key)!).pauses["hezi-access-denied"],
    /策略拦截/,
  );
});
