import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

export type OrderDateField = "placedAt" | "paidAt" | "completedAt";
export type RefundView = "event_period" | "original_order_period";
export type MetricState = "imported" | "reconciled" | "accepted_for_metric";

export interface OrderImportPayload {
  schemaVersion: 1;
  source: string;
  sourceShopId: string;
  sourceFileId: string;
  fileSha256: string;
  exportedAt: string;
  timezone: string;
  currency: string;
  orders: Array<{
    orderId: string;
    version: number;
    placedAt: string;
    paidAt?: string | null;
    completedAt?: string | null;
    cancelledAt?: string | null;
    status: string;
    buyerAnonymousId?: string | null;
    merchandiseCents: number;
    discountCents: number;
    shippingCents: number;
    taxCents: number;
    unallocatedCents: number;
    paidCents: number;
    lines: Array<{
      lineId: string;
      platform: string;
      shopId: string;
      itemId: string;
      skuId: string;
      title?: string | null;
      quantity: number;
      grossCents: number;
      discountCents: number;
      paidCents: number;
    }>;
  }>;
  refunds?: Array<{
    refundId: string;
    version: number;
    orderId: string;
    lineId?: string | null;
    occurredAt: string;
    status: "pending" | "completed" | "rejected" | "cancelled";
    amountCents: number;
  }>;
  listings?: Array<{
    listingIdentityId: string;
    platform: string;
    shopId: string;
    itemId: string;
    skuId: string;
    validFrom: string;
    validTo?: string | null;
    firstObservedOnSaleAt: string;
    batchId: string;
    membership: "new" | "maintenance" | "rejection_repair";
  }>;
}

export interface ImportResult {
  runId: number;
  state: "imported" | "duplicate";
  inserted: number;
  revised: number;
  ignoredOlder: number;
  refundsInserted: number;
  refundsRevised: number;
  listingsInserted: number;
}

export interface ReconcilePayload {
  reconciliationId: string;
  source: string;
  from: string;
  to: string;
  timezone: string;
  currency: string;
  dateField: OrderDateField;
  refundView: RefundView;
  expected: {
    orderCount: number;
    grossCents: number;
    refundCents: number;
    netCents: number;
  };
  tolerance: { absoluteCents: number; relativeBps: number };
  differencesExplained?: string[];
  acceptForMetric?: {
    metric: "target_turnover";
    confirmedBy: string;
    confirmedAt: string;
    basis: string;
  };
}

export interface Reconciliation {
  reconciliationId: string;
  state: MetricState | "rejected";
  actual: {
    orderCount: number;
    grossCents: number;
    refundCents: number;
    netCents: number;
  };
  expected: ReconcilePayload["expected"];
  differences: {
    orderCount: number;
    grossCents: number;
    refundCents: number;
    netCents: number;
  };
}

export interface OrderSummaryQuery {
  from: string;
  to: string;
  dateField?: OrderDateField;
  refundView?: RefundView;
  timezone?: string;
  currency?: string;
  source?: string;
  shopId?: string;
}

export interface OrderSummary {
  availability: "available" | "unavailable";
  state: MetricState | "mixed" | "unavailable";
  orderCount: number | null;
  grossCents: number | null;
  refundCents: number | null;
  netCents: number | null;
  acceptedForTarget: boolean;
  acceptedNetCents: number | null;
  unmatchedLines: number | null;
  ambiguousLines: number | null;
}

export interface OrderListQuery {
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}
export interface OrderView {
  orderId: string;
  version: number;
  placedAt: string;
  status: string;
  paidCents: number;
  lines: Array<{
    lineId: string;
    skuId: string;
    paidCents: number;
    batchState: "matched" | "ambiguous" | "unmatched";
    batchId: string | null;
  }>;
}
export interface BatchListQuery {
  from?: string;
  to?: string;
  refundView?: RefundView;
  source?: string;
  shopId?: string;
}
export interface ListingProjectionPayload {
  schemaVersion: 1;
  source: string;
  projectionId: string;
  observedAt: string;
  listings: NonNullable<OrderImportPayload["listings"]>;
}
export interface BatchResult {
  batchId: string;
  orderCount: number;
  lineCount: number;
  grossCents: number;
  refundCents: number;
  netCents: number;
}
export interface GoalPayload {
  year: number;
  targetCents: number;
  currentCents: number;
  asOf: string;
  source: string;
  confirmation: { confirmedBy: string; confirmedAt: string; basis: string };
  historicalContextCents?: number | null;
}
export interface Goal extends GoalPayload {
  remainingCents: number;
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,199}$/;
const SHA = /^[a-fA-F0-9]{64}$/;
const int = (v: unknown, name: string, min = 0) => {
  if (!Number.isSafeInteger(v) || Number(v) < min)
    throw new Error(`${name} must be a safe integer >= ${min}`);
  return Number(v);
};
const signedInt = (v: unknown, name: string) => {
  if (!Number.isSafeInteger(v))
    throw new Error(`${name} must be a safe integer`);
  return Number(v);
};
const id = (v: unknown, name: string) => {
  if (typeof v !== "string" || !ID.test(v))
    throw new Error(`${name} is not a safe stable ID`);
  return v;
};
const text = (v: unknown, name: string) => {
  if (typeof v !== "string" || !v.trim() || v.length > 500)
    throw new Error(`${name} is required`);
  return v;
};
const iso = (v: unknown, name: string) => {
  text(v, name);
  if (
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/.test(
      String(v),
    ) ||
    !Number.isFinite(Date.parse(String(v)))
  )
    throw new Error(`${name} must be ISO-8601 with an offset`);
  return String(v);
};
const jsonHash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const parse = <T>(v: unknown): T => JSON.parse(String(v)) as T;

