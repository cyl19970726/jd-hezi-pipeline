import test from "node:test";
import assert from "node:assert/strict";
import { evaluatePreflightPackingName } from "../src/browser/runtime.js";

test("template-only packing preflight omits an undefined evaluate argument", async () => {
  const calls: unknown[][] = [];
  const page = {
    async evaluate(...args: unknown[]) {
      if (args.some((value) => value === undefined))
        throw new Error("page.evaluate argument must be JSON-serializable");
      calls.push(args);
      return { maxLength: 20, issues: [], valueIssues: [] };
    },
  };

  const result = await evaluatePreflightPackingName(page, undefined);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].length, 1);
  assert.deepEqual(result, {
    maxLength: 20,
    issues: [],
    valueIssues: [],
  });
});

test("packing preflight passes an explicit display name unchanged", async () => {
  const calls: unknown[][] = [];
  const page = {
    async evaluate(...args: unknown[]) {
      calls.push(args);
      return { maxLength: 20, issues: [], valueIssues: [] };
    },
  };

  await evaluatePreflightPackingName(page, "电蚊拍整套");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].length, 2);
  assert.equal(calls[0][1], "电蚊拍整套");
});
