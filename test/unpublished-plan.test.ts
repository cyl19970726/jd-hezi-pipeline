import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.js";
import { example } from "../src/demo.js";
test("unpublished plan reset retains evidence but rejects bound products", () => {
  const s = new Store(":memory:");
  try {
    const { product, plan } = example();
    let r = s.put(plan.shop, product);
    s.setPlan(r.id, plan);
    r = s.resetUnpublishedPlan(r.id, "用户取消审图，按完整来源重新整理");
    assert.equal(r.plan, null);
    assert.deepEqual(r.product, product);
    s.bind(r.id, "123", "123");
    assert.throws(() => s.resetUnpublishedPlan(r.id, "retry"), /已写入/);
  } finally {
    s.close();
  }
});
