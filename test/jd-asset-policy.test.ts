import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.js";
import { jdAssetPolicy } from "../src/jd-asset-policy.js";
import { PipelineError } from "../src/model.js";
import { JdTraffic } from "../src/jd-traffic.js";
const context = { shop: "ours", sku: "123", source: "browser" as const };
const asset = {
  sku: "123",
  role: "main" as const,
  order: 0,
  url: "https://img10.360buyimg.com/test.jpg",
};
test("CDN denial persists shared pause, request evidence, and releases the operation lock", async () => {
  const s = new Store(":memory:");
  try {
    const policy = jdAssetPolicy(s, context);
    await assert.rejects(
      policy.runNetwork!(asset, async () => {
        throw new PipelineError("NEEDS_INPUT", "HTTP 429", { httpStatus: 429 });
      }),
      /429/,
    );
    assert.ok(new JdTraffic(s, "ours", undefined, "android").accountPause());
    assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM locks").get()!.n, 0);
    const rows = s.db.prepare("SELECT * FROM jd_access_metrics").all();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].observable_requests, null);
    assert.equal(rows[0].downloads, 0);
    assert.equal(rows[0].stage, "asset-attempt");
  } finally {
    s.close();
  }
});
test("verified local cache metrics remain available while JD is paused without a network attempt", async () => {
  const s = new Store(":memory:");
  try {
    new JdTraffic(s, "ours").pauseAccount("RATE_LIMITED", "verification");
    const policy = jdAssetPolicy(s, context);
    await policy.onMetric!({
      ...asset,
      kind: "cache-hit",
      source: "provided",
      bytes: 0,
    });
    const row = s.db.prepare("SELECT * FROM jd_access_metrics").get()!;
    assert.equal(row.cache_hits, 1);
    assert.equal(row.downloads, 0);
    assert.equal(row.observable_requests, null);
  } finally {
    s.close();
  }
});
