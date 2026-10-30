import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.js";
import { SourceIndex } from "../src/source-index.js";
const coverage = [
  "visible-normal",
  "visible-draft",
  "hidden-normal",
  "hidden-draft",
].map((partition) => ({
  partition,
  expected: partition === "visible-normal" ? 1 : 0,
  seen: partition === "visible-normal" ? 1 : 0,
}));
const record = {
  itemId: "123",
  code: "123",
  title: "renamed",
  shop: "shop",
  status: "待提交",
  sku: "",
};
test("source lookup requires fresh complete coverage, and matches SKU despite renamed title", () => {
  const s = new Store(":memory:"),
    i = new SourceIndex(s),
    scan = i.begin("shop");
  i.put(scan, "shop", record, "revision", ["456"], true);
  assert.throws(() => i.lookup("shop", "456"));
  assert.equal(i.finish(scan, coverage), true);
  assert.equal(i.lookup("shop", "456")[0].itemId, "123");
  assert.deepEqual(i.lookup("shop", "789"), []);
  s.db
    .prepare("UPDATE source_scans SET started_at='2000-01-01T00:00:00Z'")
    .run();
  assert.throws(() => i.lookup("shop", "456"));
  s.close();
});
test("partial, wrong partitions, unresolved sources and failure never prove absence", () => {
  for (const kind of ["partial", "partitions", "unresolved", "failure"]) {
    const s = new Store(":memory:"),
      i = new SourceIndex(s),
      scan = i.begin("shop");
    i.put(scan, "shop", record, "r", [], kind !== "unresolved");
    assert.equal(
      i.finish(
        scan,
        kind === "partial"
          ? coverage.slice(1)
          : kind === "partitions"
            ? coverage.map((c, n) => ({ ...c, partition: String(n) }))
            : coverage,
        kind === "failure",
      ),
      false,
    );
    assert.throws(() => i.lookup("shop", "456"));
    s.close();
  }
});
test("source cache requires known revision and invalidates changed records", () => {
  const s = new Store(":memory:"),
    i = new SourceIndex(s),
    scan = i.begin("shop");
  i.put(scan, "shop", record, "r", ["456"], true);
  assert.deepEqual(i.cached("shop", "123", "r"), ["456"]);
  assert.equal(i.cached("shop", "123", "new"), null);
  assert.equal(i.cached("shop", "123", ""), null);
  s.close();
});
test("an older scan cannot overwrite newer evidence, and missing membership blocks completion", () => {
  const s = new Store(":memory:"),
    i = new SourceIndex(s),
    old = i.begin("shop"),
    fresh = i.begin("shop");
  i.put(fresh, "shop", record, "new", ["456"], true);
  i.put(old, "shop", record, "old", ["789"], true);
  assert.equal(i.cached("shop", "123", "old"), null);
  assert.deepEqual(i.cached("shop", "123", "new"), ["456"]);
  assert.equal(i.finish(old, coverage), false);
  assert.equal(i.finish(fresh, coverage), true);
  assert.equal(i.lookup("shop", "456").length, 1);
  s.close();
});
test("drafts are a subset of the supplier default list, not additional unique products", () => {
  const s = new Store(":memory:"),
    i = new SourceIndex(s),
    scan = i.begin("shop");
  i.put(scan, "shop", record, "r", ["456"], true);
  assert.equal(
    i.finish(
      scan,
      coverage.map((c) =>
        c.partition === "visible-draft" ? { ...c, expected: 1, seen: 1 } : c,
      ),
    ),
    true,
  );
  s.close();
});
test("batch lookup preserves variants and duplicate remote matches without treating stale index as absence", () => {
  const s = new Store(":memory:"),
    i = new SourceIndex(s),
    scan = i.begin("shop");
  try {
    i.put(scan, "shop", record, "r", ["456", "457"], true);
    i.put(
      scan,
      "shop",
      { ...record, itemId: "124", code: "124" },
      "r",
      ["456"],
      true,
    );
    i.finish(
      scan,
      coverage.map((c) =>
        c.partition === "visible-normal" ? { ...c, expected: 2, seen: 2 } : c,
      ),
    );
    const result = i.lookupMany("shop", ["456", "457", "999", "456"]);
    assert.equal(result.get("456")?.length, 2);
    assert.equal(result.get("457")?.length, 1);
    assert.deepEqual(result.get("999"), []);
    assert.equal(result.size, 3);
    s.db.prepare("UPDATE source_scans SET status='partial'").run();
    assert.throws(() => i.lookupMany("shop", ["999"]), /未完整/);
  } finally {
    s.close();
  }
});

test("running source scans resume with durable page and detail checkpoints", () => {
  const s = new Store(":memory:"),
    i = new SourceIndex(s),
    now = Date.now(),
    first = i.beginOrResume("shop", now);
  assert.equal(first.resumed, false);
  i.saveCheckpoint(first.scan, {
    partition: "visible-normal",
    expected: 2,
    pages: 1,
    nextPage: 1,
    seen: [],
    page: {
      number: 1,
      total: 2,
      pages: 1,
      items: [{ itemId: "123" }, { itemId: "124" }],
      nextDetail: 1,
    },
    complete: false,
  });
  const second = i.beginOrResume("shop", now + 60_000);
  assert.deepEqual(second, { scan: first.scan, resumed: true });
  assert.equal(i.checkpoint(first.scan, "visible-normal")?.page?.nextDetail, 1);
  s.close();
});

test("an expired running scan is retired instead of mixing old and fresh partitions", () => {
  const s = new Store(":memory:"),
    i = new SourceIndex(s),
    now = Date.now(),
    first = i.beginOrResume("shop", now);
  assert.throws(
    () => i.beginOrResume("shop", now + 21 * 60 * 60 * 1000),
    /新鲜度边界/,
  );
  assert.equal(
    s.db.prepare("SELECT status FROM source_scans WHERE id=?").get(first.scan)
      ?.status,
    "partial",
  );
  s.close();
});
