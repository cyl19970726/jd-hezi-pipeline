import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  AnalyticsOrders,
  type OrderImportPayload,
} from "../src/analytics/orders.js";

const base = (): OrderImportPayload => ({
  schemaVersion: 1,
  source: "verified-export",
  sourceShopId: "our-shop",
  sourceFileId: "orders-2026-09-a",
  fileSha256: "a".repeat(64),
  exportedAt: "2026-09-19T12:00:00+08:00",
  timezone: "Asia/Shanghai",
  currency: "CNY",
  orders: [
    {
      orderId: "o-1",
      version: 1,
      placedAt: "2026-08-31T23:00:00+08:00",
      paidAt: "2026-09-01T00:01:00+08:00",
      status: "paid",
      merchandiseCents: 10000,
      discountCents: 1000,
      shippingCents: 0,
      taxCents: 0,
      unallocatedCents: 0,
      paidCents: 9000,
      lines: [
        {
          lineId: "l-1",
          platform: "hezi",
          shopId: "our-shop",
          itemId: "item-1",
          skuId: "sku-1",
          quantity: 1,
          grossCents: 10000,
          discountCents: 1000,
          paidCents: 9000,
        },
      ],
    },
  ],
  refunds: [
    {
      refundId: "r-1",
      version: 1,
      orderId: "o-1",
      lineId: "l-1",
      occurredAt: "2026-09-05T10:00:00+08:00",
      status: "completed",
      amountCents: 2000,
    },
  ],
});

function fixture() {
  const db = new DatabaseSync(":memory:");
  return { db, orders: new AnalyticsOrders(db) };
}

test("file replay is idempotent and same file identity conflict rolls back", () => {
  const f = fixture();
  try {
    const p = base();
    assert.equal(f.orders.importData(p).inserted, 1);
    assert.equal(f.orders.importData(p).state, "duplicate");
    const bad = structuredClone(p);
    bad.fileSha256 = "b".repeat(64);
    assert.throws(() => f.orders.importData(bad), /conflict/);
    assert.equal(f.orders.listOrders().length, 1);
  } finally {
    f.db.close();
  }
});

test("later versions replace an order, old versions are ignored, and equal-version changes conflict", () => {
  const f = fixture();
  try {
    f.orders.importData(base());
    const newer = base();
    newer.sourceFileId = "orders-revision";
    newer.fileSha256 = "b".repeat(64);
    newer.orders[0].version = 2;
    newer.orders[0].paidCents = 8000;
    newer.orders[0].unallocatedCents = -1000;
    newer.orders[0].lines[0].paidCents = 8000;
    assert.equal(f.orders.importData(newer).revised, 1);
    const old = base();
    old.sourceFileId = "orders-old";
    old.fileSha256 = "c".repeat(64);
    assert.equal(f.orders.importData(old).ignoredOlder, 2);
    const conflict = structuredClone(newer);
    conflict.sourceFileId = "orders-conflict";
    conflict.fileSha256 = "d".repeat(64);
    conflict.orders[0].status = "completed";
    assert.throws(() => f.orders.importData(conflict), /version conflict/);
    assert.equal(f.orders.listOrders()[0].paidCents, 8000);
  } finally {
    f.db.close();
  }
});

test("refund event and original-order period views remain separately reproducible", () => {
  const f = fixture();
  try {
    f.orders.importData(base());
    const aug = f.orders.summary({
      from: "2026-08-01T00:00:00+08:00",
      to: "2026-09-01T00:00:00+08:00",
      refundView: "original_order_period",
    });
    assert.equal(aug.netCents, 7000);
    assert.equal(aug.refundCents, 2000);
    const sep = f.orders.summary({
      from: "2026-09-01T00:00:00+08:00",
      to: "2026-10-01T00:00:00+08:00",
      dateField: "paidAt",
      refundView: "event_period",
    });
    assert.equal(sep.refundCents, 2000);
    assert.equal(sep.netCents, 7000);
  } finally {
    f.db.close();
  }
});

