import { Store } from "./store.js";

/** Latest publishing attempt only; never combine events across retries. */
export function executionSpeed(store: Store, productId: string | null) {
  if (!productId) return null;
  const all = store.db
    .prepare(
      "SELECT event,detail,at FROM events WHERE product_id=? ORDER BY seq",
    )
    .all(productId);
  const start = all.findLastIndex((e) => e.event === "VALIDATED");
  if (start < 0) return null;
  const events = all.slice(start);
  const time = (name: string) => events.find((e) => e.event === name)?.at;
  const delta = (from: unknown, to: unknown) => {
    if (!from || !to) return null;
    const value = Date.parse(String(to)) - Date.parse(String(from));
    return Number.isFinite(value) && value >= 0 ? value : null;
  };
  const save = events.find(
    (e) =>
      e.event === "OPERATION_STARTED" &&
      JSON.parse(String(e.detail)).kind === "save",
  );
  const saved = time("DRAFT_SAVED"),
    verified = time("DRAFT_VERIFIED");
  const submitted = events.find((e) =>
    ["SUBMITTED", "APPROVED", "ON_SALE"].includes(String(e.event)),
  )?.at;
  return {
    startedAt: String(events[0].at),
    finishedAt: submitted ? String(submitted) : null,
    totalMs: delta(events[0].at, submitted),
    stages: [
      { name: "填写、上传与保存", durationMs: delta(save?.at, saved) },
      { name: "独立读回核验", durationMs: delta(saved, verified) },
      {
        name: "提交审核与状态确认",
        durationMs: delta(time("SUBMIT_REQUESTED"), submitted),
      },
    ],
  };
}
