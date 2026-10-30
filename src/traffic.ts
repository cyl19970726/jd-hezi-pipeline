import { assertHzRunning } from "./platform-availability.js";
import { Store } from "./store.js";
import { PipelineError } from "./model.js";
const clock = {
  now: () => Date.now(),
  sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
};
export type AccessPlatform = "hz" | "jd";
export type AccessPolicy = {
  intervalMs: number;
  hourlyLimit: number | null;
};
export const DEFAULT_HZ_ACCESS_POLICY: Readonly<AccessPolicy> = Object.freeze({
  intervalMs: 1000,
  hourlyLimit: 300,
});

const policyKey = (shop: string) => `traffic-policy:hz:${shop}`;

/** Persist an operator-selected shop budget for every HZ traffic entry point. */
export function configureHzAccessPolicy(
  store: Store,
  shop: string,
  policy: AccessPolicy,
) {
  validatePolicy(policy);
  store.setMeta(policyKey(shop), policy);
  return policy;
}

export function hzAccessPolicy(store: Store, shop: string): AccessPolicy {
  const saved = store.meta(policyKey(shop));
  if (saved === undefined || saved === null)
    return { ...DEFAULT_HZ_ACCESS_POLICY };
  if (typeof saved !== "object" || Array.isArray(saved))
    throw Error("无效持久化流量预算");
  const policy = saved as AccessPolicy;
  validatePolicy(policy);
  return { intervalMs: policy.intervalMs, hourlyLimit: policy.hourlyLimit };
}

/**
 * Durable, cross-instance reservation for deliberate platform requests.
 *
 * The existing traffic_log schema is deliberately reused: JD kinds are
 * namespaced as `jd:*`; unprefixed historical rows remain HZ requests. This
 * keeps old databases readable without a schema migration.
 */
export class AccessBudget {
  constructor(
    readonly store: Store,
    readonly shop: string,
    readonly platform: AccessPlatform,
    readonly time = clock,
  ) {
    store.db.exec(
      "CREATE TABLE IF NOT EXISTS traffic_log(id INTEGER PRIMARY KEY,shop TEXT NOT NULL,kind TEXT NOT NULL,started_at INTEGER NOT NULL,finished_at INTEGER,outcome TEXT NOT NULL); CREATE INDEX IF NOT EXISTS traffic_time ON traffic_log(started_at);",
    );
  }
  private where() {
    return this.platform === "jd"
      ? "shop=? AND kind LIKE 'jd:%'"
      : "shop=? AND kind NOT LIKE 'jd:%'";
  }
  private storedKind(kind: string) {
    return this.platform === "jd" ? `jd:${kind}` : kind;
  }
  async run<T>(
    kind: string,
    policy: AccessPolicy | (() => AccessPolicy),
    assertRunning: () => void,
    operation: () => Promise<T>,
    options: {
      lock?: string;
      priorStartedAt?: () => number;
      onBudgetExhausted?: () => void;
    } = {},
  ): Promise<T> {
    assertRunning();
    const release = this.store.lock(
      options.lock ?? `traffic:${this.platform}:${this.shop}`,
    );
    try {
      for (;;) {
        assertRunning();
        const current = typeof policy === "function" ? policy() : policy;
        validatePolicy(current);
        const row = this.store.db
          .prepare(
            `SELECT MAX(started_at) AS at FROM traffic_log WHERE ${this.where()}`,
          )
          .get(this.shop);
        const last = Math.max(
          Number(row?.at ?? 0),
          Number(options.priorStartedAt?.() ?? 0),
        );
        const delay = last
          ? Math.max(0, last + current.intervalMs - this.time.now())
          : 0;
        if (!delay) break;
        await this.time.sleep(delay);
      }
      assertRunning();
      const current = typeof policy === "function" ? policy() : policy;
      validatePolicy(current);
      const count = Number(
        this.store.db
          .prepare(
            `SELECT COUNT(*) AS n FROM traffic_log WHERE ${this.where()} AND started_at>?`,
          )
          .get(this.shop, this.time.now() - 3600000)?.n,
      );
      if (current.hourlyLimit !== null && count >= current.hourlyLimit) {
        options.onBudgetExhausted?.();
        throw new PipelineError("PAUSED", "每小时访问预算已用完");
      }
      // This timestamp is the actual dispatch boundary, after all waits and
      // pause checks, rather than task creation or queue-entry time.
      const id = this.store.db
        .prepare(
          "INSERT INTO traffic_log(shop,kind,started_at,outcome) VALUES(?,?,?,'running')",
        )
        .run(this.shop, this.storedKind(kind), this.time.now()).lastInsertRowid;
      try {
        const result = await operation();
        this.store.db
          .prepare(
            "UPDATE traffic_log SET finished_at=?,outcome='ok' WHERE id=?",
          )
          .run(this.time.now(), id);
        return result;
      } catch (error) {
        this.store.db
          .prepare(
            "UPDATE traffic_log SET finished_at=?,outcome='failed' WHERE id=?",
          )
          .run(this.time.now(), id);
        throw error;
      }
    } finally {
      release();
    }
  }
}