test("only one temporal new listing owns a line; maintenance does not count and duplicate new batches are ambiguous", () => {
  const f = fixture();
  try {
    const p = base();
    p.listings = [
      {
        listingIdentityId: "identity-new",
        platform: "hezi",
        shopId: "our-shop",
        itemId: "item-1",
        skuId: "sku-1",
        validFrom: "2026-08-01T00:00:00+08:00",
        firstObservedOnSaleAt: "2026-08-15T00:00:00+08:00",
        batchId: "batch-a",
        membership: "new",
      },
      {
        listingIdentityId: "identity-maint",
        platform: "hezi",
        shopId: "our-shop",
        itemId: "item-1",
        skuId: "sku-1",
        validFrom: "2026-08-20T00:00:00+08:00",
        firstObservedOnSaleAt: "2026-08-20T00:00:00+08:00",
        batchId: "batch-maint",
        membership: "maintenance",
      },
    ];
    f.orders.importData(p);
    assert.equal(f.orders.listOrders()[0].lines[0].batchId, "batch-a");
    assert.deepEqual(
      f.orders
        .listBatches()
        .map((x) => [x.batchId, x.grossCents, x.refundCents, x.netCents]),
      [["batch-a", 9000, 2000, 7000]],
    );
    f.orders.projectListings({
      schemaVersion: 1,
      source: "business-projection",
      projectionId: "projection-2",
      observedAt: "2026-09-19T12:00:00+08:00",
      listings: [
        {
          ...p.listings[0],
          listingIdentityId: "identity-new-2",
          batchId: "batch-b",
        },
      ],
    });
    assert.equal(f.orders.listOrders()[0].lines[0].batchState, "ambiguous");
    assert.equal(f.orders.listBatches().length, 0);
  } finally {
    f.db.close();
  }
});

test("raw data is visible before finance acceptance; target metric needs balanced confirmed reconciliation", () => {
  const f = fixture();
  try {
    f.orders.importData(base());
    const q = {
      from: "2026-08-01T00:00:00+08:00",
      to: "2026-09-01T00:00:00+08:00",
      dateField: "placedAt" as const,
      refundView: "original_order_period" as const,
      timezone: "Asia/Shanghai",
      currency: "CNY",
    };
    assert.equal(f.orders.summary(q).state, "imported");
    assert.throws(
      () =>
        f.orders.reconcile({
          reconciliationId: "rec-bad",
          source: "finance",
          ...q,
          expected: {
            orderCount: 1,
            grossCents: 9999,
            refundCents: 2000,
            netCents: 7999,
          },
          tolerance: { absoluteCents: 0, relativeBps: 0 },
          acceptForMetric: {
            metric: "target_turnover",
            confirmedBy: "finance",
            confirmedAt: "2026-09-19T12:00:00+08:00",
            basis: "ledger",
          },
        }),
      /unreconciled/,
    );
    const rec = f.orders.reconcile({
      reconciliationId: "rec-good",
      source: "finance",
      ...q,
      expected: {
        orderCount: 1,
        grossCents: 9000,
        refundCents: 2000,
        netCents: 7000,
      },
      tolerance: { absoluteCents: 0, relativeBps: 0 },
      acceptForMetric: {
        metric: "target_turnover",
        confirmedBy: "finance",
        confirmedAt: "2026-09-19T12:00:00+08:00",
        basis: "ledger",
      },
    });
    assert.equal(rec.state, "accepted_for_metric");
    assert.equal(f.orders.summary(q).acceptedNetCents, 7000);
  } finally {
    f.db.close();
  }
});

test("no data is unavailable, and goal requires dated sourced confirmation", () => {
  const f = fixture();
  try {
    assert.equal(
      f.orders.summary({
        from: "2026-01-01T00:00:00+08:00",
        to: "2026-02-01T00:00:00+08:00",
      }).netCents,
      null,
    );
    assert.throws(() =>
      f.orders.setGoal({
        year: 2026,
        targetCents: 300000000,
        currentCents: 120000000,
        asOf: "",
        source: "",
        confirmation: { confirmedBy: "", confirmedAt: "", basis: "" },
      }),
    );
    const goal = f.orders.setGoal({
      year: 2026,
      targetCents: 300000000,
      currentCents: 130000000,
      asOf: "2026-09-18T23:59:59+08:00",
      source: "finance-ledger",
      confirmation: {
        confirmedBy: "owner",
        confirmedAt: "2026-09-19T12:00:00+08:00",
        basis: "approved turnover definition",
      },
      historicalContextCents: 120000000,
    });
    assert.equal(goal.remainingCents, 170000000);
    assert.equal(f.orders.goal()?.historicalContextCents, 120000000);
  } finally {
    f.db.close();
  }
});

test("shop-bound import rejects lines from another shop", () => {
  const f = fixture();
  try {
    const p = base();
    p.orders[0].lines[0].shopId = "other-shop";
    assert.throws(() => f.orders.importData(p), /sourceShopId/);
    assert.equal(f.orders.listOrders().length, 0);
  } finally {
    f.db.close();
  }
});
