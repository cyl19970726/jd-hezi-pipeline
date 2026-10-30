import type { Store } from "./store.js";

/** Existing shop pauses remain global; only new explicitly-scoped HZ failures are isolated. */
export function assertHzRunning(store: Store, shop: string) {
  store.assertRunning(shop);
  store.assertRunning("hz:" + shop);
}
