import { createHash, randomUUID } from "node:crypto";
import type { AnalyticsStore } from "./core.js";
import type { ObservationInput } from "./types.js";

export interface CollectionPageRequest {
  scheduleId: string;
  source: string;
  shopId: string;
  page: number;
  limit: number;
}
export interface CollectionPageResult {
  observations: ObservationInput[];
  observedAt: string;
  totalPages: number;
  totalCount: number;
  page: number;
  completeScope: boolean;
  countSemantics?: "observations" | "item-groups";
  coverageCount?: number;
}
export interface CollectionPageAdapter {
  readPage(request: CollectionPageRequest): Promise<CollectionPageResult>;
}
export interface ExternalAdapterLease {
  release(): void | Promise<void>;
}
export interface ExternalAdapterGuard {
  acquire(context: {
    scheduleId: string;
    shopId: string;
  }): Promise<ExternalAdapterLease | null>;
}
export type CollectionFailureKind =
  "auth" | "rate_limit" | "user_control" | "timeout" | "unavailable";
export class CollectionAdapterError extends Error {
  constructor(
    public kind: CollectionFailureKind,
    message: string,
    public retryAfterMs?: number,
  ) {
    super(message);
    this.name = "CollectionAdapterError";
  }
}
export interface CollectionConfigInput {
  id: string;
  source: string;
  shopId: string;
  intervalMs: number;
  pageSize?: number;
}
export type CollectionStatus = "stopped" | "active" | "paused";
export interface CollectionSchedule extends CollectionConfigInput {
  pageSize: number;
  status: CollectionStatus;
  pauseReason: string | null;
  nextDueAt: string | null;
  activeRunId: string | null;
  updatedAt: string;
}
export interface CollectionTickResult {
  status: "idle" | "busy" | "progress" | "completed" | "paused";
  scheduleId?: string;
  runId?: string;
  pagesRead: number;
  reason?: string;
}
export interface CollectionHealth {
  schedules: number;
  active: number;
  paused: number;
  runningRuns: number;
  partialRuns: number;
  completeRuns: number;
  lastCompletedAt: string | null;
  observations: number;
  pausedReasons: Record<string, number>;
}
export interface AnalyticsCollectionOptions {
  now?: () => number;
  ownerId?: string;
  leaseMs?: number;
  maxPagesPerTick?: number;
}

const HOUR = 3_600_000;
const safeId = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,199}$/;
const iso = (v: string, label: string) => {
  const n = Date.parse(v);
  if (!Number.isFinite(n)) throw new Error(`${label} must be an ISO timestamp`);
  return new Date(n).toISOString();
};
const integer = (
  v: number,
  label: string,
  min: number,
  max = Number.MAX_SAFE_INTEGER,
) => {
  if (!Number.isSafeInteger(v) || v < min || v > max)
    throw new Error(
      `${label} must be a safe integer between ${min} and ${max}`,
    );
  return v;
};
const required = (v: string, label: string) => {
  if (typeof v !== "string" || !v.trim())
    throw new Error(`${label} is required`);
  return v.trim();
};
const stable = (v: unknown): string =>
  Array.isArray(v)
    ? `[${v.map(stable).join(",")}]`
    : v && typeof v === "object"
      ? `{${Object.entries(v as Record<string, unknown>)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, x]) => `${JSON.stringify(k)}:${stable(x)}`)
          .join(",")}}`
      : JSON.stringify(v);
const digest = (v: unknown) =>
  createHash("sha256").update(stable(v)).digest("hex");

