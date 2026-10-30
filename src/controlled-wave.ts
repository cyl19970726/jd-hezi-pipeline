import { Store } from "./store.js";

type Baseline = {
  scanId?: unknown;
  startedAt?: unknown;
  finishedAt?: unknown;
  checkedAt?: unknown;
  status?: unknown;
  matches?: unknown;
};
type Candidate = {
  sku?: unknown;
  brandId?: unknown;
  evidence?: { runId?: unknown };
  sourceIndexBaseline?: Baseline;
};
type WaveItem = { id?: unknown; sku?: unknown };
type WaveGroup = { batch?: unknown; startedAt?: unknown; items?: unknown };
type Disposition = "eligible" | "existing" | "duplicate" | "excluded";
const remoteStates = new Set(["SUBMITTED", "APPROVED", "ON_SALE"]),
  day = 86_400_000;

function text(value: unknown) {
  return typeof value === "string" && value ? value : null;
}
function disposition(candidate: Candidate, at: number): Disposition {
  const b = candidate.sourceIndexBaseline;
  if (!b || b.status !== "complete" || !Array.isArray(b.matches))
    return "excluded";
  if (b.matches.length === 1) return "existing";
  if (b.matches.length > 1) return "duplicate";
  const scan = Number(b.scanId),
    started = Date.parse(String(b.startedAt)),
    finished = Date.parse(String(b.finishedAt)),
    checked = Date.parse(String(b.checkedAt));
  return Number.isInteger(scan) &&
    scan > 0 &&
    Number.isFinite(started) &&
    Number.isFinite(finished) &&
    Number.isFinite(checked) &&
    started <= finished &&
    finished <= checked &&
    checked <= at &&
    checked - finished <= day
    ? "eligible"
    : "excluded";
}
function observedCreation(
  store: Store,
  productId: string,
  remoteId: string,
  since: number,
  checkedAt: number,
) {
  return store.db
    .prepare(
      `SELECT receipt FROM operations WHERE product_id=? AND kind IN ('save','create') AND status='observed' AND created_at>=? ORDER BY created_at`,
    )
    .all(productId, new Date(Math.max(since, checkedAt)).toISOString())
    .some((op) => {
      try {
        return JSON.parse(String(op.receipt))?.itemId === remoteId;
      } catch {
        return false;
      }
    });
}

