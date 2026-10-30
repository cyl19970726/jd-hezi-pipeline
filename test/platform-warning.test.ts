import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.js";
import { Engine } from "../src/engine.js";
import { example, MemoryAdapter } from "../src/demo.js";
import { auditKnown } from "../src/reconcile.js";

test("audit records changed platform warnings, preserves unknown observations and detects clearance", async () => {
  const store = new Store(":memory:"),
    { product, plan } = example();
  try {
    const row = store.put(plan.shop, product);
    store.setPlan(row.id, plan);
    const adapter = new MemoryAdapter();
    await new Engine(store, adapter).run(row.id, "submit");
    const id = store.get(row.id).remoteId!,
      remote = adapter.records.get(id)!;
    remote.platformWarning = "价格锁定";
    assert.equal(
      (await auditKnown(store, adapter, plan.shop)).results[0].changed,
      true,
    );
    assert.equal(store.meta("platform-warning:" + id).message, "价格锁定");
    assert.equal(
      (await auditKnown(store, adapter, plan.shop)).results[0].changed,
      false,
    );
    delete remote.platformWarning;
    await auditKnown(store, adapter, plan.shop);
    assert.equal(store.meta("platform-warning:" + id).message, "价格锁定");
    remote.platformWarning = null;
    await auditKnown(store, adapter, plan.shop);
    assert.equal(store.meta("platform-warning:" + id), null);
    assert.equal(adapter.submits, 1);
  } finally {
    store.close();
  }
});

test("audit records rejection locally without clearing a pending operation or writing remotely", async () => {
  const store = new Store(":memory:"),
    { product, plan } = example();
  try {
    const row = store.put(plan.shop, product);
    store.setPlan(row.id, plan);
    const adapter = new MemoryAdapter();
    await new Engine(store, adapter).run(row.id, "submit");
    const id = store.get(row.id).remoteId!,
      remote = adapter.records.get(id)!;
    remote.status = "已驳回";
    remote.platformWarning = "规格应填一个装";
    const pending = store.intent(row.id, "submit");

    const result = await auditKnown(store, adapter, plan.shop);

    assert.equal(result.results[0].status, "已驳回");
    assert.equal(store.get(row.id).state, "SUBMITTED");
    assert.equal(store.pending(row.id)?.id, pending);
    assert.equal(store.get(row.id).remoteId, id);
    assert.equal(adapter.submits, 1);

    store.receipt(pending, { itemId: id, status: "已驳回" });
    await auditKnown(store, adapter, plan.shop);
    assert.equal(store.get(row.id).state, "REJECTED");
    assert.match(store.get(row.id).error!, /规格应填一个装/);
    assert.equal(store.get(row.id).remoteId, id);
    assert.equal(adapter.submits, 1);
  } finally {
    store.close();
  }
});
