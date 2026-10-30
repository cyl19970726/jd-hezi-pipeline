import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  AnalyticsHealth,
  AnalyticsOverview,
  BrandAuthorizationProjection,
  BrandSummary,
  BrandTaskPatch,
  CollectionRunInput,
  EvidenceResult,
  ImportResult,
  MarketCandidate,
  MarketQuery,
  ObservationEvidence,
  ObservationInput,
  Opportunity,
  OpportunityPatch,
  OpportunityQuery,
  OpportunitySeed,
  Page,
} from "./types.js";

export * from "./types.js";

const CONTRACT_VERSION = "comparison-v1";
export const AUTHORIZATION_FRESHNESS_MS = 24 * 60 * 60 * 1_000;

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stable(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function hash(value: unknown): string {
  return createHash("sha256").update(stable(value)).digest("hex");
}

function iso(value: string, label: string): string {
  const time = Date.parse(value);
  if (!Number.isFinite(time))
    throw new Error(`${label} must be an ISO timestamp`);
  return new Date(time).toISOString();
}

function required(value: string, label: string): string {
  const result = value.trim();
  if (!result) throw new Error(`${label} is required`);
  return result;
}

function integer(value: number, label: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || value < minimum)
    throw new Error(`${label} must be a safe integer >= ${minimum}`);
  return value;
}

function paging(page = 1, pageSize = 50) {
  integer(page, "page", 1);
  integer(pageSize, "pageSize", 1);
  if (pageSize > 200) throw new Error("pageSize must be <= 200");
  return { page, pageSize, offset: (page - 1) * pageSize };
}