export function controlledWaveProgress(
  store: Store,
  shop: string,
  key = "controlled-wave:2026-09-11-expanded",
  now = Date.now(),
) {
  const plan = store.meta(key);
  if (!plan || typeof plan !== "object" || !Array.isArray(plan.candidates))
    return null;
  const newMode =
    Number.isInteger(plan.targetNewCount) && plan.targetNewCount >= 0;
  const candidates = new Map<string, Candidate>();
  for (const value of plan.candidates as Candidate[]) {
    const sku = text(value?.sku),
      brand = text(value?.brandId),
      run = text(value?.evidence?.runId);
    if (sku && brand && run && !candidates.has(sku)) candidates.set(sku, value);
  }
  const dispositions = new Map(
    [...candidates].map(([sku, c]) => [
      sku,
      newMode ? disposition(c, now) : ("eligible" as Disposition),
    ]),
  );
  const groups = Array.isArray(plan.groups) ? (plan.groups as WaveGroup[]) : [];
  const projectedGroups = groups.map((group) => {
    const batch = text(group.batch),
      startedAt = text(group.startedAt),
      groupStarted = Date.parse(String(startedAt));
    const items = Array.isArray(group.items) ? (group.items as WaveItem[]) : [];
    return {
      batch,
      startedAt,
      items: items.flatMap((item) => {
        const id = text(item?.id),
          sku = text(item?.sku),
          candidate = sku ? candidates.get(sku) : null;
        if (
          !batch ||
          !id ||
          !sku ||
          !candidate ||
          !Number.isFinite(groupStarted)
        )
          return [];
        const brand = text(candidate.brandId),
          run = text(candidate.evidence?.runId);
        const row = store.db
          .prepare(
            `SELECT j.*,p.id product_id,p.state product_state,p.remote_id,p.data_hash,p.verified_hash, EXISTS(SELECT 1 FROM operations o WHERE o.product_id=p.id AND o.status='pending') pending FROM jobs j JOIN batch_jobs bj ON bj.job_id=j.id AND bj.batch_id=? LEFT JOIN products p ON p.id=j.product_id AND p.shop=j.shop AND p.sku=j.sku WHERE j.id=? AND j.shop=? AND j.sku=?`,
          )
          .get(batch, id, shop, sku);
        if (!row || !brand || !run) return [];
        let recipe: { brandId?: unknown };
        try {
          recipe = JSON.parse(String(row.recipe));
        } catch {
          return [];
        }
        if (recipe.brandId !== brand) return [];
        const assigned = store.db
          .prepare(
            "SELECT detail FROM job_events WHERE job_id=? AND kind='source-assigned' ORDER BY seq",
          )
          .all(id)
          .some((event) => {
            try {
              const d = JSON.parse(String(event.detail));
              return d.runId === run && d.brandId === brand && d.sku === sku;
            } catch {
              return false;
            }
          });
        if (!assigned) return [];
        const candidateDisposition = newMode
            ? disposition(candidate, now)
            : "eligible",
          productState = text(row.product_state),
          remoteId = text(row.remote_id);
        const complete =
          candidateDisposition === "eligible" &&
          !!remoteId &&
          !!productState &&
          remoteStates.has(productState) &&
          !!row.data_hash &&
          row.verified_hash === row.data_hash &&
          !row.pending &&
          (!newMode ||
            (!!row.product_id &&
              observedCreation(
                store,
                String(row.product_id),
                remoteId,
                groupStarted,
                Date.parse(String(candidate.sourceIndexBaseline?.checkedAt)),
              )));
        return [
          {
            id,
            sku,
            status: String(row.status),
            stage: String(row.stage),
            remoteState: productState,
            disposition: candidateDisposition,
            complete,
            reason: row.error ? String(row.error) : null,
          },
        ];
      }),
    };
  });
  const actual = [
    ...new Map(
      projectedGroups.flatMap((g) => g.items).map((item) => [item.id, item]),
    ).values(),
  ];
  const eligibleActual = actual.filter(
      (item) => item.disposition === "eligible",
    ),
    completed = eligibleActual.filter((item) => item.complete);
  const count = (status: string) =>
    eligibleActual.filter((item) => item.status === status).length;
  const dispositionCount = (value: Disposition) =>
    [...dispositions.values()].filter((d) => d === value).length;
  const targetCount = newMode
    ? Number(plan.targetNewCount)
    : Math.max(
        candidates.size,
        Number.isInteger(plan.targetCount) && plan.targetCount >= 0
          ? plan.targetCount
          : 0,
      );
  const plannedCount = dispositionCount("eligible"),
    completedCount = completed.length,
    startedCount = eligibleActual.length;
  const counts = {
    running: count("RUNNING"),
    queued: count("QUEUED"),
    needsInput: count("NEEDS_INPUT"),
    unknown: count("UNKNOWN_OUTCOME"),
    submitted: completed.filter((i) => i.remoteState === "SUBMITTED").length,
    approved: completed.filter((i) => i.remoteState === "APPROVED").length,
    onSale: completed.filter((i) => i.remoteState === "ON_SALE").length,
  };
  const blockedReasons = [
    ...new Set(
      eligibleActual
        .filter((i) => ["NEEDS_INPUT", "UNKNOWN_OUTCOME"].includes(i.status))
        .map((i) => i.reason)
        .filter((r): r is string => !!r),
    ),
  ];
  return {
    key,
    targetCount,
    candidateCount: candidates.size,
    plannedCount,
    existingCount: dispositionCount("existing"),
    duplicateCount: dispositionCount("duplicate"),
    excludedCount: dispositionCount("excluded"),
    gapCount: Math.max(0, targetCount - plannedCount),
    startedCount,
    completedCount,
    remainingCount: Math.max(0, targetCount - completedCount),
    currentGroup:
      [...projectedGroups].reverse().find((g) => g.items.length) ?? null,
    counts,
    blockedReasons,
    status:
      targetCount > 0 && completedCount >= targetCount
        ? "complete"
        : counts.unknown
          ? "needs-reconciliation"
          : counts.needsInput
            ? "needs-input"
            : startedCount
              ? "in-progress"
              : "planned",
  };
}
