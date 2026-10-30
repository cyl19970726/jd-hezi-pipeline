import { test } from "node:test";
import assert from "node:assert/strict";
import {
  reserveSourceRequest,
  SourceBudgetReached,
  sourceScanBudget,
  storeFreshSource,
} from "../src/browser/source-scan.js";

test("source scan budget defaults and validates bounded pacing", () => {
  assert.deepEqual(sourceScanBudget(), { maxRequests: 150, intervalMs: 1000 });
  assert.deepEqual(sourceScanBudget({ maxRequests: 3, intervalMs: 334 }), {
    maxRequests: 3,
    intervalMs: 334,
  });
  for (const invalid of [
    { maxRequests: 0 },
    { maxRequests: 501 },
    { maxRequests: 1.5 },
    { intervalMs: 333 },
  ])
    assert.throws(() => sourceScanBudget(invalid), /无效来源扫描预算/);
});

test("source request reservation stops before exceeding its limit", () => {
  const budget = sourceScanBudget({ maxRequests: 2 });
  let used = reserveSourceRequest(0, budget);
  used = reserveSourceRequest(used, budget);
  assert.equal(used, 2);
  assert.throws(() => reserveSourceRequest(used, budget), SourceBudgetReached);
});

test("each fresh source detail is persisted before the rest of its page", () => {
  const calls: unknown[][] = [];
  storeFreshSource(
    { put: (...args: unknown[]) => calls.push(args) } as any,
    8,
    "shop",
    { itemId: "2601", revision: "r1", title: "item" },
    {
      skus: ["1001"],
      resolved: true,
      unresolvedUrls: ["bad-link"],
    },
  );
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], [
    8,
    "shop",
    {
      itemId: "2601",
      revision: "r1",
      title: "item",
      sku: "",
      sourceIssues: ["bad-link"],
    },
    "r1",
    ["1001"],
    true,
  ]);
});