export class AnalyticsCollection {
  private now: () => number;
  private ownerId: string;
  private leaseMs: number;
  private maxPages: number;
  constructor(
    public store: AnalyticsStore,
    private adapter: CollectionPageAdapter,
    private guard?: ExternalAdapterGuard,
    options: AnalyticsCollectionOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.ownerId = options.ownerId ?? randomUUID();
    this.leaseMs = integer(
      options.leaseMs ?? 60_000,
      "leaseMs",
      5_000,
      300_000,
    );
    this.maxPages = integer(
      options.maxPagesPerTick ?? 3,
      "maxPagesPerTick",
      1,
      3,
    );
    store.db
      .exec(`CREATE TABLE IF NOT EXISTS analytics_collection_schedule(id TEXT PRIMARY KEY,source TEXT NOT NULL,shop_id TEXT NOT NULL,interval_ms INTEGER NOT NULL,page_size INTEGER NOT NULL,status TEXT NOT NULL,pause_reason TEXT,next_due_at TEXT,active_run_id TEXT,updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS analytics_collection_scheduler_run(id TEXT PRIMARY KEY,schedule_id TEXT NOT NULL REFERENCES analytics_collection_schedule(id),status TEXT NOT NULL,next_page INTEGER NOT NULL DEFAULT 1,total_pages INTEGER,total_count INTEGER,timeout_attempts INTEGER NOT NULL DEFAULT 0,last_error TEXT,started_at TEXT NOT NULL,completed_at TEXT);
      CREATE TABLE IF NOT EXISTS analytics_collection_page_checkpoint(run_id TEXT NOT NULL REFERENCES analytics_collection_scheduler_run(id),page INTEGER NOT NULL,import_run_id TEXT NOT NULL,observed_at TEXT NOT NULL,observation_count INTEGER NOT NULL,total_pages INTEGER NOT NULL,total_count INTEGER NOT NULL,payload_hash TEXT NOT NULL,complete_scope INTEGER NOT NULL,completed_at TEXT NOT NULL,PRIMARY KEY(run_id,page));
      CREATE TABLE IF NOT EXISTS analytics_collection_scheduler_lease(name TEXT PRIMARY KEY,owner TEXT NOT NULL,lease_until INTEGER NOT NULL);`);
    const checkpointColumns = new Set(
      (
        store.db
          .prepare("PRAGMA table_info(analytics_collection_page_checkpoint)")
          .all() as any[]
      ).map((column) => String(column.name)),
    );
    if (!checkpointColumns.has("coverage_count")) {
      store.db.exec(
        "ALTER TABLE analytics_collection_page_checkpoint ADD COLUMN coverage_count INTEGER NOT NULL DEFAULT 0",
      );
      store.db.exec(
        "UPDATE analytics_collection_page_checkpoint SET coverage_count=observation_count",
      );
    }
    if (!checkpointColumns.has("count_semantics"))
      store.db.exec(
        "ALTER TABLE analytics_collection_page_checkpoint ADD COLUMN count_semantics TEXT NOT NULL DEFAULT 'observations'",
      );
    if (!checkpointColumns.has("identity_keys"))
      store.db.exec(
        "ALTER TABLE analytics_collection_page_checkpoint ADD COLUMN identity_keys TEXT NOT NULL DEFAULT '[]'",
      );
  }

