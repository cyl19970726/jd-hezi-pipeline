import test from "node:test";
import assert from "node:assert/strict";
import { waitForJdProduct } from "../src/browser/runtime.js";

test("JD frequency redirect stops before waiting for product selectors", async () => {
  let waited = false;
  await assert.rejects(
    waitForJdProduct({
      evaluate: async () => ({ risk: true }),
      waitForFunction: async () => {
        waited = true;
      },
    }),
    { code: "RATE_LIMITED" },
  );
  assert.equal(waited, false);
});

test("a late frequency redirect is classified instead of surfacing a generic timeout", async () => {
  let reads = 0;
  await assert.rejects(
    waitForJdProduct({
      evaluate: async () => ({ risk: ++reads > 1 }),
      waitForFunction: async () => {
        throw Error("selector timed out");
      },
    }),
    { code: "RATE_LIMITED" },
  );
});

test("ordinary product selector failures retain the original error", async () => {
  const timeout = Error("selector timed out");
  await assert.rejects(
    waitForJdProduct({
      evaluate: async () => ({ risk: false }),
      waitForFunction: async () => {
        throw timeout;
      },
    }),
    (error) => error === timeout,
  );
});