function json(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function likePattern(value: string): string {
  return `%${value.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
}

function decoded(value: unknown): unknown {
  return value === null || value === undefined
    ? null
    : JSON.parse(String(value));
}

export class AnalyticsStore {
  public db: DatabaseSync;
  private transactionDepth = 0;

  constructor(path: string) {
    if (path !== ":memory:")
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    this.db
      .exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS analytics_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS analytics_collection_runs(
        id TEXT PRIMARY KEY, source TEXT NOT NULL, observed_at TEXT NOT NULL,
        coverage TEXT NOT NULL CHECK(coverage IN ('complete','partial')),
        expected_count INTEGER, received_count INTEGER NOT NULL DEFAULT 0,
        inserted_count INTEGER NOT NULL DEFAULT 0, duplicate_count INTEGER NOT NULL DEFAULT 0,
        conflict_count INTEGER NOT NULL DEFAULT 0, rejected_count INTEGER NOT NULL DEFAULT 0,
        payload_hash TEXT, ingested_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS analytics_observations(
        id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES analytics_collection_runs(id),
        platform TEXT NOT NULL, shop TEXT NOT NULL, item_id TEXT NOT NULL, sku_id TEXT NOT NULL,
        title TEXT NOT NULL, brand TEXT, category TEXT, packaging TEXT, sale_unit TEXT NOT NULL,
        source_entry TEXT NOT NULL, field TEXT NOT NULL, field_version TEXT NOT NULL,
        semantics_version TEXT NOT NULL, currency TEXT NOT NULL, value REAL NOT NULL,
        price_minor INTEGER, source_event_at TEXT, observed_at TEXT NOT NULL, ingested_at TEXT NOT NULL,
        raw_json TEXT NOT NULL, payload_hash TEXT NOT NULL, logical_key TEXT NOT NULL UNIQUE,
        comparison_contract_version TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS analytics_observations_lookup ON analytics_observations(platform,shop,item_id,sku_id,source_entry,field,observed_at);
      CREATE TABLE IF NOT EXISTS analytics_observation_conflicts(
        id TEXT PRIMARY KEY, logical_key TEXT NOT NULL, existing_observation_id TEXT NOT NULL REFERENCES analytics_observations(id),
        run_id TEXT NOT NULL REFERENCES analytics_collection_runs(id), incoming_json TEXT NOT NULL,
        incoming_hash TEXT NOT NULL, detected_at TEXT NOT NULL,
        UNIQUE(logical_key,incoming_hash)
      );
      CREATE TABLE IF NOT EXISTS analytics_opportunities(
        id TEXT PRIMARY KEY, identity_key TEXT, candidate_id TEXT NOT NULL, brand TEXT, route TEXT NOT NULL,
        status TEXT NOT NULL, owner TEXT, next_action TEXT NOT NULL, reason TEXT NOT NULL,
        demand_rank INTEGER, authorization_status TEXT NOT NULL, own_match_status TEXT NOT NULL,
        decision_id TEXT, revision INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS analytics_opportunities_rank ON analytics_opportunities(status,route,demand_rank,id);
      CREATE UNIQUE INDEX IF NOT EXISTS analytics_opportunities_candidate ON analytics_opportunities(candidate_id);
      CREATE TABLE IF NOT EXISTS analytics_opportunity_evidence(
        opportunity_id TEXT NOT NULL REFERENCES analytics_opportunities(id), observation_id TEXT NOT NULL REFERENCES analytics_observations(id),
        role TEXT NOT NULL, PRIMARY KEY(opportunity_id,observation_id,role)
      );
      CREATE TABLE IF NOT EXISTS analytics_brand_tasks(
        brand TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'pending', owner TEXT, next_follow_up_at TEXT,
        result_reason TEXT, scope TEXT, authorization_valid_until TEXT, authorization_verified_at TEXT,
        identity_source TEXT NOT NULL DEFAULT 'unknown', identity_verified INTEGER NOT NULL DEFAULT 0,
        authorization_trusted INTEGER NOT NULL DEFAULT 0, authorization_source_ref TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS analytics_decisions(
        id TEXT PRIMARY KEY, kind TEXT NOT NULL, status TEXT NOT NULL, hypothesis TEXT NOT NULL,
        rationale TEXT NOT NULL, evidence_json TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      INSERT OR IGNORE INTO analytics_meta VALUES('schemaVersion','1');`);
    const opportunityColumns = new Set(
      (
        this.db
          .prepare("PRAGMA table_info(analytics_opportunities)")
          .all() as any[]
      ).map((column) => String(column.name)),
    );
    if (!opportunityColumns.has("identity_key"))
      this.db.exec(
        "ALTER TABLE analytics_opportunities ADD COLUMN identity_key TEXT",
      );
    const claimed = new Set<string>();
    for (const row of this.db
      .prepare(
        "SELECT id,candidate_id,identity_key FROM analytics_opportunities ORDER BY demand_rank IS NULL,demand_rank,created_at,id",
      )
      .all() as any[]) {
      if (row.identity_key) {
        claimed.add(String(row.identity_key));
        continue;
      }
      const identityKey = this.opportunityIdentity(String(row.candidate_id));
      // Preserve uncertain or duplicate legacy rows rather than merging them.
      if (!claimed.has(identityKey)) {
        this.db
          .prepare(
            "UPDATE analytics_opportunities SET identity_key=? WHERE id=?",
          )
          .run(identityKey, row.id);
        claimed.add(identityKey);
      }
    }
    this.db.exec(
      "CREATE UNIQUE INDEX IF NOT EXISTS analytics_opportunities_identity ON analytics_opportunities(identity_key) WHERE identity_key IS NOT NULL",
    );
  }

  private tx<T>(fn: () => T): T {
    const savepoint = `analytics_nested_${this.transactionDepth}`;
    this.db.exec(
      this.transactionDepth ? `SAVEPOINT ${savepoint}` : "BEGIN IMMEDIATE",
    );
    this.transactionDepth++;
    try {
      const result = fn();
      this.transactionDepth--;
      this.db.exec(
        this.transactionDepth ? `RELEASE SAVEPOINT ${savepoint}` : "COMMIT",
      );
      return result;
    } catch (error) {
      this.transactionDepth--;
      this.db.exec(
        this.transactionDepth
          ? `ROLLBACK TO SAVEPOINT ${savepoint}`
          : "ROLLBACK",
      );
      if (this.transactionDepth) this.db.exec(`RELEASE SAVEPOINT ${savepoint}`);
      throw error;
    }
  }

  importObservations(
    input: ObservationInput[],
    run: CollectionRunInput,
  ): ImportResult {
    const normalizedRun = {
      ...run,
      id: required(run.id, "run.id"),
      source: required(run.source, "run.source"),
      observedAt: iso(run.observedAt, "run.observedAt"),
      expectedCount:
        run.expectedCount === undefined
          ? undefined
          : integer(run.expectedCount, "run.expectedCount"),
    };
    const runHash = hash({ ...normalizedRun, input });
    return this.tx(() => {
      const oldRun = this.db
        .prepare("SELECT * FROM analytics_collection_runs WHERE id=?")
        .get(normalizedRun.id);
      if (oldRun) {
        if (oldRun.payload_hash !== runHash)
          throw new Error(
            `collection run ${normalizedRun.id} conflicts with an existing run`,
          );
        return this.importResult(oldRun);
      }
      const now = new Date().toISOString();
      this.db
        .prepare(
          `INSERT INTO analytics_collection_runs(id,source,observed_at,coverage,expected_count,ingested_at,payload_hash)
        VALUES(?,?,?,?,?,?,?)`,
        )
        .run(
          normalizedRun.id,
          normalizedRun.source,
          normalizedRun.observedAt,
          normalizedRun.coverage,
          normalizedRun.expectedCount ?? null,
          now,
          runHash,
        );
      let inserted = 0,
        duplicates = 0,
        conflicts = 0,
        rejected = 0;
      for (const observation of input) {
        try {
          const clean = this.normalizeObservation(
            observation,
            normalizedRun.observedAt,
          );
          const logicalKey = hash({
            platform: clean.platform,
            shop: clean.shop,
            itemId: clean.itemId,
            skuId: clean.skuId,
            saleUnit: clean.saleUnit,
            sourceEntry: clean.sourceEntry,
            field: clean.field,
            fieldVersion: clean.fieldVersion,
            semanticsVersion: clean.semanticsVersion,
            currency: clean.currency,
            observedAt: normalizedRun.observedAt,
          });
          const payloadHash = hash(clean);
          const old = this.db
            .prepare(
              "SELECT id,payload_hash FROM analytics_observations WHERE logical_key=?",
            )
            .get(logicalKey);
          if (old) {
            if (old.payload_hash === payloadHash) duplicates++;
            else {
              conflicts++;
              this.db
                .prepare(
                  `INSERT OR IGNORE INTO analytics_observation_conflicts
                (id,logical_key,existing_observation_id,run_id,incoming_json,incoming_hash,detected_at) VALUES(?,?,?,?,?,?,?)`,
                )
                .run(
                  randomUUID(),
                  logicalKey,
                  old.id,
                  normalizedRun.id,
                  json(clean),
                  payloadHash,
                  now,
                );
            }
            continue;
          }
          const observationId = `obs_${logicalKey.slice(0, 24)}`;
          this.db
            .prepare(
              `INSERT INTO analytics_observations(
            id,run_id,platform,shop,item_id,sku_id,title,brand,category,packaging,sale_unit,source_entry,field,
            field_version,semantics_version,currency,value,price_minor,source_event_at,observed_at,ingested_at,
            raw_json,payload_hash,logical_key,comparison_contract_version) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            )
            .run(
              observationId,
              normalizedRun.id,
              clean.platform,
              clean.shop,
              clean.itemId,
              clean.skuId,
              clean.title,
              clean.brand,
              clean.category,
              clean.packaging,
              clean.saleUnit,
              clean.sourceEntry,
              clean.field,
              clean.fieldVersion,
              clean.semanticsVersion,
              clean.currency,
              clean.value,
              clean.priceMinor,
              clean.sourceEventAt,
              normalizedRun.observedAt,
              now,
              json(clean.raw),
              payloadHash,
              logicalKey,
              CONTRACT_VERSION,
            );
          inserted++;
        } catch {
          rejected++;
        }
      }
      this.db
        .prepare(
          `UPDATE analytics_collection_runs SET received_count=?,inserted_count=?,duplicate_count=?,conflict_count=?,rejected_count=? WHERE id=?`,
        )
        .run(
          input.length,
          inserted,
          duplicates,
          conflicts,
          rejected,
          normalizedRun.id,
        );
      return {
        runId: normalizedRun.id,
        received: input.length,
        inserted,
        duplicates,
        conflicts,
        rejected,
        status:
          conflicts ||
          rejected ||
          (normalizedRun.expectedCount !== undefined &&
            normalizedRun.expectedCount !== input.length)
            ? "needs-review"
            : "accepted",
      };
    });
  }

  private normalizeObservation(input: ObservationInput, observedAt: string) {
    if (!Number.isFinite(input.value) || input.value < 0)
      throw new Error("value must be a non-negative finite number");
    const priceMinor =
      input.priceMinor == null ? null : integer(input.priceMinor, "priceMinor");
    return {
      platform: required(input.platform, "platform"),
      shop: required(input.shop, "shop"),
      itemId: required(input.itemId, "itemId"),
      skuId: required(input.skuId, "skuId"),
      title: required(input.title, "title"),
      brand: input.brand?.trim() || null,
      category: input.category?.trim() || null,
      packaging: input.packaging?.trim() || null,
      saleUnit: required(input.saleUnit, "saleUnit"),
      sourceEntry: required(input.sourceEntry, "sourceEntry"),
      field: required(input.field, "field"),
      fieldVersion: required(input.fieldVersion, "fieldVersion"),
      semanticsVersion: required(input.semanticsVersion, "semanticsVersion"),
      currency: required(input.currency, "currency").toUpperCase(),
      value: input.value,
      priceMinor,
      sourceEventAt: input.sourceEventAt
        ? iso(input.sourceEventAt, "sourceEventAt")
        : null,
      observedAt,
      raw: input.raw ?? input,
    };
  }

  private importResult(row: any): ImportResult {
    return {
      runId: String(row.id),
      received: Number(row.received_count),
      inserted: Number(row.inserted_count),
      duplicates: Number(row.duplicate_count),
      conflicts: Number(row.conflict_count),
      rejected: Number(row.rejected_count),
      status:
        Number(row.conflict_count) ||
        Number(row.rejected_count) ||
        (row.expected_count !== null &&
          Number(row.expected_count) !== Number(row.received_count))
          ? "needs-review"
          : "accepted",
    };
  }

  listMarket(query: MarketQuery): Page<MarketCandidate> {
    const p = paging(query.page, query.pageSize);
    const rows = this.filteredObservations(query);
    if (query.scope === "historical") {
      const latest = new Map<string, any>();
      for (const row of rows) latest.set(this.seriesKey(row), row);
      const candidates = [...latest.values()].map((row) =>
        this.historicalCandidate(row),
      );
      candidates.sort(
        (a, b) =>
          (b.valueIndexMinor ?? -1) - (a.valueIndexMinor ?? -1) ||
          b.end.value - a.end.value ||
          this.candidateTieKey(a).localeCompare(this.candidateTieKey(b)),
      );
      const result = {
        ...this.page(candidates, p),
        facets: this.facets(candidates),
      };
      return candidates.length
        ? result
        : {
            ...result,
            available: false,
            unavailableReason: "no historical observations satisfy the filters",
          };
    }
    if (!query.startAt || !query.endAt || query.toleranceMs === undefined) {
      return {
        ...this.page([], p),
        available: false,
        unavailableReason:
          "recent scope requires startAt, endAt and toleranceMs",
      };
    }
    const startAt = Date.parse(iso(query.startAt, "startAt"));
    const endAt = Date.parse(iso(query.endAt, "endAt"));
    const tolerance = integer(query.toleranceMs, "toleranceMs");
    if (endAt <= startAt) throw new Error("endAt must be later than startAt");
    const grouped = new Map<string, any[]>();
    for (const row of rows) {
      const bucket = grouped.get(this.comparisonGroupKey(row)) ?? [];
      bucket.push(row);
      grouped.set(this.comparisonGroupKey(row), bucket);
    }
    const candidates: MarketCandidate[] = [];
    for (const bucket of grouped.values()) {
      const start = this.endpoint(bucket, startAt, tolerance);
      const end = this.endpoint(bucket, endAt, tolerance);
      if (!end) continue;
      const candidate = this.recentCandidate(start, end);
      if (!query.status || candidate.status === query.status)
        candidates.push(candidate);
    }
    candidates.sort((a, b) => {
      const rank = (x: MarketCandidate) =>
        x.status === "comparable" ? 0 : x.status === "anomalous" ? 1 : 2;
      return (
        rank(a) - rank(b) ||
        (b.valueIndexMinor ?? -1) - (a.valueIndexMinor ?? -1) ||
        (b.delta ?? -Infinity) - (a.delta ?? -Infinity) ||
        this.candidateTieKey(a).localeCompare(this.candidateTieKey(b))
      );
    });
    const result = {
      ...this.page(candidates, p),
      facets: this.facets(candidates),
    };
    if (!candidates.length)
      return {
        ...result,
        available: false,
        unavailableReason:
          "no observations satisfy both fixed window boundaries",
      };
    if (
      candidates.every(
        (candidate) =>
          candidate.status === "incomparable" &&
          candidate.reason === "missing fixed-window baseline",
      )
    )
      return {
        ...result,
        available: false,
        unavailableReason: "fixed-window baseline is missing",
      };
    return result;
  }

  private filteredObservations(query: MarketQuery): any[] {
    const coverage =
      query.coverage ?? (query.scope === "historical" ? "all" : "complete");
    const clauses = [
      "c.conflict_count=0",
      "c.rejected_count=0",
      "(c.expected_count IS NULL OR c.expected_count=c.received_count)",
      "NOT EXISTS (SELECT 1 FROM analytics_observation_conflicts x WHERE x.logical_key=o.logical_key)",
    ];
    const params: any[] = [];
    if (coverage !== "all") {
      clauses.unshift("c.coverage=?");
      params.push(coverage);
    }
    for (const [column, value] of [
      ["o.platform", query.platform],
      ["o.shop", query.shop],
      ["o.brand", query.brand],
      ["o.category", query.category],
      ["o.sale_unit", query.saleUnit],
      ["o.source_entry", query.sourceEntry],
    ] as const) {
      if (value !== undefined) {
        clauses.push(`${column}=?`);
        params.push(value);
      }
    }
    if (query.search?.trim()) {
      clauses.push(
        "(o.title LIKE ? ESCAPE '\\' OR o.brand LIKE ? ESCAPE '\\' OR o.item_id LIKE ? ESCAPE '\\' OR o.sku_id LIKE ? ESCAPE '\\')",
      );
      const needle = likePattern(query.search.trim());
      params.push(needle, needle, needle, needle);
    }
    if (query.minPriceMinor !== undefined) {
      clauses.push("o.price_minor>=?");
      params.push(integer(query.minPriceMinor, "minPriceMinor"));
    }
    if (query.maxPriceMinor !== undefined) {
      clauses.push("o.price_minor<=?");
      params.push(integer(query.maxPriceMinor, "maxPriceMinor"));
    }
    return this.db
      .prepare(
        `SELECT o.*,c.coverage AS collection_coverage FROM analytics_observations o JOIN analytics_collection_runs c ON c.id=o.run_id WHERE ${clauses.join(" AND ")} ORDER BY o.observed_at,o.id`,
      )
      .all(...params);
  }

  private identityKey(r: any): string {
    return [r.platform, r.shop, r.item_id, r.sku_id].map(String).join("\u001f");
  }
  private candidateTieKey(candidate: MarketCandidate): string {
    return [
      candidate.platform,
      candidate.shop,
      candidate.itemId,
      candidate.skuId,
      candidate.sourceEntry,
      candidate.field,
      candidate.saleUnit,
    ].join("\u001f");
  }
  private comparisonGroupKey(r: any): string {
    return [this.identityKey(r), r.source_entry, r.field]
      .map(String)
      .join("\u001f");
  }
  private seriesKey(r: any): string {
    return [
      this.identityKey(r),
      r.sale_unit,
      r.source_entry,
      r.field,
      r.field_version,
      r.semantics_version,
      r.currency,
      r.packaging,
    ]
      .map(String)
      .join("\u001f");
  }
  private endpoint(rows: any[], target: number, tolerance: number): any | null {
    return (
      rows
        .filter(
          (r) =>
            Math.abs(Date.parse(String(r.observed_at)) - target) <= tolerance,
        )
        .sort(
          (a, b) =>
            Math.abs(Date.parse(String(a.observed_at)) - target) -
              Math.abs(Date.parse(String(b.observed_at)) - target) ||
            Date.parse(String(a.observed_at)) -
              Date.parse(String(b.observed_at)) ||
            this.seriesKey(a).localeCompare(this.seriesKey(b)) ||
            String(a.id).localeCompare(String(b.id)),
        )[0] ?? null
    );
  }

  private evidence(r: any): ObservationEvidence {
    return {
      id: String(r.id),
      runId: String(r.run_id),
      observedAt: String(r.observed_at),
      value: Number(r.value),
      priceMinor: r.price_minor === null ? null : Number(r.price_minor),
      sourceEventAt:
        r.source_event_at === null ? null : String(r.source_event_at),
      raw: decoded(r.raw_json),
      coverage: r.collection_coverage,
    };
  }

  private base(r: any) {
    const raw = decoded(r.raw_json) as any;
    return {
      platform: String(r.platform),
      shop: String(r.shop),
      itemId: String(r.item_id),
      skuId: String(r.sku_id),
      title: String(r.title),
      brand: r.brand === null ? null : String(r.brand),
      category: r.category === null ? null : String(r.category),
      packaging: r.packaging === null ? null : String(r.packaging),
      saleUnit: String(r.sale_unit),
      sourceEntry: String(r.source_entry),
      field: String(r.field),
      fieldVersion: String(r.field_version),
      semanticsVersion: String(r.semantics_version),
      currency: String(r.currency),
      coverage: r.collection_coverage,
      sampleScope:
        typeof raw?.sampleScope === "string" ? raw.sampleScope : null,
      evidencePath:
        typeof raw?.evidencePath === "string" ? raw.evidencePath : null,
    };
  }

  private historicalCandidate(row: any): MarketCandidate {
    const end = this.evidence(row);
    return {
      id: `historical:${row.id}`,
      ...this.base(row),
      scope: "historical",
      status: "incomparable",
      reason: "cumulative value has no fixed-window baseline",
      start: null,
      end,
      delta: null,
      valueIndexMinor:
        end.priceMinor === null ? null : end.value * end.priceMinor,
    };
  }

  private recentCandidate(start: any | null, end: any): MarketCandidate {
    if (!start)
      return {
        id: `recent:missing:${end.id}`,
        ...this.base(end),
        scope: "recent",
        status: "incomparable",
        reason: "missing fixed-window baseline",
        start: null,
        end: this.evidence(end),
        delta: null,
        valueIndexMinor: null,
      };
    if (this.seriesKey(start) !== this.seriesKey(end))
      return {
        id: `recent:${start.id}:${end.id}`,
        ...this.base(end),
        scope: "recent",
        status: "incomparable",
        reason:
          "comparison contract changed (packaging, unit, entry, field semantics, or currency)",
        start: this.evidence(start),
        end: this.evidence(end),
        delta: null,
        valueIndexMinor: null,
      };
    const delta = Number(end.value) - Number(start.value);
    if (delta < 0)
      return {
        id: `recent:${start.id}:${end.id}`,
        ...this.base(end),
        scope: "recent",
        status: "anomalous",
        reason: "cumulative value decreased",
        start: this.evidence(start),
        end: this.evidence(end),
        delta,
        valueIndexMinor: null,
      };
    const price = end.price_minor === null ? null : Number(end.price_minor);
    return {
      id: `recent:${start.id}:${end.id}`,
      ...this.base(end),
      scope: "recent",
      status: "comparable",
      reason: price === null ? "price missing; value index unavailable" : null,
      start: this.evidence(start),
      end: this.evidence(end),
      delta,
      valueIndexMinor: price === null ? null : delta * price,
    };
  }

  private page<T>(
    items: T[],
    p: { page: number; pageSize: number; offset: number },
  ): Page<T> {
    return {
      items: items.slice(p.offset, p.offset + p.pageSize),
      page: p.page,
      pageSize: p.pageSize,
      total: items.length,
      pages: Math.ceil(items.length / p.pageSize),
      available: true,
    };
  }

  private facets(
    items: MarketCandidate[],
  ): NonNullable<Page<MarketCandidate>["facets"]> {
    const result: NonNullable<Page<MarketCandidate>["facets"]> = {};
    for (const field of ["brand", "category", "shop", "status"] as const) {
      const counts = new Map<string, number>();
      for (const item of items) {
        const value = String(item[field] ?? "未标注");
        counts.set(value, (counts.get(value) ?? 0) + 1);
      }
      result[field] = [...counts]
        .map(([value, count]) => ({
          value,
          count,
          denominator: items.length,
          percent: items.length ? count / items.length : 0,
        }))
        .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
    }
    return result;
  }

  getEvidence(id: string): EvidenceResult | null {
    const [scope, startId, endId] = id.split(":");
    if (
      (scope !== "historical" && scope !== "recent") ||
      (scope === "historical" && !startId) ||
      (scope === "recent" && (!startId || !endId))
    )
      return null;
    const end = this.db
      .prepare("SELECT * FROM analytics_observations WHERE id=?")
      .get(scope === "historical" ? startId : endId);
    if (!end) return null;
    const start =
      scope === "recent" && startId !== "missing"
        ? this.db
            .prepare("SELECT * FROM analytics_observations WHERE id=?")
            .get(startId)
        : null;
    const candidate =
      scope === "historical"
        ? this.historicalCandidate(end)
        : this.recentCandidate(start, end);
    const observations = this.db
      .prepare(
        `SELECT * FROM analytics_observations WHERE platform=? AND shop=? AND item_id=? AND sku_id=? ORDER BY observed_at,id`,
      )
      .all(end.platform, end.shop, end.item_id, end.sku_id)
      .map((r) => this.evidence(r));
    const conflicts = this.db
      .prepare(
        `SELECT x.* FROM analytics_observation_conflicts x JOIN analytics_observations o ON o.id=x.existing_observation_id WHERE o.platform=? AND o.shop=? AND o.item_id=? AND o.sku_id=? ORDER BY x.detected_at,x.id`,
      )
      .all(end.platform, end.shop, end.item_id, end.sku_id)
      .map((r) => ({
        id: String(r.id),
        runId: String(r.run_id),
        detectedAt: String(r.detected_at),
        incoming: decoded(r.incoming_json),
      }));
    return { candidate, observations, conflicts };
  }

  listOpportunities(query: OpportunityQuery = {}): Page<Opportunity> {
    const p = paging(query.page, query.pageSize),
      clauses = ["1=1"],
      params: any[] = [];
    for (const [column, value] of [
      ["brand", query.brand],
      ["route", query.route],
      ["status", query.status],
    ] as const)
      if (value !== undefined) {
        clauses.push(`${column}=?`);
        params.push(value);
      }
    if (query.search?.trim()) {
      clauses.push(
        "(brand LIKE ? ESCAPE '\\' OR next_action LIKE ? ESCAPE '\\' OR reason LIKE ? ESCAPE '\\' OR candidate_id LIKE ? ESCAPE '\\' OR EXISTS (SELECT 1 FROM analytics_observations o WHERE (o.title LIKE ? ESCAPE '\\' OR o.sku_id LIKE ? ESCAPE '\\') AND substr(analytics_opportunities.candidate_id,-length(o.id))=o.id))",
      );
      const needle = likePattern(query.search.trim());
      params.push(needle, needle, needle, needle, needle, needle);
    }
    const rows = this.db
      .prepare(
        `SELECT * FROM analytics_opportunities WHERE ${clauses.join(" AND ")} ORDER BY demand_rank IS NULL,demand_rank,id`,
      )
      .all(...params);
    return this.page(
      rows.map((r) => this.opportunity(r)),
      p,
    );
  }

  upsertOpportunity(candidateId: string, seed: OpportunitySeed): Opportunity {
    candidateId = required(candidateId, "candidateId");
    const identityKey = this.opportunityIdentity(candidateId);
    return this.tx(() => {
      const old: any = this.db
        .prepare(
          "SELECT * FROM analytics_opportunities WHERE identity_key=? OR candidate_id=? ORDER BY identity_key=? DESC LIMIT 1",
        )
        .get(identityKey, candidateId, identityKey);
      const now = new Date().toISOString();
      if (!old) {
        const id = `opp_${hash(identityKey).slice(0, 24)}`;
        this.db
          .prepare(
            `INSERT INTO analytics_opportunities(id,identity_key,candidate_id,brand,route,status,owner,next_action,reason,demand_rank,authorization_status,own_match_status,decision_id,revision,created_at,updated_at)
             VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?)`,
          )
          .run(
            id,
            identityKey,
            candidateId,
            seed.brand ?? null,
            seed.route,
            seed.status ?? "open",
            seed.owner ?? null,
            required(seed.nextAction, "nextAction"),
            required(seed.reason, "reason"),
            seed.demandRank ?? null,
            seed.authorizationStatus,
            seed.ownMatchStatus,
            seed.decisionId ?? null,
            now,
            now,
          );
        this.linkOpportunityEvidence(id, candidateId);
        return this.opportunity(
          this.db
            .prepare("SELECT * FROM analytics_opportunities WHERE id=?")
            .get(id),
        );
      }
      const machine = {
        identity_key: identityKey,
        candidate_id: candidateId,
        brand: seed.brand ?? null,
        route: seed.route,
        next_action: required(seed.nextAction, "nextAction"),
        demand_rank: seed.demandRank ?? null,
        authorization_status: seed.authorizationStatus,
        own_match_status: seed.ownMatchStatus,
      };
      const candidateOwner: any = this.db
        .prepare("SELECT id FROM analytics_opportunities WHERE candidate_id=?")
        .get(candidateId);
      if (candidateOwner && String(candidateOwner.id) !== String(old.id))
        machine.candidate_id = String(old.candidate_id);
      const changed = Object.entries(machine).some(
        ([key, value]) => (old[key] ?? null) !== value,
      );
      if (changed)
        this.db
          .prepare(
            `UPDATE analytics_opportunities SET identity_key=?,candidate_id=?,brand=?,route=?,next_action=?,demand_rank=?,authorization_status=?,own_match_status=?,revision=revision+1,updated_at=? WHERE id=?`,
          )
          .run(
            machine.identity_key,
            machine.candidate_id,
            machine.brand,
            machine.route,
            machine.next_action,
            machine.demand_rank,
            machine.authorization_status,
            machine.own_match_status,
            now,
            old.id,
          );
      this.linkOpportunityEvidence(String(old.id), candidateId);
      return this.opportunity(
        this.db
          .prepare("SELECT * FROM analytics_opportunities WHERE id=?")
          .get(old.id),
      );
    });
  }

  private opportunityIdentity(candidateId: string): string {
    const evidence = /^(?:historical|recent):/.test(candidateId)
      ? this.getEvidence(candidateId)?.candidate
      : null;
    if (!evidence) return `legacy_${hash(candidateId)}`;
    const normalized = (value: string | null) =>
      (value ?? "").normalize("NFKC").trim();
    return `market_${hash({
      platform: normalized(evidence.platform),
      shop: normalized(evidence.shop),
      itemId: normalized(evidence.itemId),
      skuId: normalized(evidence.skuId),
      packaging: normalized(evidence.packaging),
      saleUnit: normalized(evidence.saleUnit),
    })}`;
  }

  private linkOpportunityEvidence(
    opportunityId: string,
    candidateId: string,
  ): void {
    const evidence = this.getEvidence(candidateId);
    if (!evidence) return;
    const observations = [
      evidence.candidate.start,
      evidence.candidate.end,
    ].filter(
      (observation): observation is ObservationEvidence => observation !== null,
    );
    for (const observation of observations)
      this.db
        .prepare(
          "INSERT OR IGNORE INTO analytics_opportunity_evidence(opportunity_id,observation_id,role) VALUES(?,?,'market-observation')",
        )
        .run(opportunityId, observation.id);
  }

  updateOpportunity(id: string, patch: OpportunityPatch): Opportunity {
    const allowed = [
      "route",
      "status",
      "owner",
      "nextAction",
      "reason",
      "decisionId",
    ] as const;
    const entries = allowed.filter((key) => patch[key] !== undefined);
    if (!entries.length) throw new Error("opportunity patch is empty");
    return this.tx(() => {
      const old = this.db
        .prepare("SELECT * FROM analytics_opportunities WHERE id=?")
        .get(id);
      if (!old) throw new Error(`opportunity ${id} not found`);
      if (
        patch.expectedRevision !== undefined &&
        Number(old.revision) !== patch.expectedRevision
      )
        throw new Error("opportunity revision conflict");
      const columns: Record<string, string> = {
        nextAction: "next_action",
        decisionId: "decision_id",
        route: "route",
        status: "status",
        owner: "owner",
        reason: "reason",
      };
      const sets = entries.map((key) => `${columns[key]}=?`);
      const values: any[] = entries.map((key) => patch[key] ?? null);
      if (
        entries.every(
          (key, index) => (old[columns[key]] ?? null) === values[index],
        )
      )
        return this.opportunity(old);
      this.db
        .prepare(
          `UPDATE analytics_opportunities SET ${sets.join(",")},revision=revision+1,updated_at=? WHERE id=?`,
        )
        .run(...values, new Date().toISOString(), id);
      return this.opportunity(
        this.db
          .prepare("SELECT * FROM analytics_opportunities WHERE id=?")
          .get(id),
      );
    });
  }

  private opportunity(r: any): Opportunity {
    return {
      id: String(r.id),
      identityKey: String(
        r.identity_key ?? `legacy_${hash(String(r.candidate_id))}`,
      ),
      candidateId: String(r.candidate_id),
      brand: r.brand === null ? null : String(r.brand),
      route: r.route,
      status: r.status,
      owner: r.owner === null ? null : String(r.owner),
      nextAction: String(r.next_action),
      reason: String(r.reason),
      demandRank: r.demand_rank === null ? null : Number(r.demand_rank),
      authorizationStatus: r.authorization_status,
      ownMatchStatus: r.own_match_status,
      decisionId: r.decision_id === null ? null : String(r.decision_id),
      revision: Number(r.revision),
      updatedAt: String(r.updated_at),
    };
  }

  listBrands(): BrandSummary[] {
    const names = this.db
      .prepare(
        `SELECT brand FROM analytics_brand_tasks UNION SELECT brand FROM analytics_opportunities WHERE brand IS NOT NULL AND trim(brand)<>'' ORDER BY brand`,
      )
      .all();
    return names.map((name) => {
      const brand = String(name.brand),
        task: any = this.db
          .prepare("SELECT * FROM analytics_brand_tasks WHERE brand=?")
          .get(brand);
      const counts: any = this.db
        .prepare(
          "SELECT count(*) total,sum(CASE WHEN route='bd' AND status='open' THEN 1 ELSE 0 END) unlockable FROM analytics_opportunities WHERE brand=?",
        )
        .get(brand);
      const now = Date.now(),
        verifiedAt = task?.authorization_verified_at
          ? Date.parse(String(task.authorization_verified_at))
          : NaN,
        validUntil = task?.authorization_valid_until
          ? Date.parse(String(task.authorization_valid_until))
          : NaN;
      const stale =
        Number.isFinite(verifiedAt) &&
        now - verifiedAt > AUTHORIZATION_FRESHNESS_MS;
      const readiness: BrandSummary["readiness"] = !task?.identity_verified
        ? "needs-identity-review"
        : !task.authorization_trusted ||
            !task.scope ||
            !Number.isFinite(verifiedAt) ||
            !Number.isFinite(validUntil) ||
            stale
          ? "needs-authorization"
          : validUntil <= now
            ? "expired"
            : "ready";
      return {
        brand,
        status: task?.status ?? "pending",
        owner: task?.owner ?? null,
        nextFollowUpAt: task?.next_follow_up_at ?? null,
        resultReason: task?.result_reason ?? null,
        scope: task?.scope ?? null,
        authorizationValidUntil: task?.authorization_valid_until ?? null,
        authorizationVerifiedAt: task?.authorization_verified_at ?? null,
        identitySource: task?.identity_source ?? "unknown",
        identityVerified: Boolean(task?.identity_verified),
        opportunityCount: Number(counts.total),
        unlockableCount: Number(counts.unlockable ?? 0),
        readiness,
        updatedAt: task?.updated_at ?? null,
      };
    });
  }

  updateBrandTask(brand: string, patch: BrandTaskPatch): BrandSummary {
    brand = required(brand, "brand");
    if (patch.authorizationValidUntil)
      iso(patch.authorizationValidUntil, "authorizationValidUntil");
    if (patch.authorizationVerifiedAt)
      iso(patch.authorizationVerifiedAt, "authorizationVerifiedAt");
    if (patch.nextFollowUpAt) iso(patch.nextFollowUpAt, "nextFollowUpAt");
    const now = new Date().toISOString(),
      old: any = this.db
        .prepare("SELECT * FROM analytics_brand_tasks WHERE brand=?")
        .get(brand);
    const value: any = {
      status: "pending",
      owner: null,
      next_follow_up_at: null,
      result_reason: null,
      scope: null,
      authorization_valid_until: null,
      authorization_verified_at: null,
      identity_source: "unknown",
      identity_verified: 0,
      authorization_trusted: 0,
      authorization_source_ref: null,
      ...old,
    };
    const mapping: Record<string, string> = {
      nextFollowUpAt: "next_follow_up_at",
      resultReason: "result_reason",
      authorizationValidUntil: "authorization_valid_until",
      authorizationVerifiedAt: "authorization_verified_at",
      identitySource: "identity_source",
      identityVerified: "identity_verified",
      status: "status",
      owner: "owner",
      scope: "scope",
    };
    for (const [key, v] of Object.entries(patch))
      value[mapping[key]] = key === "identityVerified" ? (v ? 1 : 0) : v;
    this.db
      .prepare(
        `INSERT INTO analytics_brand_tasks(brand,status,owner,next_follow_up_at,result_reason,scope,authorization_valid_until,authorization_verified_at,identity_source,identity_verified,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(brand) DO UPDATE SET status=excluded.status,owner=excluded.owner,next_follow_up_at=excluded.next_follow_up_at,result_reason=excluded.result_reason,scope=excluded.scope,authorization_valid_until=excluded.authorization_valid_until,authorization_verified_at=excluded.authorization_verified_at,identity_source=excluded.identity_source,identity_verified=excluded.identity_verified,updated_at=excluded.updated_at`,
      )
      .run(
        brand,
        value.status,
        value.owner,
        value.next_follow_up_at,
        value.result_reason,
        value.scope,
        value.authorization_valid_until,
        value.authorization_verified_at,
        value.identity_source,
        value.identity_verified,
        old?.created_at ?? now,
        now,
      );
    return this.listBrands().find((entry) => entry.brand === brand)!;
  }

  projectBrandAuthorization(
    brand: string,
    projection: BrandAuthorizationProjection,
  ): BrandSummary {
    brand = required(brand, "brand");
    const scope = required(projection.scope, "scope");
    const sourceRef = required(projection.sourceRef, "sourceRef");
    if (projection.source !== "platform")
      throw new Error("only a platform authorization projection is trusted");
    const verifiedAt = iso(projection.verifiedAt, "verifiedAt");
    const validUntil = iso(projection.validUntil, "validUntil");
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO analytics_brand_tasks(brand,status,scope,authorization_valid_until,authorization_verified_at,identity_source,identity_verified,authorization_trusted,authorization_source_ref,created_at,updated_at)
         VALUES(?,?,?,?,?,'api',1,1,?,?,?)
         ON CONFLICT(brand) DO UPDATE SET scope=excluded.scope,authorization_valid_until=excluded.authorization_valid_until,authorization_verified_at=excluded.authorization_verified_at,authorization_trusted=1,authorization_source_ref=excluded.authorization_source_ref,updated_at=excluded.updated_at`,
      )
      .run(
        brand,
        "verification",
        scope,
        validUntil,
        verifiedAt,
        sourceRef,
        now,
        now,
      );
    return this.listBrands().find((entry) => entry.brand === brand)!;
  }

  health(): AnalyticsHealth {
    const r: any = this.db
      .prepare(
        `SELECT count(*) runs,sum(coverage='complete') complete_runs,sum(coverage='partial') partial_runs,sum(conflict_count) conflicts,max(observed_at) latest FROM analytics_collection_runs`,
      )
      .get();
    const observations = Number(
      (
        this.db
          .prepare("SELECT count(*) n FROM analytics_observations")
          .get() as any
      ).n,
    );
    const runs = Number(r.runs),
      conflicts = Number(r.conflicts ?? 0),
      partialRuns = Number(r.partial_runs ?? 0);
    return {
      status: !runs
        ? "empty"
        : conflicts || partialRuns
          ? "needs-review"
          : "ok",
      runs,
      completeRuns: Number(r.complete_runs ?? 0),
      partialRuns,
      observations,
      conflicts,
      latestObservedAt: r.latest === null ? null : String(r.latest),
    };
  }

  overview(): AnalyticsOverview {
    const marketCandidates = Number(
      (
        this.db
          .prepare(
            "SELECT count(DISTINCT platform||char(31)||shop||char(31)||item_id||char(31)||sku_id) n FROM analytics_observations",
          )
          .get() as any
      ).n,
    );
    const opportunities: any = this.db
      .prepare(
        `SELECT count(*) n,sum(route='prepare' AND status='open') ready,sum(route='bd' AND status='open') bd FROM analytics_opportunities`,
      )
      .get();
    const brandsNeedingAction = this.listBrands().filter(
      (b) => b.readiness !== "ready",
    ).length;
    return {
      marketCandidates,
      // A windowless overview cannot choose endpoints without violating the
      // fixed-window contract. Call listMarket with an explicit window.
      recentComparable: null,
      recentAnomalous: null,
      opportunities: Number(opportunities.n),
      readyOpportunities: Number(opportunities.ready ?? 0),
      bdOpportunities: Number(opportunities.bd ?? 0),
      brandsNeedingAction,
    };
  }
}
