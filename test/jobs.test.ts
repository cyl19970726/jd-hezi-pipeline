import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.js";
import { Jobs } from "../src/jobs.js";
import { example } from "../src/demo.js";
const recipe = {
  brandId: "1",
  categoryId: "2",
  policyId: "p",
  unit: "件",
  through: "submit" as const,
};
test("batch deduplicates canonical SKU across requests and preserves existing recipe", () => {
  const s = new Store(":memory:");
  try {
    const j = new Jobs(s, "shop");
    const a = j.enqueue(["123", "https://item.jd.com/123.html", "456"], recipe);
    assert.equal(a.items.length, 2);
    const b = j.enqueue(["123"], { ...recipe, categoryId: "changed" });
    assert.equal(b.items[0].id, a.items[0].id);
    assert.equal(b.items[0].reused, true);
    assert.equal(j.get(b.items[0].id).recipe.categoryId, "2");
  } finally {
    s.close();
  }
});
test("invalid URL makes the whole batch atomic", () => {
  const s = new Store(":memory:");
  try {
    const j = new Jobs(s, "shop");
    assert.throws(() =>
      j.enqueue(["123", "https://evil.test/456.html"], recipe),
    );
    assert.equal(j.list().length, 0);
  } finally {
    s.close();
  }
});
test("restart retains pending write as unknown and refuses blind retry", () => {
  const s = new Store(":memory:");
  try {
    const j = new Jobs(s, "shop"),
      a = j.enqueue(["123"], recipe).items[0],
      p = example().product;
    p.sku = "123";
    p.url = "https://item.jd.com/123.html";
    const row = s.put("shop", p);
    j.update(a.id, "RUNNING", "save", null, row.id);
    s.intent(row.id, "save");
    j.recover();
    assert.equal(j.get(a.id).status, "UNKNOWN_OUTCOME");
    assert.throws(() => j.retry(a.id));
    assert.ok(s.pending(row.id));
  } finally {
    s.close();
  }
});
test("failed item does not block the next job and stages record real duration", async () => {
  const s = new Store(":memory:");
  try {
    const j = new Jobs(s, "shop");
    j.enqueue(["123", "456"], recipe);
    const first = j.claim()!;
    await assert.rejects(
      j.stage(first.id, "collect", async () => {
        throw Error("missing");
      }),
    );
    j.update(first.id, "NEEDS_INPUT", "collect", "missing");
    const next = j.claim()!;
    assert.notEqual(first.id, next.id);
    assert.equal(j.events(first.id).length, 2);
    assert.equal(j.events(first.id)[1].kind, "failed");
    assert.equal(typeof j.events(first.id)[1].duration_ms, "number");
  } finally {
    s.close();
  }
});
test("jobs are isolated between shops", () => {
  const s = new Store(":memory:");
  try {
    const a = new Jobs(s, "a"),
      b = new Jobs(s, "b");
    const r = a.enqueue(["123"], recipe);
    assert.throws(() => b.get(r.items[0].id));
    assert.equal(b.list().length, 0);
  } finally {
    s.close();
  }
});

test("same-family sales specifications retain independent jobs and remote bindings", () => {
  const s = new Store(":memory:");
  try {
    const j = new Jobs(s, "shop");
    const variants = [
      ["900000000002", "8个 1盒", "990909001699"],
      ["900000000004", "8个 2盒", "990909001911"],
      ["900000000003", "10g 1盒", "990909001913"],
    ];
    const batch = j.enqueue(
      variants.map((v) => v[0]),
      recipe,
    );
    for (const [i, [sku, specification, remote]] of variants.entries()) {
      const p = example().product;
      p.sku = sku;
      p.url = `https://item.jd.com/${sku}.html`;
      p.title.value = "同一个系列标题";
      p.specs["京东销售规格"] = { ...p.title, value: specification };
      const row = s.put("shop", p);
      s.bind(row.id, remote, remote);
      j.update(batch.items[i].id, "NEEDS_INPUT", "plan", null, row.id);
    }
    assert.equal(j.list().length, 3);
    assert.equal(new Set(s.list().map((r) => r.remoteId)).size, 3);
    assert.deepEqual(
      new Set(s.list().map((r) => r.product!.specs["京东销售规格"].value)),
      new Set(variants.map((v) => v[1])),
    );
    assert.equal(
      j.enqueue([variants[1][0]], recipe).items[0].id,
      batch.items[1].id,
    );
  } finally {
    s.close();
  }
});
