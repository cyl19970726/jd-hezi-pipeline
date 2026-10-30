import { Store } from "./store.js";
import { PipelineError, type Row, type RemoteRecord } from "./model.js";
/** Missing columns mean unknown; only an observed empty field clears a prior warning. */
export function observePlatformWarning(
  store: Store,
  row: Row,
  remote: RemoteRecord,
) {
  if (remote.platformWarning === undefined) return;
  if (
    remote.itemId !== row.remoteId ||
    remote.shop !== row.shop ||
    remote.sku !== row.sku
  )
    throw new PipelineError("ACCOUNT_CHANGED", "平台提示所属商品身份不符");
  const key = "platform-warning:" + remote.itemId;
  const previous = store.meta(key);
  const message = remote.platformWarning?.trim() || null;
  const current = message
    ? {
        itemId: remote.itemId,
        status: remote.status,
        field: "下架原因",
        message,
        checkedAt: new Date().toISOString(),
        evidence: "当前供应商商品列表的下架原因列",
      }
    : null;
  store.setMeta(key, current);
  if ((previous?.message ?? null) !== message)
    store.event(row.id, "PLATFORM_WARNING_CHANGED", { previous, current });
}
