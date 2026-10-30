import type { Store } from "./store.js";

const remoteStates = new Set(["SUBMITTED", "APPROVED", "ON_SALE"]);

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function observedNewSave(
  store: Store,
  productId: string,
  remoteId: string,
  startedAt: string,
) {
  return store.db
    .prepare(
      `SELECT receipt FROM operations
       WHERE product_id=? AND kind IN ('save','create')
         AND status='observed' AND created_at>=?
       ORDER BY created_at,id`,
    )
    .all(productId, startedAt)
    .some((operation: any) => {
      try {
        return JSON.parse(String(operation.receipt))?.itemId === remoteId;
      } catch {
        return false;
      }
    });
}

export function activeAcceptanceBatchProgress(store: Store, shop: string) {
  const metaKey = `active-acceptance-batch:${shop}`;
  const batch = store.meta(metaKey);
  if (!batch || typeof batch !== "object" || !Array.isArray(batch.candidates))
    return null;
  const key = text(batch.key);
  const startedAt = text(batch.startedAt);
  const started = Date.parse(String(startedAt));
  const targetCount = Number(batch.target);
  if (
    !key ||
    !startedAt ||
    !Number.isFinite(started) ||
    !Number.isInteger(targetCount) ||
    targetCount < 1
  )
    return null;

  const unique = new Map<string, { sku: string; jobId: string }>();
  for (const candidate of batch.candidates) {
    const sku = text(candidate?.sku);
    const jobId = text(candidate?.jobId);
    if (sku && jobId && !unique.has(sku)) unique.set(sku, { sku, jobId });
  }

  const items = [...unique.values()].flatMap(({ sku, jobId }) => {
    const row = store.db
      .prepare(
        `SELECT j.*,p.id AS bound_product_id,p.state AS product_state,
                p.remote_id,p.data_hash,p.verified_hash,
                EXISTS(
                  SELECT 1 FROM operations pending
                  WHERE pending.product_id=p.id AND pending.status='pending'
                ) AS pending
         FROM jobs j
         LEFT JOIN products p
           ON p.id=j.product_id AND p.shop=j.shop AND p.sku=j.sku
         WHERE j.id=? AND j.shop=? AND j.sku=?`,
      )
      .get(jobId, shop, sku) as any;
    if (!row) return [];
    const remoteState = text(row.product_state);
    const remoteId = text(row.remote_id);
    const complete =
      row.status === "DONE" &&
      !!row.bound_product_id &&
      !!remoteId &&
      !!remoteState &&
      remoteStates.has(remoteState) &&
      !!row.data_hash &&
      row.verified_hash === row.data_hash &&
      !row.pending &&
      observedNewSave(store, String(row.bound_product_id), remoteId, startedAt);
    return [
      {
        id: jobId,
        sku,
        status: String(row.status),
        stage: String(row.stage),
        remoteState,
        disposition: "eligible" as const,
        complete,
        reason: row.error ? String(row.error) : null,
      },
    ];
  });

  const completed = items.filter((item) => item.complete);
  const count = (status: string) =>
    items.filter((item) => item.status === status).length;
  const counts = {
    running: count("RUNNING"),
    queued: count("QUEUED"),
    needsInput: count("NEEDS_INPUT") + count("CANCELLED"),
    unknown: count("UNKNOWN_OUTCOME"),
    submitted: completed.filter((item) => item.remoteState === "SUBMITTED")
      .length,
    approved: completed.filter((item) => item.remoteState === "APPROVED")
      .length,
    onSale: completed.filter((item) => item.remoteState === "ON_SALE").length,
  };
  const active = counts.running + counts.queued > 0;
  const onHold = counts.needsInput + counts.unknown > 0;
  const completedCount = completed.length;
  const blockedReasons = [
    ...new Set(
      items
        .filter((item) =>
          ["NEEDS_INPUT", "UNKNOWN_OUTCOME", "CANCELLED"].includes(item.status),
        )
        .map((item) => item.reason)
        .filter((reason): reason is string => !!reason),
    ),
  ];

  return {
    key,
    targetCount,
    candidateCount: unique.size,
    plannedCount: items.length,
    existingCount: 0,
    duplicateCount: batch.candidates.length - unique.size,
    excludedCount: unique.size - items.length,
    gapCount: Math.max(0, targetCount - items.length),
    startedCount: items.length,
    completedCount,
    remainingCount: Math.max(0, targetCount - completedCount),
    currentGroup: { batch: key, startedAt, items },
    counts,
    blockedReasons,
    status:
      completedCount >= targetCount
        ? "complete"
        : active
          ? "in-progress"
          : onHold
            ? "needs-input"
            : items.length
              ? "in-progress"
              : "planned",
  };
}

export const acceptanceBatchProgress = activeAcceptanceBatchProgress;