  configure(input: CollectionConfigInput): CollectionSchedule {
    if (!safeId.test(input.id)) throw new Error("config id is not safe");
    required(input.source, "source");
    required(input.shopId, "shopId");
    integer(input.intervalMs, "intervalMs", HOUR);
    const pageSize = integer(input.pageSize ?? 100, "pageSize", 1, 200),
      now = new Date(this.now()).toISOString();
    const existing: any = this.store.db
      .prepare("SELECT * FROM analytics_collection_schedule WHERE id=?")
      .get(input.id);
    if (
      existing?.active_run_id &&
      (existing.source !== input.source ||
        existing.shop_id !== input.shopId ||
        Number(existing.page_size) !== pageSize)
    )
      throw new Error("cannot change collection scope while a run is active");
    this.store.db
      .prepare(
        `INSERT INTO analytics_collection_schedule(id,source,shop_id,interval_ms,page_size,status,pause_reason,next_due_at,active_run_id,updated_at) VALUES(?,?,?,?,?,'stopped',NULL,NULL,NULL,?) ON CONFLICT(id) DO UPDATE SET source=excluded.source,shop_id=excluded.shop_id,interval_ms=excluded.interval_ms,page_size=excluded.page_size,updated_at=excluded.updated_at`,
      )
      .run(
        input.id,
        input.source,
        input.shopId,
        input.intervalMs,
        pageSize,
        now,
      );
    return this.get(input.id);
  }
  start(id: string): CollectionSchedule {
    return this.activate(id);
  }
  resume(id: string): CollectionSchedule {
    return this.activate(id);
  }
  private activate(id: string) {
    const result = this.store.db
      .prepare(
        "UPDATE analytics_collection_schedule SET status='active',pause_reason=NULL,next_due_at=?,updated_at=? WHERE id=?",
      )
      .run(
        new Date(this.now()).toISOString(),
        new Date(this.now()).toISOString(),
        id,
      );
    if (!result.changes)
      throw new Error(`collection schedule not found: ${id}`);
    return this.get(id);
  }
  pause(id: string, reason = "manual"): CollectionSchedule {
    required(reason, "reason");
    const result = this.store.db
      .prepare(
        "UPDATE analytics_collection_schedule SET status='paused',pause_reason=?,updated_at=? WHERE id=?",
      )
      .run(reason, new Date(this.now()).toISOString(), id);
    if (!result.changes)
      throw new Error(`collection schedule not found: ${id}`);
    return this.get(id);
  }
  list(): CollectionSchedule[] {
    return (
      this.store.db
        .prepare("SELECT * FROM analytics_collection_schedule ORDER BY id")
        .all() as any[]
    ).map((r) => this.decode(r));
  }
  private get(id: string): CollectionSchedule {
    const r: any = this.store.db
      .prepare("SELECT * FROM analytics_collection_schedule WHERE id=?")
      .get(id);
    if (!r) throw new Error(`collection schedule not found: ${id}`);
    return this.decode(r);
  }
  private decode(r: any): CollectionSchedule {
    return {
      id: r.id,
      source: r.source,
      shopId: r.shop_id,
      intervalMs: Number(r.interval_ms),
      pageSize: Number(r.page_size),
      status: r.status,
      pauseReason: r.pause_reason,
      nextDueAt: r.next_due_at,
      activeRunId: r.active_run_id,
      updatedAt: r.updated_at,
    };
  }