function validatePolicy(policy: AccessPolicy) {
  if (
    !Number.isFinite(policy.intervalMs) ||
    policy.intervalMs < 0 ||
    (policy.hourlyLimit !== null &&
      (!Number.isInteger(policy.hourlyLimit) || policy.hourlyLimit < 1))
  )
    throw Error("无效流量预算");
}
/** Counts controlled operations, not browser subresources or implicit page requests. */
export class Traffic {
  constructor(
    readonly store: Store,
    readonly shop: string,
    readonly time = clock,
    readonly policy?: AccessPolicy,
  ) {
    if (policy) validatePolicy(policy);
    new AccessBudget(store, shop, "hz", time);
  }
  private effectivePolicy() {
    const shared = hzAccessPolicy(this.store, this.shop);
    if (!this.policy) return shared;
    return {
      intervalMs: Math.max(shared.intervalMs, this.policy.intervalMs),
      hourlyLimit:
        shared.hourlyLimit === null
          ? this.policy.hourlyLimit
          : this.policy.hourlyLimit === null
            ? shared.hourlyLimit
            : Math.min(shared.hourlyLimit, this.policy.hourlyLimit),
    };
  }
  assertRetryWindow() {
    const retryNotBefore = Number(
      this.store.meta("hz-traffic:retry:" + this.shop) ?? 0,
    );
    if (Number.isFinite(retryNotBefore) && retryNotBefore > this.time.now()) {
      const remainingMs = retryNotBefore - this.time.now();
      throw new PipelineError(
        "RATE_LIMITED",
        `本站服务端冷却尚未结束，剩余 ${Math.ceil(remainingMs / 1000)} 秒`,
        { retryNotBefore, remainingMs },
      );
    }
  }
  async run<T>(kind: string, operation: () => Promise<T>): Promise<T> {
    this.assertRetryWindow();
    try {
      return await new AccessBudget(this.store, this.shop, "hz", this.time).run(
        kind,
        () => this.effectivePolicy(),
        () => {
          this.assertRetryWindow();
          assertHzRunning(this.store, this.shop);
        },
        operation,
        {
          lock: "hezi-traffic",
          onBudgetExhausted: () =>
            this.store.pause(
              "hz:" + this.shop,
              {
                code: "TRAFFIC_BUDGET",
                message: "本站每小时主动操作预算已用完；保留进度，不自动重试",
              },
              "traffic:budget",
            ),
        },
      );
    } catch (e: any) {
      // Budget/pause failures occur before dispatch and must not be classified
      // as a response from the platform.
      if (
        e?.code === "PAUSED" ||
        (e?.code === "RATE_LIMITED" && e?.details?.retryNotBefore)
      )
        throw e;
      const status = e?.response?.status ?? e?.status;
      const retryAfter =
        e?.response?.headers?.get?.("Retry-After") ??
        e?.response?.headers?.["retry-after"] ??
        e?.retryAfter ??
        null;
      const retrySeconds = Number(retryAfter);
      const retryAt = retryAfter
        ? Number.isFinite(retrySeconds)
          ? this.time.now() + Math.max(0, retrySeconds * 1000)
          : Date.parse(String(retryAfter))
        : null;
      const errorText = String(e?.code) + " " + String(e?.message);
      const riskControl =
        [403, 429].includes(Number(status)) ||
        /WAF|RATE_LIMITED|403|429|风控|访问频繁/.test(errorText);
      if (riskControl) {
        if (retryAt !== null && Number.isFinite(retryAt))
          this.store.setMeta("hz-traffic:retry:" + this.shop, retryAt);
        this.store.pause(
          "hz:" + this.shop,
          {
            code: "RISK_CONTROL",
            message: "流量控制检测拦截，停止后续访问",
            status: status ?? null,
            retryAfter,
            retryNotBefore:
              retryAt !== null && Number.isFinite(retryAt) ? retryAt : null,
          },
          "traffic:risk",
        );
      } else if (
        e?.code === "UNKNOWN_OUTCOME" &&
        [
          "save",
          "submit",
          "withdraw",
          "repair-rejected",
          "rejection-repair",
        ].includes(kind)
      ) {
        this.store.pause(
          "hz:" + this.shop,
          {
            code: "UNKNOWN_OUTCOME",
            message: "写入结果不明，停止后续赫兹写入；必须先对账",
            kind,
            status: status ?? null,
          },
          "traffic:unknown-outcome",
        );
      }
      throw e;
    }
  }
}

import type { Adapter } from "./model.js";
export function pacedAdapter(
  store: Store,
  shop: string,
  adapter: Adapter,
): Adapter {
  const traffic = new Traffic(store, shop);
  return {
    checkShop: (s) => traffic.run("account", () => adapter.checkShop(s)),
    find: (p, plan) => traffic.run("lookup", () => adapter.find(p, plan)),
    read: (id) => traffic.run("read", () => adapter.read(id)),
    save: (p, plan, id, refs) =>
      traffic.run("save", () => adapter.save(p, plan, id, refs)),
    submit: (id) => traffic.run("submit", () => adapter.submit(id)),
    ...(adapter.withdraw
      ? {
          withdraw: (id: string) =>
            traffic.run("withdraw", () => adapter.withdraw!(id)),
        }
      : {}),
  };
}