export class AnalyticsOrders {
  constructor(public db: DatabaseSync) {
    db.exec(`PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS analytics_order_import_run(id INTEGER PRIMARY KEY AUTOINCREMENT,source TEXT NOT NULL,file_id TEXT NOT NULL,file_sha256 TEXT NOT NULL,exported_at TEXT NOT NULL,timezone TEXT NOT NULL,currency TEXT NOT NULL,payload_hash TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(source,file_id));
      CREATE TABLE IF NOT EXISTS analytics_order(order_key TEXT PRIMARY KEY,source TEXT NOT NULL,order_id TEXT NOT NULL,version INTEGER NOT NULL,payload TEXT NOT NULL,payload_hash TEXT NOT NULL,placed_at TEXT NOT NULL,paid_at TEXT,completed_at TEXT,cancelled_at TEXT,status TEXT NOT NULL,currency TEXT NOT NULL,merchandise_cents INTEGER NOT NULL,discount_cents INTEGER NOT NULL,shipping_cents INTEGER NOT NULL,tax_cents INTEGER NOT NULL,paid_cents INTEGER NOT NULL,import_run_id INTEGER NOT NULL REFERENCES analytics_order_import_run(id),UNIQUE(source,order_id));
      CREATE TABLE IF NOT EXISTS analytics_order_line(line_key TEXT PRIMARY KEY,order_key TEXT NOT NULL REFERENCES analytics_order(order_key) ON DELETE CASCADE,source TEXT NOT NULL,order_id TEXT NOT NULL,line_id TEXT NOT NULL,platform TEXT NOT NULL,shop_id TEXT NOT NULL,item_id TEXT NOT NULL,sku_id TEXT NOT NULL,title TEXT,quantity INTEGER NOT NULL,gross_cents INTEGER NOT NULL,discount_cents INTEGER NOT NULL,paid_cents INTEGER NOT NULL,UNIQUE(source,order_id,line_id));
      CREATE TABLE IF NOT EXISTS analytics_refund(refund_key TEXT PRIMARY KEY,source TEXT NOT NULL,refund_id TEXT NOT NULL,version INTEGER NOT NULL,order_id TEXT NOT NULL,line_id TEXT,occurred_at TEXT NOT NULL,status TEXT NOT NULL,amount_cents INTEGER NOT NULL,payload_hash TEXT NOT NULL,import_run_id INTEGER NOT NULL REFERENCES analytics_order_import_run(id),UNIQUE(source,refund_id));
      CREATE TABLE IF NOT EXISTS analytics_listing_identity(id TEXT PRIMARY KEY,platform TEXT NOT NULL,shop_id TEXT NOT NULL,item_id TEXT NOT NULL,sku_id TEXT NOT NULL,valid_from TEXT NOT NULL,valid_to TEXT,first_on_sale_at TEXT NOT NULL,batch_id TEXT NOT NULL,membership TEXT NOT NULL,import_run_id INTEGER NOT NULL REFERENCES analytics_order_import_run(id));
      CREATE INDEX IF NOT EXISTS analytics_listing_lookup ON analytics_listing_identity(platform,shop_id,item_id,sku_id,valid_from,valid_to);
      CREATE TABLE IF NOT EXISTS analytics_order_reconciliation(id TEXT PRIMARY KEY,source TEXT NOT NULL,from_at TEXT NOT NULL,to_at TEXT NOT NULL,timezone TEXT NOT NULL,currency TEXT NOT NULL,date_field TEXT NOT NULL,refund_view TEXT NOT NULL,state TEXT NOT NULL,payload TEXT NOT NULL,actual TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS analytics_listing_projection(id TEXT PRIMARY KEY,source TEXT NOT NULL,payload_hash TEXT NOT NULL,observed_at TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS analytics_goal(year INTEGER PRIMARY KEY,target_cents INTEGER NOT NULL,current_cents INTEGER NOT NULL,as_of TEXT NOT NULL,source TEXT NOT NULL,confirmation TEXT NOT NULL,historical_context_cents INTEGER,updated_at TEXT NOT NULL);`);
  }

