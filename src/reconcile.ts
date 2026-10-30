import { assertHzRunning } from "./platform-availability.js";
import { Traffic } from "./traffic.js";
import { Store } from "./store.js";
import { observePlatformWarning } from "./platform-warning.js";
import { verify, type Adapter } from "./model.js";
import { rejectionDetail, remoteProductState } from "./remote-status.js";
/** Read-only remotely. Keep last observation and only report meaningful differences. */
export async function auditKnown(store: Store, adapter: Adapter, shop: string) {
  const unlock = store.lock("publisher");
  try {
    assertHzRunning(store, shop);
    const traffic = new Traffic(store, shop);
    await traffic.run("audit-account", () => adapter.checkShop(shop));
    const results = [];
    for (const row of store
      .list()
      .filter(
        (r) =>
          r.shop === shop &&
          r.remoteId &&
          r.verifiedHash &&
          r.product &&
          r.plan,
      )) {
      const snapshot = await traffic.run("audit-product", () =>
        adapter.read(row.remoteId!),
      );
      const issues = verify(
        snapshot,
        row.product!,
        row.plan!,
        row.mediaReferences,
      );
      const observation = {
        itemId: snapshot.itemId,
        sku: snapshot.sku,
        status: snapshot.status,
        issues,
        platformWarning: snapshot.platformWarning,
      };
      observePlatformWarning(store, row, snapshot);
      if (
        remoteProductState(snapshot.status) === "REJECTED" &&
        !store.pending(row.id)
      )
        store.state(row.id, "REJECTED", rejectionDetail(snapshot));
      const key = "audit:" + row.id,
        previous = store.meta(key);
      const changed =
        JSON.stringify(previous?.observation) !== JSON.stringify(observation);
      store.setMeta(key, { observation, checkedAt: new Date().toISOString() });
      if (changed)
        store.event(row.id, "REMOTE_AUDIT_CHANGED", {
          previous: previous?.observation ?? null,
          current: observation,
        });
      results.push({ ...observation, changed });
    }
    return {
      shop,
      scope: "locally verified bound products",
      checkedAt: new Date().toISOString(),
      results,
    };
  } finally {
    unlock();
  }
}
