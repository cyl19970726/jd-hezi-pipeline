import { Store } from "./store.js";
import { PipelineError } from "./model.js";
import { AccessBudget } from "./traffic.js";
const time = {
  now: () => Date.now(),
  sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
};
/** Controls deliberate JD navigations, not native page subrequests. No retry or fingerprint changes. */
export class JdTraffic {
  constructor(
    readonly store: Store,
    readonly shop: string,
    readonly clock = time,
    readonly channel: "browser" | "android" = "browser",
  ) {}
  assertRunning() {
    const retryNotBefore = Number(this.state().lastRisk?.retryNotBefore ?? 0);
    if (Number.isFinite(retryNotBefore) && retryNotBefore > this.clock.now()) {
      const remainingMs = retryNotBefore - this.clock.now();
      throw new PipelineError(
        "RATE_LIMITED",
        `京东服务端冷却尚未结束，剩余 ${Math.ceil(remainingMs / 1000)} 秒`,
        { retryNotBefore, remainingMs },
      );
    }
    // A legacy shop pause remains global for that shop. New HZ-only pauses
    // live under hz:<shop>, deliberately outside this source-reading domain.
    // jd-account:<shop> is the shared browser/Android/CDN risk stop; jd:<shop>
    // and jd-android:<shop> retain their established channel-local meanings.
    this.store.assertScopes(
      "all",
      this.shop,
      "jd-account:" + this.shop,
      (this.channel === "android" ? "jd-android:" : "jd:") + this.shop,
    );
  }
  state() {
    return (
      this.store.meta("jd-traffic:" + this.shop) ??
      this.store.meta("jd-traffic") ?? {
        intervalMs: 15000,
        lastAt: 0,
        navigations: 0,
        lastRisk: null,
      }
    );
  }
  accountPause() {
    const reasons = this.store.pauseReasons("jd-account:" + this.shop);
    const channels: Record<string, unknown> = {};
    for (const channel of ["browser", "android"])
      if (Object.hasOwn(reasons, channel)) channels[channel] = reasons[channel];
    const legacy = reasons.legacy;
    if (legacy && typeof legacy === "object" && (legacy as any).channels)
      Object.assign(channels, (legacy as any).channels);
    if (Object.keys(channels).length) return { channels };
    return legacy ?? (Object.keys(reasons).length ? { reasons } : null);
  }
  pauseAccount(code: "RATE_LIMITED" | "AUTH_REQUIRED", message: string) {
    this.store.pause(
      "jd-account:" + this.shop,
      {
        code,
        message,
        at: new Date(this.clock.now()).toISOString(),
      },
      this.channel,
    );
    return this.accountPause();
  }
  resumeAccountChannel() {
    const scope = "jd-account:" + this.shop;
    const legacy = this.store.pauseReasons(scope).legacy;
    // Pre-reason databases stored both channel causes inside one legacy value.
    // Remove only the verified channel from that value, leaving an unknown
    // legacy pause and every independently recorded reason fail-closed.
    if (
      legacy &&
      typeof legacy === "object" &&
      !Array.isArray(legacy) &&
      (legacy as { channels?: unknown }).channels &&
      typeof (legacy as { channels?: unknown }).channels === "object" &&
      !Array.isArray((legacy as { channels?: unknown }).channels)
    ) {
      const channels = {
        ...((legacy as { channels: Record<string, unknown> }).channels ?? {}),
      };
      if (!Object.hasOwn(channels, this.channel))
        return this.store.resumeReason(scope, this.channel);
      delete channels[this.channel];
      if (Object.keys(channels).length)
        this.store.pause(scope, { ...(legacy as object), channels }, "legacy");
      else this.store.resumeReason(scope, "legacy");
      return true;
    }
    return this.store.resumeReason(scope, this.channel);
  }
  risk(message: string, retryAfter?: string | number | null) {
    const old = this.state();
    const seconds = Number(retryAfter);
    const retryAt =
      retryAfter === undefined || retryAfter === null
        ? null
        : Number.isFinite(seconds)
          ? this.clock.now() + Math.max(0, seconds * 1000)
          : Date.parse(String(retryAfter));
    const state = {
      ...old,
      intervalMs: Math.min(60000, old.intervalMs * 2),
      lastRisk: {
        at: new Date(this.clock.now()).toISOString(),
        message,
        retryAfter: retryAfter ?? null,
        retryNotBefore: Number.isFinite(retryAt) ? retryAt : null,
      },
    };
    this.store.setMeta("jd-traffic:" + this.shop, state);
    this.pauseAccount("RATE_LIMITED", message);
    return state;
  }
  /** Hold across the whole managed capture, including UI actions after navigation.
   * A competing process fails closed; locks are never stolen on timeout. */
  async exclusive<T>(
    kind: "browser" | "android" | "asset",
    operation: () => Promise<T>,
  ): Promise<T> {
    this.assertRunning();
    const release = this.store.lock("jd-operation");
    try {
      this.assertRunning();
      this.store.setMeta("jd-operation:last", {
        kind,
        shop: this.shop,
        startedAt: new Date(this.clock.now()).toISOString(),
      });
      return await operation();
    } finally {
      release();
    }
  }
  /** CDN requests are paced separately from page navigation, but share exclusivity. */
  async asset<T>(operation: () => Promise<T>): Promise<T> {
    return this.exclusive("asset", async () => {
      for (;;) {
        this.assertRunning();
        const previous = Number(this.store.meta("jd-assets:last") ?? 0);
        const delay = previous
          ? Math.max(0, previous + 1000 - this.clock.now())
          : 0;
        if (!delay) break;
        await this.clock.sleep(Math.min(delay, 1000));
      }
      this.assertRunning();
      this.store.setMeta("jd-assets:last", this.clock.now());
      return operation();
    });
  }
  async navigate<T>(url: string, operation: () => Promise<T>): Promise<T> {
    const hostname = new URL(url).hostname;
    if (hostname !== "jd.com" && !hostname.endsWith(".jd.com"))
      throw Error("京东导航限流仅接受京东页面");
    // Reject a persisted server cooldown before taking the shared lock, so a
    // batch cannot queue behind work that is known to be ineligible.
    this.assertRunning();
    return new AccessBudget(this.store, this.shop, "jd", this.clock).run(
      "navigation",
      () => ({ intervalMs: this.state().intervalMs, hourlyLimit: null }),
      () => this.assertRunning(),
      async () => {
        const state = this.state();
        const at = this.clock.now();
        this.store.setMeta("jd-traffic:" + this.shop, {
          ...state,
          lastAt: at,
          navigations: state.navigations + 1,
          recentStarts: [...(state.recentStarts ?? []), at].slice(-20),
          lastUrl: url,
        });
        this.store.setMeta("jd-navigation:last:" + this.shop, at);
        return operation();
      },
      {
        lock: "jd-navigation",
        priorStartedAt: () =>
          Math.max(
            Number(this.state().lastAt ?? 0),
            Number(this.store.meta("jd-navigation:last:" + this.shop) ?? 0),
          ),
      },
    );
  }
}