  private tx<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const out = fn();
      this.db.exec("COMMIT");
      return out;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  importData(p: OrderImportPayload): ImportResult {
    if (p.schemaVersion !== 1)
      throw new Error("unsupported order import schemaVersion");
    text(p.source, "source");
    text(p.sourceShopId, "sourceShopId");
    id(p.sourceFileId, "sourceFileId");
    if (!SHA.test(p.fileSha256))
      throw new Error("fileSha256 must contain 64 hex characters");
    iso(p.exportedAt, "exportedAt");
    text(p.timezone, "timezone");
    text(p.currency, "currency");
    const payloadHash = jsonHash(p);
    return this.tx(() => {
      const oldRun: any = this.db
        .prepare(
          "SELECT * FROM analytics_order_import_run WHERE source=? AND file_id=?",
        )
        .get(p.source, p.sourceFileId);
      if (oldRun) {
        if (
          oldRun.file_sha256 !== p.fileSha256 ||
          oldRun.payload_hash !== payloadHash
        )
          throw new Error("import file identity conflict");
        return {
          runId: Number(oldRun.id),
          state: "duplicate",
          inserted: 0,
          revised: 0,
          ignoredOlder: 0,
          refundsInserted: 0,
          refundsRevised: 0,
          listingsInserted: 0,
        };
      }
      const run = this.db
        .prepare(
          "INSERT INTO analytics_order_import_run(source,file_id,file_sha256,exported_at,timezone,currency,payload_hash,created_at) VALUES(?,?,?,?,?,?,?,?)",
        )
        .run(
          p.source,
          p.sourceFileId,
          p.fileSha256,
          p.exportedAt,
          p.timezone,
          p.currency,
          payloadHash,
          new Date().toISOString(),
        );
      const runId = Number(run.lastInsertRowid);
      let inserted = 0,
        revised = 0,
        ignoredOlder = 0,
        refundsInserted = 0,
        refundsRevised = 0,
        listingsInserted = 0;
      for (const o of p.orders) {
        id(o.orderId, "orderId");
        int(o.version, "order.version", 1);
        iso(o.placedAt, "placedAt");
        for (const k of [
          "merchandiseCents",
          "discountCents",
          "shippingCents",
          "taxCents",
          "paidCents",
        ] as const)
          int(o[k], k);
        signedInt(o.unallocatedCents, "unallocatedCents");
        if (
          o.merchandiseCents -
            o.discountCents +
            o.shippingCents +
            o.taxCents +
            o.unallocatedCents !==
          o.paidCents
        )
          throw new Error(`order ${o.orderId} header amounts do not reconcile`);
        if (!Array.isArray(o.lines) || !o.lines.length)
          throw new Error(`order ${o.orderId} has no lines`);
        const seen = new Set<string>();
        let linePaid = 0;
        for (const l of o.lines) {
          id(l.lineId, "lineId");
          id(l.itemId, "itemId");
          id(l.skuId, "skuId");
          text(l.platform, "platform");
          text(l.shopId, "shopId");
          if (seen.has(l.lineId))
            throw new Error(`duplicate lineId in order ${o.orderId}`);
          seen.add(l.lineId);
          int(l.quantity, "quantity", 1);
          int(l.grossCents, "line.grossCents");
          int(l.discountCents, "line.discountCents");
          int(l.paidCents, "line.paidCents");
          linePaid += l.paidCents;
          if (l.shopId !== p.sourceShopId)
            throw new Error(
              `order line shopId does not match sourceShopId: ${l.lineId}`,
            );
        }
        if (linePaid > o.paidCents)
          throw new Error(
            `order ${o.orderId} line paid amount exceeds order paid amount`,
          );
        const key = `${p.source}:${o.orderId}`,
          hash = jsonHash(o);
        const old: any = this.db
          .prepare(
            "SELECT version,payload_hash FROM analytics_order WHERE order_key=?",
          )
          .get(key);
        if (old && Number(old.version) > o.version) {
          ignoredOlder++;
          continue;
        }
        if (old && Number(old.version) === o.version) {
          if (old.payload_hash !== hash)
            throw new Error(`order version conflict: ${o.orderId}`);
          ignoredOlder++;
          continue;
        }
        this.db
          .prepare(
            `INSERT INTO analytics_order(order_key,source,order_id,version,payload,payload_hash,placed_at,paid_at,completed_at,cancelled_at,status,currency,merchandise_cents,discount_cents,shipping_cents,tax_cents,paid_cents,import_run_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(order_key) DO UPDATE SET version=excluded.version,payload=excluded.payload,payload_hash=excluded.payload_hash,placed_at=excluded.placed_at,paid_at=excluded.paid_at,completed_at=excluded.completed_at,cancelled_at=excluded.cancelled_at,status=excluded.status,currency=excluded.currency,merchandise_cents=excluded.merchandise_cents,discount_cents=excluded.discount_cents,shipping_cents=excluded.shipping_cents,tax_cents=excluded.tax_cents,paid_cents=excluded.paid_cents,import_run_id=excluded.import_run_id`,
          )
          .run(
            key,
            p.source,
            o.orderId,
            o.version,
            JSON.stringify(o),
            hash,
            o.placedAt,
            o.paidAt ?? null,
            o.completedAt ?? null,
            o.cancelledAt ?? null,
            text(o.status, "status"),
            p.currency,
            o.merchandiseCents,
            o.discountCents,
            o.shippingCents,
            o.taxCents,
            o.paidCents,
            runId,
          );
        this.db
          .prepare("DELETE FROM analytics_order_line WHERE order_key=?")
          .run(key);
        const stmt = this.db.prepare(
          "INSERT INTO analytics_order_line VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        );
        for (const l of o.lines)
          stmt.run(
            `${key}:${l.lineId}`,
            key,
            p.source,
            o.orderId,
            l.lineId,
            l.platform,
            l.shopId,
            l.itemId,
            l.skuId,
            l.title ?? null,
            l.quantity,
            l.grossCents,
            l.discountCents,
            l.paidCents,
          );
        old ? revised++ : inserted++;
      }
      for (const r of p.refunds ?? []) {
        id(r.refundId, "refundId");
        id(r.orderId, "refund.orderId");
        int(r.version, "refund.version", 1);
        int(r.amountCents, "refund.amountCents");
        iso(r.occurredAt, "refund.occurredAt");
        if (
          !this.db
            .prepare(
              "SELECT 1 FROM analytics_order WHERE source=? AND order_id=?",
            )
            .get(p.source, r.orderId)
        )
          throw new Error(`refund references unknown order: ${r.orderId}`);
        if (
          r.lineId &&
          !this.db
            .prepare(
              "SELECT 1 FROM analytics_order_line WHERE source=? AND order_id=? AND line_id=?",
            )
            .get(p.source, r.orderId, r.lineId)
        )
          throw new Error(
            `refund references unknown order line: ${r.orderId}/${r.lineId}`,
          );
        const key = `${p.source}:${r.refundId}`,
          hash = jsonHash(r),
          old: any = this.db
            .prepare(
              "SELECT version,payload_hash FROM analytics_refund WHERE refund_key=?",
            )
            .get(key);
        if (old && Number(old.version) > r.version) {
          ignoredOlder++;
          continue;
        }
        if (old && Number(old.version) === r.version) {
          if (old.payload_hash !== hash)
            throw new Error(`refund version conflict: ${r.refundId}`);
          ignoredOlder++;
          continue;
        }
        this.db
          .prepare(
            `INSERT INTO analytics_refund VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(refund_key) DO UPDATE SET version=excluded.version,order_id=excluded.order_id,line_id=excluded.line_id,occurred_at=excluded.occurred_at,status=excluded.status,amount_cents=excluded.amount_cents,payload_hash=excluded.payload_hash,import_run_id=excluded.import_run_id`,
          )
          .run(
            key,
            p.source,
            r.refundId,
            r.version,
            r.orderId,
            r.lineId ?? null,
            r.occurredAt,
            r.status,
            r.amountCents,
            hash,
            runId,
          );
        old ? refundsRevised++ : refundsInserted++;
      }
      for (const l of p.listings ?? []) {
        id(l.listingIdentityId, "listingIdentityId");
        id(l.itemId, "listing.itemId");
        id(l.skuId, "listing.skuId");
        id(l.batchId, "batchId");
        iso(l.validFrom, "listing.validFrom");
        iso(l.firstObservedOnSaleAt, "firstObservedOnSaleAt");
        if (l.validTo) iso(l.validTo, "listing.validTo");
        if (Date.parse(l.firstObservedOnSaleAt) < Date.parse(l.validFrom))
          throw new Error(
            "firstObservedOnSaleAt cannot precede identity validity",
          );
        const old: any = this.db
          .prepare("SELECT * FROM analytics_listing_identity WHERE id=?")
          .get(l.listingIdentityId);
        if (old) {
          const comparable = {
            listingIdentityId: old.id,
            platform: old.platform,
            shopId: old.shop_id,
            itemId: old.item_id,
            skuId: old.sku_id,
            validFrom: old.valid_from,
            validTo: old.valid_to,
            firstObservedOnSaleAt: old.first_on_sale_at,
            batchId: old.batch_id,
            membership: old.membership,
          };
          if (
            jsonHash(comparable) !==
            jsonHash({ ...l, validTo: l.validTo ?? null })
          )
            throw new Error(
              `listing identity conflict: ${l.listingIdentityId}`,
            );
          continue;
        }
        this.db
          .prepare(
            "INSERT INTO analytics_listing_identity VALUES(?,?,?,?,?,?,?,?,?,?,?)",
          )
          .run(
            l.listingIdentityId,
            l.platform,
            l.shopId,
            l.itemId,
            l.skuId,
            l.validFrom,
            l.validTo ?? null,
            l.firstObservedOnSaleAt,
            l.batchId,
            l.membership,
            runId,
          );
        listingsInserted++;
      }
      return {
        runId,
        state: "imported",
        inserted,
        revised,
        ignoredOlder,
        refundsInserted,
        refundsRevised,
        listingsInserted,
      };
    });
  }

  projectListings(p: ListingProjectionPayload): {
    state: "imported" | "duplicate";
    inserted: number;
  } {
    if (p.schemaVersion !== 1)
      throw new Error("unsupported listing projection schemaVersion");
    text(p.source, "source");
    id(p.projectionId, "projectionId");
    iso(p.observedAt, "observedAt");
    const hash = jsonHash(p),
      old: any = this.db
        .prepare(
          "SELECT payload_hash FROM analytics_listing_projection WHERE id=?",
        )
        .get(p.projectionId);
    if (old) {
      if (old.payload_hash !== hash)
        throw new Error("listing projection identity conflict");
      return { state: "duplicate", inserted: 0 };
    }
    return this.tx(() => {
      const syntheticFileId = `listing-${p.projectionId}`,
        run = this.db
          .prepare(
            "INSERT INTO analytics_order_import_run(source,file_id,file_sha256,exported_at,timezone,currency,payload_hash,created_at) VALUES(?,?,?,?,?,?,?,?)",
          )
          .run(
            p.source,
            syntheticFileId,
            hash,
            p.observedAt,
            "UTC",
            "N/A",
            hash,
            new Date().toISOString(),
          );
      const runId = Number(run.lastInsertRowid);
      let inserted = 0;
      for (const l of p.listings) {
        id(l.listingIdentityId, "listingIdentityId");
        id(l.itemId, "listing.itemId");
        id(l.skuId, "listing.skuId");
        id(l.batchId, "batchId");
        iso(l.validFrom, "listing.validFrom");
        iso(l.firstObservedOnSaleAt, "firstObservedOnSaleAt");
        if (l.validTo) iso(l.validTo, "listing.validTo");
        if (Date.parse(l.firstObservedOnSaleAt) < Date.parse(l.validFrom))
          throw new Error(
            "firstObservedOnSaleAt cannot precede identity validity",
          );
        const exists: any = this.db
          .prepare("SELECT * FROM analytics_listing_identity WHERE id=?")
          .get(l.listingIdentityId);
        if (exists)
          throw new Error(
            `listing identity already exists: ${l.listingIdentityId}`,
          );
        this.db
          .prepare(
            "INSERT INTO analytics_listing_identity VALUES(?,?,?,?,?,?,?,?,?,?,?)",
          )
          .run(
            l.listingIdentityId,
            l.platform,
            l.shopId,
            l.itemId,
            l.skuId,
            l.validFrom,
            l.validTo ?? null,
            l.firstObservedOnSaleAt,
            l.batchId,
            l.membership,
            runId,
          );
        inserted++;
      }
      this.db
        .prepare("INSERT INTO analytics_listing_projection VALUES(?,?,?,?,?)")
        .run(
          p.projectionId,
          p.source,
          hash,
          p.observedAt,
          new Date().toISOString(),
        );
      return { state: "imported", inserted };
    });
  }

  private totals(q: OrderSummaryQuery) {
    iso(q.from, "from");
    iso(q.to, "to");
    if (Date.parse(q.from) >= Date.parse(q.to))
      throw new Error("from must precede to");
    const field = {
      placedAt: "placed_at",
      paidAt: "paid_at",
      completedAt: "completed_at",
    }[q.dateField ?? "placedAt"];
    const conditions = [
        `julianday(${field})>=julianday(?)`,
        `julianday(${field})<julianday(?)`,
      ],
      args: any[] = [q.from, q.to];
    if (q.currency) {
      conditions.push("currency=?");
      args.push(q.currency);
    }
    if (q.source) {
      conditions.push("source=?");
      args.push(q.source);
    }
    if (q.shopId) {
      conditions.push(
        "EXISTS (SELECT 1 FROM analytics_order_line l WHERE l.order_key=analytics_order.order_key AND l.shop_id=?)",
      );
      args.push(q.shopId);
    }
    const rows: any[] = this.db
      .prepare(
        `SELECT * FROM analytics_order WHERE ${conditions.join(" AND ")}`,
      )
      .all(...args);
    const keys = new Set(rows.map((r) => `${r.source}:${r.order_id}`));
    const refunds: any[] = this.db
      .prepare(
        "SELECT r.*,o.placed_at FROM analytics_refund r JOIN analytics_order o ON o.source=r.source AND o.order_id=r.order_id WHERE r.status='completed'",
      )
      .all()
      .filter((r: any) => {
        const at = Date.parse(
          q.refundView === "original_order_period"
            ? r.placed_at
            : r.occurred_at,
        );
        return at >= Date.parse(q.from) && at < Date.parse(q.to);
      });
    const gross = rows
        .filter((r) => !r.cancelled_at && r.status !== "cancelled")
        .reduce((n, r) => n + Number(r.paid_cents), 0),
      refund = refunds.reduce((n, r) => n + Number(r.amount_cents), 0);
    return {
      rows,
      keys,
      actual: {
        orderCount: rows.length,
        grossCents: gross,
        refundCents: refund,
        netCents: gross - refund,
      },
    };
  }

  reconcile(p: ReconcilePayload): Reconciliation {
    id(p.reconciliationId, "reconciliationId");
    text(p.source, "source");
    text(p.timezone, "timezone");
    text(p.currency, "currency");
    for (const [k, v] of Object.entries(p.expected))
      int(v, `expected.${k}`, k === "netCents" ? Number.MIN_SAFE_INTEGER : 0);
    int(p.tolerance.absoluteCents, "absoluteCents");
    int(p.tolerance.relativeBps, "relativeBps");
    const { actual } = this.totals({
      from: p.from,
      to: p.to,
      timezone: p.timezone,
      currency: p.currency,
      dateField: p.dateField,
      refundView: p.refundView,
    });
    const differences = {
      orderCount: actual.orderCount - p.expected.orderCount,
      grossCents: actual.grossCents - p.expected.grossCents,
      refundCents: actual.refundCents - p.expected.refundCents,
      netCents: actual.netCents - p.expected.netCents,
    };
    const within = (a: number, e: number) =>
      Math.abs(a - e) <= p.tolerance.absoluteCents ||
      (e !== 0 &&
        Math.abs(a - e) * 10000 <= Math.abs(e) * p.tolerance.relativeBps);
    const balanced =
      differences.orderCount === 0 &&
      within(actual.grossCents, p.expected.grossCents) &&
      within(actual.refundCents, p.expected.refundCents) &&
      within(actual.netCents, p.expected.netCents);
    let state: Reconciliation["state"] = balanced ? "reconciled" : "rejected";
    if (p.acceptForMetric) {
      iso(p.acceptForMetric.confirmedAt, "acceptForMetric.confirmedAt");
      text(p.acceptForMetric.confirmedBy, "confirmedBy");
      text(p.acceptForMetric.basis, "basis");
      if (!balanced)
        throw new Error("cannot accept an unreconciled period for a metric");
      state = "accepted_for_metric";
    }
    const prior: any = this.db
      .prepare(
        "SELECT payload,actual,state FROM analytics_order_reconciliation WHERE id=?",
      )
      .get(p.reconciliationId);
    if (prior) {
      if (
        jsonHash(parse(prior.payload)) !== jsonHash(p) ||
        jsonHash(parse(prior.actual)) !== jsonHash(actual)
      )
        throw new Error("reconciliation identity conflict");
      return {
        reconciliationId: p.reconciliationId,
        state: prior.state,
        actual,
        expected: p.expected,
        differences,
      };
    }
    this.db
      .prepare(
        "INSERT INTO analytics_order_reconciliation VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        p.reconciliationId,
        p.source,
        p.from,
        p.to,
        p.timezone,
        p.currency,
        p.dateField,
        p.refundView,
        state,
        JSON.stringify(p),
        JSON.stringify(actual),
        new Date().toISOString(),
      );
    return {
      reconciliationId: p.reconciliationId,
      state,
      actual,
      expected: p.expected,
      differences,
    };
  }

  private lineBatch(line: any, at: string) {
    const matches: any[] = this.db
      .prepare(
        "SELECT * FROM analytics_listing_identity WHERE platform=? AND shop_id=? AND item_id=? AND sku_id=? AND julianday(valid_from)<=julianday(?) AND (valid_to IS NULL OR julianday(valid_to)>julianday(?)) AND julianday(first_on_sale_at)<=julianday(?)",
      )
      .all(line.platform, line.shop_id, line.item_id, line.sku_id, at, at, at);
    const fresh = [
      ...new Set(
        matches
          .filter((r) => r.membership === "new")
          .map((r) => String(r.batch_id)),
      ),
    ];
    return fresh.length === 1
      ? { batchState: "matched" as const, batchId: fresh[0] }
      : fresh.length > 1
        ? { batchState: "ambiguous" as const, batchId: null }
        : { batchState: "unmatched" as const, batchId: null };
  }

  summary(q: OrderSummaryQuery): OrderSummary {
    const { rows, actual } = this.totals(q);
    if (!rows.length)
      return {
        availability: "unavailable",
        state: "unavailable",
        orderCount: null,
        grossCents: null,
        refundCents: null,
        netCents: null,
        acceptedForTarget: false,
        acceptedNetCents: null,
        unmatchedLines: null,
        ambiguousLines: null,
      };
    const recs: any[] = this.db
      .prepare(
        "SELECT state,actual FROM analytics_order_reconciliation WHERE from_at=? AND to_at=? AND date_field=? AND refund_view=? AND currency=?",
      )
      .all(
        q.from,
        q.to,
        q.dateField ?? "placedAt",
        q.refundView ?? "event_period",
        q.currency ?? rows[0].currency,
      );
    const accepted = recs.find((r) => r.state === "accepted_for_metric");
    let unmatched = 0,
      ambiguous = 0;
    for (const o of rows) {
      const lines: any[] = this.db
        .prepare("SELECT * FROM analytics_order_line WHERE order_key=?")
        .all(o.order_key);
      for (const l of lines) {
        const m = this.lineBatch(l, o.placed_at);
        if (m.batchState === "unmatched") unmatched++;
        if (m.batchState === "ambiguous") ambiguous++;
      }
    }
    const states = [...new Set(recs.map((r) => String(r.state)))];
    const state: OrderSummary["state"] = accepted
      ? "accepted_for_metric"
      : states.includes("reconciled")
        ? "reconciled"
        : states.length
          ? "mixed"
          : "imported";
    return {
      availability: "available",
      state,
      orderCount: actual.orderCount,
      grossCents: actual.grossCents,
      refundCents: actual.refundCents,
      netCents: actual.netCents,
      acceptedForTarget: !!accepted,
      acceptedNetCents: accepted ? parse<any>(accepted.actual).netCents : null,
      unmatchedLines: unmatched,
      ambiguousLines: ambiguous,
    };
  }

  listOrders(q: OrderListQuery = {}): OrderView[] {
    const limit = Math.min(int(q.limit ?? 100, "limit", 1), 1000),
      offset = int(q.offset ?? 0, "offset");
    const where =
      q.from && q.to
        ? "WHERE julianday(placed_at)>=julianday(?) AND julianday(placed_at)<julianday(?)"
        : "";
    const args: any[] =
      q.from && q.to ? [q.from, q.to, limit, offset] : [limit, offset];
    const rows: any[] = this.db
      .prepare(
        `SELECT * FROM analytics_order ${where} ORDER BY placed_at DESC,order_id LIMIT ? OFFSET ?`,
      )
      .all(...args);
    return rows.map((o) => ({
      orderId: o.order_id,
      version: Number(o.version),
      placedAt: o.placed_at,
      status: o.status,
      paidCents: Number(o.paid_cents),
      lines: (
        this.db
          .prepare(
            "SELECT * FROM analytics_order_line WHERE order_key=? ORDER BY line_id",
          )
          .all(o.order_key) as any[]
      ).map((l) => ({
        lineId: l.line_id,
        skuId: l.sku_id,
        paidCents: Number(l.paid_cents),
        ...this.lineBatch(l, o.placed_at),
      })),
    }));
  }

  listBatches(q: BatchListQuery = {}): BatchResult[] {
    if ((q.from && !q.to) || (!q.from && q.to))
      throw new Error("batch period requires both from and to");
    if (q.from) {
      iso(q.from, "from");
      iso(q.to, "to");
    }
    const conditions = ["o.cancelled_at IS NULL", "o.status<>'cancelled'"];
    const args: any[] = [];
    if (q.from) {
      conditions.push(
        "julianday(o.placed_at)>=julianday(?)",
        "julianday(o.placed_at)<julianday(?)",
      );
      args.push(q.from, q.to);
    }
    if (q.source) {
      conditions.push("o.source=?");
      args.push(q.source);
    }
    if (q.shopId) {
      conditions.push("l.shop_id=?");
      args.push(q.shopId);
    }
    const lines: any[] = this.db
      .prepare(
        `SELECT o.order_key,o.source,o.order_id,o.placed_at,l.* FROM analytics_order o JOIN analytics_order_line l ON l.order_key=o.order_key WHERE ${conditions.join(" AND ")} ORDER BY o.placed_at,o.order_id,l.line_id`,
      )
      .all(...args);
    const out = new Map<string, BatchResult>(),
      orderSets = new Map<string, Set<string>>();
    for (const l of lines) {
      const m = this.lineBatch(l, l.placed_at);
      if (m.batchState !== "matched" || !m.batchId) continue;
      const r = out.get(m.batchId) ?? {
        batchId: m.batchId,
        orderCount: 0,
        lineCount: 0,
        grossCents: 0,
        refundCents: 0,
        netCents: 0,
      };
      r.lineCount++;
      r.grossCents += Number(l.paid_cents);
      r.netCents += Number(l.paid_cents);
      out.set(m.batchId, r);
      const set = orderSets.get(m.batchId) ?? new Set<string>();
      set.add(`${l.source}:${l.order_id}`);
      orderSets.set(m.batchId, set);
    }
    const refunds: any[] = this.db
      .prepare(
        "SELECT r.*,o.placed_at,l.platform,l.shop_id,l.item_id,l.sku_id FROM analytics_refund r JOIN analytics_order o ON o.source=r.source AND o.order_id=r.order_id JOIN analytics_order_line l ON l.source=r.source AND l.order_id=r.order_id AND l.line_id=r.line_id WHERE r.status='completed'",
      )
      .all();
    for (const rfd of refunds) {
      if (q.source && rfd.source !== q.source) continue;
      if (q.shopId && rfd.shop_id !== q.shopId) continue;
      const periodValue = Date.parse(
        q.refundView === "event_period" ? rfd.occurred_at : rfd.placed_at,
      );
      if (
        q.from &&
        (periodValue < Date.parse(q.from) || periodValue >= Date.parse(q.to!))
      )
        continue;
      const m = this.lineBatch(rfd, rfd.placed_at);
      if (m.batchState !== "matched" || !m.batchId) continue;
      const r = out.get(m.batchId) ?? {
        batchId: m.batchId,
        orderCount: 0,
        lineCount: 0,
        grossCents: 0,
        refundCents: 0,
        netCents: 0,
      };
      r.refundCents += Number(rfd.amount_cents);
      r.netCents -= Number(rfd.amount_cents);
      out.set(m.batchId, r);
    }
    for (const [batch, r] of out)
      r.orderCount = orderSets.get(batch)?.size ?? 0;
    return [...out.values()].sort((a, b) => a.batchId.localeCompare(b.batchId));
  }

  setGoal(p: GoalPayload): Goal {
    int(p.year, "year", 2000);
    int(p.targetCents, "targetCents", 1);
    int(p.currentCents, "currentCents");
    iso(p.asOf, "asOf");
    text(p.source, "source");
    text(p.confirmation?.confirmedBy, "confirmation.confirmedBy");
    iso(p.confirmation?.confirmedAt, "confirmation.confirmedAt");
    text(p.confirmation?.basis, "confirmation.basis");
    if (p.historicalContextCents != null)
      int(p.historicalContextCents, "historicalContextCents");
    this.db
      .prepare(
        "INSERT INTO analytics_goal VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(year) DO UPDATE SET target_cents=excluded.target_cents,current_cents=excluded.current_cents,as_of=excluded.as_of,source=excluded.source,confirmation=excluded.confirmation,historical_context_cents=excluded.historical_context_cents,updated_at=excluded.updated_at",
      )
      .run(
        p.year,
        p.targetCents,
        p.currentCents,
        p.asOf,
        p.source,
        JSON.stringify(p.confirmation),
        p.historicalContextCents ?? null,
        new Date().toISOString(),
      );
    return {
      ...p,
      remainingCents: Math.max(0, p.targetCents - p.currentCents),
    };
  }
  goal(): Goal | null {
    const r: any = this.db
      .prepare("SELECT * FROM analytics_goal ORDER BY year DESC LIMIT 1")
      .get();
    return r
      ? {
          year: Number(r.year),
          targetCents: Number(r.target_cents),
          currentCents: Number(r.current_cents),
          asOf: r.as_of,
          source: r.source,
          confirmation: parse(r.confirmation),
          historicalContextCents:
            r.historical_context_cents == null
              ? null
              : Number(r.historical_context_cents),
          remainingCents: Math.max(
            0,
            Number(r.target_cents) - Number(r.current_cents),
          ),
        }
      : null;
  }
}
