import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.js";
import { Jobs } from "../src/jobs.js";
import { Worker } from "../src/worker.js";
import { example } from "../src/demo.js";
import { EgoBridge } from "../src/browser/bridge.js";
import type { BrowserConfig } from "../src/browser/runtime.js";
test("completed mobile media with a missing fact stays on the same task without recollecting or publishing", async () => {
  const s = new Store(":memory:");
  try {
    const { product, plan } = example();
    for (const key of ["手机原图完整性", "来源店铺", "包装名称", "包装数量"])
      product.specs[key] = { ...product.title, value: "测试事实" };
    const row = s.put(plan.shop, product),
      jobs = new Jobs(s, plan.shop);
    jobs.enqueue([product.sku], {
      source: "android",
      brandId: "b",
      categoryId: "c",
      policyId: "p",
      unit: "件",
      through: "submit",
    });
    const job = jobs.claim()!;
    let calls = 0;
    const bridge = new EgoBridge();
    bridge.call = async () => {
      calls++;
      throw Error("must not contact websites");
    };
    await new Worker(
      s,
      jobs,
      { shop: plan.shop } as BrowserConfig,
      "/unused-test-root",
      bridge,
    ).run(job);
    const result = jobs.get(job.id);
    assert.equal(result.productId, row.id);
    assert.equal(result.status, "NEEDS_INPUT");
    assert.equal(result.stage, "normalize");
    assert.match(result.error!, /商品毛重/);
    assert.equal(calls, 0);
    assert.equal(s.meta("android-open:" + plan.shop), null);
    assert.equal(s.get(row.id).remoteId, null);
    assert.equal(s.get(row.id).product!.assets.length, 4);
  } finally {
    s.close();
  }
});