  private acquire(): boolean {
    const now = this.now(),
      until = now + this.leaseMs,
      db = this.store.db;
    db.exec("BEGIN IMMEDIATE");
    try {
      const row: any = db
        .prepare(
          "SELECT * FROM analytics_collection_scheduler_lease WHERE name='market'",
        )
        .get();
      if (row && Number(row.lease_until) > now && row.owner !== this.ownerId) {
        db.exec("COMMIT");
        return false;
      }
      db.prepare(
        "INSERT INTO analytics_collection_scheduler_lease VALUES('market',?,?) ON CONFLICT(name) DO UPDATE SET owner=excluded.owner,lease_until=excluded.lease_until",
      ).run(this.ownerId, until);
      db.exec("COMMIT");
      return true;
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }
  private release() {
    this.store.db
      .prepare(
        "DELETE FROM analytics_collection_scheduler_lease WHERE name='market' AND owner=?",
      )
      .run(this.ownerId);
  }
  private pauseFailure(
    id: string,
    kind: CollectionFailureKind,
    message: string,
  ) {
    this.pause(id, `${kind}: ${message}`);
  }

  async tick(): Promise<CollectionTickResult> {
    if (!this.acquire()) return { status: "busy", pagesRead: 0 };
    let external: ExternalAdapterLease | null = null;
    try {
      const nowIso = new Date(this.now()).toISOString(),
        schedule: any = this.store.db
          .prepare(
            "SELECT * FROM analytics_collection_schedule WHERE status='active' AND next_due_at IS NOT NULL AND julianday(next_due_at)<=julianday(?) ORDER BY next_due_at,id LIMIT 1",
          )
          .get(nowIso);
      if (!schedule) return { status: "idle", pagesRead: 0 };
      if (this.guard) {
        try {
          external = await this.guard.acquire({
            scheduleId: schedule.id,
            shopId: schedule.shop_id,
          });
        } catch (error) {
          const failure = this.failure(error);
          this.pauseFailure(schedule.id, failure.kind, failure.message);
          return {
            status: "paused",
            scheduleId: schedule.id,
            pagesRead: 0,
            reason: failure.kind,
          };
        }
        if (!external) {
          this.pauseFailure(
            schedule.id,
            "unavailable",
            "external adapter guard unavailable",
          );
          return {
            status: "paused",
            scheduleId: schedule.id,
            pagesRead: 0,
            reason: "unavailable",
          };
        }
      }
      let run: any = schedule.active_run_id
        ? this.store.db
            .prepare(
              "SELECT * FROM analytics_collection_scheduler_run WHERE id=?",
            )
            .get(schedule.active_run_id)
        : null;
      if (!run) {
        const runId = `${schedule.id}:${randomUUID()}`;
        this.store.db
          .prepare(
            "INSERT INTO analytics_collection_scheduler_run(id,schedule_id,status,started_at) VALUES(?,?,'running',?)",
          )
          .run(runId, schedule.id, nowIso);
        this.store.db
          .prepare(
            "UPDATE analytics_collection_schedule SET active_run_id=? WHERE id=?",
          )
          .run(runId, schedule.id);
        run = this.store.db
          .prepare(
            "SELECT * FROM analytics_collection_scheduler_run WHERE id=?",
          )
          .get(runId);
      }
      let pagesRead = 0;
      while (pagesRead < this.maxPages) {
        const page = Number(run.next_page);
        try {
          const result = await this.adapter.readPage({
            scheduleId: schedule.id,
            source: schedule.source,
            shopId: schedule.shop_id,
            page,
            limit: Number(schedule.page_size),
          });
          this.validatePage(result, page, run);
          const semantics = result.countSemantics ?? "observations";
          const coverageCount =
            result.coverageCount ?? result.observations.length;
          const identityKeys = result.observations.map((observation) =>
            this.observationIdentity(observation),
          );
          if (new Set(identityKeys).size !== identityKeys.length)
            throw new Error(
              "collection page contains duplicate observation identities",
            );
          const previousPages: any[] = this.store.db
            .prepare(
              "SELECT page,count_semantics,identity_keys FROM analytics_collection_page_checkpoint WHERE run_id=? AND page<>?",
            )
            .all(run.id, page);
          if (
            previousPages.some(
              (checkpoint) => checkpoint.count_semantics !== semantics,
            )
          )
            throw new Error("collection count semantics changed during a run");
          const previousIdentities = new Set<string>(
            previousPages.flatMap((checkpoint) =>
              JSON.parse(String(checkpoint.identity_keys)),
            ),
          );
          if (identityKeys.some((identity) => previousIdentities.has(identity)))
            throw new Error(
              "collection contains duplicate observation identities across pages",
            );
          const importRunId = `${run.id}:page:${page}`,
            payloadHash = digest(result);
          const checkpoint: any = this.store.db
            .prepare(
              "SELECT payload_hash FROM analytics_collection_page_checkpoint WHERE run_id=? AND page=?",
            )
            .get(run.id, page);
          if (checkpoint && checkpoint.payload_hash !== payloadHash)
            throw new Error(
              `page ${page} replay conflicts with its checkpoint`,
            );
          this.store.importObservations(result.observations, {
            id: importRunId,
            source: schedule.source,
            observedAt: result.observedAt,
            coverage: "partial",
            expectedCount: result.observations.length,
          });
          if (!checkpoint)
            this.store.db
              .prepare(
                `INSERT INTO analytics_collection_page_checkpoint
                (run_id,page,import_run_id,observed_at,observation_count,total_pages,total_count,payload_hash,complete_scope,completed_at,coverage_count,count_semantics,identity_keys)
                VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
              )
              .run(
                run.id,
                page,
                importRunId,
                iso(result.observedAt, "observedAt"),
                result.observations.length,
                result.totalPages,
                result.totalCount,
                payloadHash,
                result.completeScope ? 1 : 0,
                new Date(this.now()).toISOString(),
                coverageCount,
                semantics,
                JSON.stringify(identityKeys),
              );
          pagesRead++;
          const finalPage = page === result.totalPages;
          if (finalPage && result.completeScope) {
            this.complete(
              run.id,
              schedule.id,
              result.totalPages,
              result.totalCount,
              Number(schedule.interval_ms),
            );
            return {
              status: "completed",
              scheduleId: schedule.id,
              runId: run.id,
              pagesRead,
            };
          }
          const nextPage = finalPage ? page : page + 1;
          this.store.db
            .prepare(
              "UPDATE analytics_collection_scheduler_run SET next_page=?,total_pages=?,total_count=?,timeout_attempts=0,last_error=NULL WHERE id=?",
            )
            .run(nextPage, result.totalPages, result.totalCount, run.id);
          run = {
            ...run,
            next_page: nextPage,
            total_pages: result.totalPages,
            total_count: result.totalCount,
            timeout_attempts: 0,
          };
          if (finalPage) break;
        } catch (error) {
          const failure = this.failure(error);
          if (failure.kind === "timeout") {
            const attempts = Number(run.timeout_attempts) + 1;
            if (attempts >= 3) {
              this.pauseFailure(schedule.id, "timeout", failure.message);
              this.store.db
                .prepare(
                  "UPDATE analytics_collection_scheduler_run SET timeout_attempts=?,last_error=? WHERE id=?",
                )
                .run(attempts, failure.message, run.id);
              return {
                status: "paused",
                scheduleId: schedule.id,
                runId: run.id,
                pagesRead,
                reason: "timeout",
              };
            }
            const delay = Math.min(
              failure.retryAfterMs ?? HOUR * Math.pow(2, attempts - 1),
              6 * HOUR,
            );
            this.store.db
              .prepare(
                "UPDATE analytics_collection_scheduler_run SET timeout_attempts=?,last_error=? WHERE id=?",
              )
              .run(attempts, failure.message, run.id);
            this.store.db
              .prepare(
                "UPDATE analytics_collection_schedule SET next_due_at=? WHERE id=?",
              )
              .run(new Date(this.now() + delay).toISOString(), schedule.id);
            return {
              status: "progress",
              scheduleId: schedule.id,
              runId: run.id,
              pagesRead,
              reason: "timeout_backoff",
            };
          }
          this.pauseFailure(schedule.id, failure.kind, failure.message);
          return {
            status: "paused",
            scheduleId: schedule.id,
            runId: run.id,
            pagesRead,
            reason: failure.kind,
          };
        }
      }
      this.store.db
        .prepare(
          "UPDATE analytics_collection_schedule SET next_due_at=? WHERE id=?",
        )
        .run(new Date(this.now()).toISOString(), schedule.id);
      return {
        status: "progress",
        scheduleId: schedule.id,
        runId: run.id,
        pagesRead,
      };
    } finally {
      try {
        if (external) await external.release();
      } finally {
        this.release();
      }
    }
  }

  private validatePage(p: CollectionPageResult, page: number, run: any) {
    if (p.page !== page)
      throw new Error(`adapter returned page ${p.page}, expected ${page}`);
    integer(p.totalPages, "totalPages", 1);
    integer(p.totalCount, "totalCount", 0);
    if (page > p.totalPages) throw new Error("page exceeds totalPages");
    if (!Array.isArray(p.observations))
      throw new Error("observations must be an array");
    const semantics = p.countSemantics ?? "observations";
    if (!["observations", "item-groups"].includes(semantics))
      throw new Error("unsupported collection count semantics");
    const coverageCount = p.coverageCount ?? p.observations.length;
    integer(coverageCount, "coverageCount", 0);
    if (semantics === "observations" && coverageCount !== p.observations.length)
      throw new Error(
        "observation coverageCount differs from observations length",
      );
    iso(p.observedAt, "observedAt");
    if (
      run.total_pages != null &&
      (Number(run.total_pages) !== p.totalPages ||
        Number(run.total_count) !== p.totalCount)
    )
      throw new Error("collection scope changed during a run");
    if (p.completeScope && page !== p.totalPages)
      throw new Error("completeScope is only valid on the final page");
  }
  private observationIdentity(observation: ObservationInput): string {
    const parts = [
      observation.platform,
      observation.shop,
      observation.itemId,
      observation.skuId,
    ].map((value) => required(String(value ?? ""), "observation identity"));
    return parts.join("\u001f");
  }
  private complete(
    runId: string,
    scheduleId: string,
    totalPages: number,
    totalCount: number,
    intervalMs: number,
  ) {
    const pages: any[] = this.store.db
      .prepare(
        "SELECT * FROM analytics_collection_page_checkpoint WHERE run_id=? ORDER BY page",
      )
      .all(runId);
    if (
      pages.length !== totalPages ||
      pages.some((r, i) => Number(r.page) !== i + 1) ||
      new Set(pages.map((row) => String(row.count_semantics))).size !== 1 ||
      pages.reduce((n, r) => n + Number(r.coverage_count), 0) !== totalCount
    )
      throw new Error(
        "complete scope checkpoint coverage does not match adapter totals",
      );
    const db = this.store.db;
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const page of pages)
        db.prepare(
          "UPDATE analytics_collection_runs SET coverage='complete' WHERE id=?",
        ).run(page.import_run_id);
      const now = new Date(this.now()).toISOString();
      db.prepare(
        "UPDATE analytics_collection_scheduler_run SET status='complete',total_pages=?,total_count=?,completed_at=?,last_error=NULL WHERE id=?",
      ).run(totalPages, totalCount, now, runId);
      db.prepare(
        "UPDATE analytics_collection_schedule SET active_run_id=NULL,next_due_at=?,updated_at=? WHERE id=?",
      ).run(new Date(this.now() + intervalMs).toISOString(), now, scheduleId);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }
  private failure(error: unknown): CollectionAdapterError {
    if (error instanceof CollectionAdapterError) return error;
    const e = error as any,
      kind: CollectionFailureKind =
        e?.status === 401 || e?.status === 403
          ? "auth"
          : e?.status === 429
            ? "rate_limit"
            : e?.kind === "user_control"
              ? "user_control"
              : e?.kind === "unavailable"
                ? "unavailable"
                : e?.name === "AbortError" || e?.kind === "timeout"
                  ? "timeout"
                  : "unavailable";
    return new CollectionAdapterError(
      kind,
      error instanceof Error ? error.message : String(error),
      Number.isFinite(e?.retryAfterMs) ? e.retryAfterMs : undefined,
    );
  }
  health(): CollectionHealth {
    const rows: any[] = this.store.db
        .prepare(
          "SELECT status,pause_reason FROM analytics_collection_schedule",
        )
        .all(),
      runs: any[] = this.store.db
        .prepare(
          "SELECT status,completed_at FROM analytics_collection_scheduler_run",
        )
        .all(),
      reasons: Record<string, number> = {};
    for (const r of rows)
      if (r.pause_reason)
        reasons[r.pause_reason] = (reasons[r.pause_reason] ?? 0) + 1;
    const completed = runs
      .filter((r) => r.status === "complete")
      .map((r) => r.completed_at)
      .filter(Boolean)
      .sort();
    const observations = Number(
      (
        this.store.db
          .prepare(
            "SELECT COALESCE(sum(observation_count),0) n FROM analytics_collection_page_checkpoint",
          )
          .get() as any
      ).n,
    );
    return {
      schedules: rows.length,
      active: rows.filter((r) => r.status === "active").length,
      paused: rows.filter((r) => r.status === "paused").length,
      runningRuns: runs.filter((r) => r.status === "running").length,
      partialRuns: runs.filter((r) => r.status === "running").length,
      completeRuns: completed.length,
      lastCompletedAt: completed.at(-1) ?? null,
      observations,
      pausedReasons: reasons,
    };
  }
}
