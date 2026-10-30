import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.js";
import { executionSpeed } from "../src/execution-speed.js";
test("publishing duration comes from actual events and excludes older attempts", () => {
  const s = new Store(":memory:");
  const add = (event: string, seconds: number, detail = {}) =>
    s.db
      .prepare("INSERT INTO events(product_id,event,detail,at) VALUES(?,?,?,?)")
      .run(
        "p",
        event,
        JSON.stringify(detail),
        new Date(seconds * 1000).toISOString(),
      );
  try {
    assert.equal(executionSpeed(s, "p"), null);
    add("VALIDATED", 0);
    add("DRAFT_SAVED", 5);
    add("DRAFT_VERIFIED", 6);
    add("SUBMITTED", 8);
    add("VALIDATED", 100);
    add("OPERATION_STARTED", 102, { kind: "save" });
    add("DRAFT_SAVED", 132);
    add("DRAFT_VERIFIED", 142);
    add("SUBMIT_REQUESTED", 143);
    add("SUBMITTED", 163);
    const r = executionSpeed(s, "p")!;
    assert.equal(r.totalMs, 63000);
    assert.deepEqual(
      r.stages.map((x) => x.durationMs),
      [30000, 10000, 20000],
    );
    add("VALIDATED", 200);
    add("OPERATION_STARTED", 201, { kind: "save" });
    const incomplete = executionSpeed(s, "p")!;
    assert.equal(incomplete.totalMs, null);
    assert.deepEqual(
      incomplete.stages.map((x) => x.durationMs),
      [null, null, null],
    );
  } finally {
    s.close();
  }
});
