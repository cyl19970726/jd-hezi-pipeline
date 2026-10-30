import { createRequestQueue } from "./request-queue.js";
/** Install in the main world before navigation; never modifies auth or request payloads. */
export function installRequestHook(factory: typeof createRequestQueue) {
  if (!/(^|\.)csgmall\.com\.cn$/.test(location.hostname))
    return { installed: false };
  const w = window as any;
  if (w.__heziRequests) return { installed: true, existing: true };
  const key = "hezi:request-queue:v1";
  // localStorage keeps a server-directed cooldown across a browser restart.
  // Fall back to sessionStorage only when persistent storage is unavailable.
  const storage = (() => {
    try {
      const probe = key + ":probe";
      localStorage.setItem(probe, "1");
      localStorage.removeItem(probe);
      return localStorage;
    } catch {
      return sessionStorage;
    }
  })();
  const readState = (candidate: Storage) => {
    const raw = candidate.getItem(key);
    return raw === null ? null : JSON.parse(raw);
  };
  const localState = readState(storage);
  const sessionState =
    storage === sessionStorage ? null : readState(sessionStorage);
  const mergeStates = (a: any, b: any) => {
    if (!a) return b;
    if (!b) return a;
    const reasons = (value: any, source: string) => {
      if (
        value?.pauses &&
        typeof value.pauses === "object" &&
        !Array.isArray(value.pauses)
      )
        return Object.entries(value.pauses).reduce(
          (out: Record<string, string>, [id, reason]) => {
            if (typeof reason === "string" && reason) out[id] = reason;
            return out;
          },
          {},
        );
      return typeof value?.blocked === "string" && value.blocked
        ? { ["legacy:" + source]: value.blocked }
        : {};
    };
    const pauses = { ...reasons(a, "local") };
    for (const [id, reason] of Object.entries(reasons(b, "session"))) {
      const key = pauses[id] && pauses[id] !== reason ? id + ":session" : id;
      pauses[key] = reason;
    }
    return {
      ...a,
      ...b,
      starts: [...new Set([...(a.starts ?? []), ...(b.starts ?? [])])].sort(
        (x, y) => Number(x) - Number(y),
      ),
      pauses,
      blocked: Object.values(pauses).join("；"),
      notBefore: Math.max(Number(a.notBefore) || 0, Number(b.notBefore) || 0),
      started: Math.max(Number(a.started) || 0, Number(b.started) || 0),
      completed: Math.max(Number(a.completed) || 0, Number(b.completed) || 0),
      failed: Math.max(Number(a.failed) || 0, Number(b.failed) || 0),
    };
  };
  const initialState = mergeStates(localState, sessionState);
  if (storage !== sessionStorage && sessionState) {
    // Persist the strict merged state before deleting the legacy copy.
    storage.setItem(key, JSON.stringify(initialState));
    sessionStorage.removeItem(key);
  }
  const queue = factory({
    now: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    load: () => initialState,
    save: (s) => storage.setItem(key, JSON.stringify(s)),
  });
  const isAccessDenied = (url: string) => {
    try {
      const parsed = new URL(url, location.href);
      return (
        /(^|\.)csgmall\.com\.cn$/.test(parsed.hostname) &&
        /^\/mall-view\/intercept(?:\/|$)/i.test(parsed.pathname)
      );
    } catch {
      return false;
    }
  };
  if (isAccessDenied(location.href))
    queue.pause(
      "赫兹策略拦截页：暂停业务请求，需核实恢复后明确解除",
      "hezi-access-denied",
    );
  const records: any[] = [];
  const matches = (url: string) => {
    try {
      return /(^|\.)csgmall\.com\.cn$/.test(
        new URL(url, location.href).hostname,
      );
    } catch {
      return false;
    }
  };
  const observe = (
    url: string,
    method: string,
    status: number,
    startedAt: number,
    retry: string | null,
    finalUrl?: string,
  ) => {
    records.push({
      path: new URL(url, location.href).pathname,
      method,
      status,
      startedAt,
      finishedAt: Date.now(),
      finalPath: finalUrl ? new URL(finalUrl, location.href).pathname : null,
    });
    if (records.length > 200) records.shift();
    if (status === 403 || status === 429) {
      const seconds = Number(retry);
      const ms =
        retry && Number.isFinite(seconds)
          ? seconds * 1000
          : retry
            ? Date.parse(retry) - Date.now()
            : 60000;
      queue.cooldown(Number.isFinite(ms) ? Math.max(1000, ms) : 60000);
    }
    if (status === 403)
      queue.pause("HTTP 403：网站拒绝访问，暂停业务请求", "http-403");
    if (finalUrl && isAccessDenied(finalUrl))
      queue.pause(
        "赫兹请求被导向策略拦截页：暂停业务请求",
        "hezi-access-denied",
      );
    if (
      finalUrl &&
      /(?:^|\.)(?:passport|sso)\./i.test(
        new URL(finalUrl, location.href).hostname,
      )
    )
      queue.pause(
        "登录状态失效：请求被导向认证页面，暂停业务请求",
        "auth-redirect",
      );
  };
  const fetchOriginal = window.fetch;
  window.fetch = function (input: RequestInfo | URL, init?: RequestInit) {
    const url = input instanceof Request ? input.url : String(input);
    if (!matches(url)) return fetchOriginal.call(this, input, init);
    return queue.run(
      async () => {
        const at = Date.now();
        const response = await fetchOriginal.call(window, input, init);
        observe(
          url,
          init?.method ?? (input instanceof Request ? input.method : "GET"),
          response.status,
          at,
          response.headers.get("Retry-After"),
          response.url,
        );
        // Keep the slot until the complete body arrives; the caller retains the original body.
        const reader = response.clone().body?.getReader();
        if (reader) {
          try {
            while (!(await reader.read()).done) {
              /* Drain without accumulating a second buffer. */
            }
          } finally {
            reader.releaseLock();
          }
        }
        return response;
      },
      init?.signal ??
        (input instanceof Request ? input.signal : undefined) ??
        undefined,
    );
  };
  const proto = XMLHttpRequest.prototype,
    openOriginal = proto.open,
    sendOriginal = proto.send,
    abortOriginal = proto.abort;
  const meta = new WeakMap<
    XMLHttpRequest,
    {
      url: string;
      method: string;
      async: boolean;
      controller: AbortController;
      sent: boolean;
      dispatched: boolean;
    }
  >();
  proto.open = function (this: XMLHttpRequest, ...args: any[]) {
    meta.get(this)?.controller.abort();
    const result = Reflect.apply(openOriginal, this, args);
    meta.set(this, {
      method: String(args[0]),
      url: String(args[1]),
      async: args[2] !== false,
      controller: new AbortController(),
      sent: false,
      dispatched: false,
    });
    return result;
  } as any;
  proto.abort = function () {
    const m = meta.get(this);
    m?.controller.abort();
    const result = abortOriginal.call(this);
    if (m?.sent && !m.dispatched) {
      m.sent = false;
      this.dispatchEvent(new Event("abort"));
      this.dispatchEvent(new Event("loadend"));
    }
    return result;
  };
  proto.send = function (body?: Document | XMLHttpRequestBodyInit | null) {
    const m = meta.get(this);
    if (!m || !matches(m.url)) return sendOriginal.call(this, body);
    if (!m.async)
      throw new DOMException(
        "同步业务请求不允许绕过流量队列",
        "InvalidAccessError",
      );
    if (m.sent) throw new DOMException("请求已发送", "InvalidStateError");
    m.sent = true;
    const xhr = this;
    void queue
      .run(
        () =>
          new Promise<void>((resolve, reject) => {
            const at = Date.now();
            const done = () => {
              xhr.removeEventListener("loadend", done);
              try {
                observe(
                  m.url,
                  m.method,
                  xhr.status,
                  at,
                  xhr.getResponseHeader("Retry-After"),
                  xhr.responseURL,
                );
                resolve();
              } catch (e) {
                reject(e);
              }
            };
            xhr.addEventListener("loadend", done, { once: true });
            try {
              m.dispatched = true;
              sendOriginal.call(xhr, body);
            } catch (e) {
              xhr.removeEventListener("loadend", done);
              reject(e);
            }
          }),
        m.controller.signal,
      )
      .catch((e) => {
        // Native abort handles dispatched requests; queued requests need an observable termination.
        if (!m.controller.signal.aborted) {
          xhr.dispatchEvent(new Event("error"));
          xhr.dispatchEvent(new Event("loadend"));
        }
        w.__heziRequestError = String(e);
      });
  };
  w.__heziRequests = { version: 1, queue, records };
  return { installed: true, existing: false };
}
export function requestHookSource() {
  // tsx adds __name helpers; keep serialized source independent of its host runtime.
  return `(() => { const __name = (fn) => fn; return (${installRequestHook.toString()})(${createRequestQueue.toString()}); })()`;
}
export async function ensureRequestHook(page: any) {
  const expression = requestHookSource();
  // Ego detaches CDP at the end of each round. Register on every call, even
  // when the current document already has a hook from an earlier round.
  await page.cdp("Page.addScriptToEvaluateOnNewDocument", {
    source: expression,
  });
  const r = await page.cdp("Runtime.evaluate", {
    expression,
    returnByValue: true,
  });
  if (r.exceptionDetails || !r.result?.value?.installed)
    throw Error(
      "请求限速器无法安装：" +
        (r.exceptionDetails?.text ?? "当前页面不是赫兹站点"),
    );
}
