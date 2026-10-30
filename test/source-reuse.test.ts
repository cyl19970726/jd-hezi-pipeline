import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.js";
import { example } from "../src/demo.js";
import { SourceReuse, sourceContext } from "../src/source-reuse.js";
import { collectionNeed } from "../src/collection-needs.js";

function setup() {
  const store = new Store(":memory:");
  const reuse = new SourceReuse(store);
  const { product } = example();
  product.capturedAt = new Date().toISOString();
  product.price!.capturedAt = product.capturedAt;
  return {
    store,
    reuse,
    product,
    context: sourceContext(store, "shop", product.sku),
  };
}

test("opportunity capture is reused as stable worker facts without authorizing an unknown quote context", () => {
  const f = setup();
  try {
    f.reuse.remember(f.context, f.product);
    assert.equal(
      f.store.list().length,
      0,
      "capture alone does not create a publishing product",
    );
    const row = f.store.tx(() => f.reuse.adopt("shop", f.product));
    assert.deepEqual(row.product, f.product);
    assert.equal(
      f.reuse.captures.observedProduct(f.context, row.product!),
      true,
    );
    assert.notEqual(
      collectionNeed(row.product, "browser", Date.now(), {
        previouslyObserved: true,
      }),
      "full",
    );
    assert.equal(
      f.reuse.captures.price(f.context, {}, row.product!.price),
      null,
    );
    assert.equal(f.reuse.adopt("shop", f.product).id, row.id);
    assert.equal(f.store.list().length, 1);
  } finally {
    f.store.close();
  }
});

test("context/parser/channel changes never re-label a quote or reuse incompatible facts", () => {
  const f = setup();
  try {
    const original = { ...f.context, accountContext: "A", regionContext: "R" };
    f.reuse.remember(original, f.product);
    assert.ok(f.reuse.captures.price(original, {}, f.product.price));
    assert.equal(
      f.reuse.captures.price(
        { ...original, accountContext: "B" },
        {},
        f.product.price,
      ),
      null,
    );
    assert.equal(
      f.reuse.captures.price(
        { ...original, regionContext: "S" },
        {},
        f.product.price,
      ),
      null,
    );
    assert.ok(f.reuse.captures.facts({ ...original, accountContext: "B" }));
    assert.equal(
      f.reuse.captures.facts({ ...original, parserVersion: "future-parser" }),
      null,
    );
    assert.equal(
      f.reuse.captures.facts({ ...original, source: "android" }),
      null,
    );
  } finally {
    f.store.close();
  }
});

for (const kind of ["plan", "remote", "pending", "different"] as const) {
  test(`source promotion preserves ${kind} existing product`, () => {
    const f = setup();
    try {
      f.reuse.remember(f.context, f.product);
      const row = f.store.put("shop", f.product);
      if (kind === "plan") {
        const { plan } = example();
        plan.shop = "shop";
        f.store.setPlan(row.id, plan);
      } else if (kind === "remote")
        f.store.db
          .prepare("UPDATE products SET remote_id='remote-original' WHERE id=?")
          .run(row.id);
      else if (kind === "pending")
        f.store.db
          .prepare(
            "INSERT INTO operations VALUES('p',?,'save',?,'pending',NULL,?)",
          )
          .run(row.id, row.dataHash, f.product.capturedAt);
      else
        f.store.put("shop", {
          ...f.product,
          title: { ...f.product.title, value: "另一商品事实" },
        });
      const before = f.store.get(row.id);
      assert.throws(() => f.reuse.adopt("shop", f.product));
      assert.deepEqual(f.store.get(row.id), before);
    } finally {
      f.store.close();
    }
  });
}

test("promotion rolls back original product/cache creation when task association fails", () => {
  const f = setup();
  try {
    assert.throws(
      () =>
        f.store.tx(() => {
          f.reuse.remember(f.context, f.product);
          f.reuse.adopt("shop", f.product);
          throw Error("association interrupted");
        }),
      /interrupted/,
    );
    assert.equal(f.store.list().length, 0);
    assert.equal(f.reuse.captures.facts(f.context), null);
  } finally {
    f.store.close();
  }
});

test("partial and media checkpoints cannot relabel the original quote under a new account", () => {
  const f = setup();
  try {
    const observed = { ...f.context, accountContext: "A", regionContext: "R" };
    const changed = { ...f.context, accountContext: "B", regionContext: "R" };
    f.reuse.remember(observed, f.product);
    for (const stage of ["targeted:packaging", "media"]) {
      f.reuse.captures.saveProduct(changed, f.product, stage);
      assert.equal(f.reuse.captures.price(changed, {}, f.product.price), null);
      assert.ok(f.reuse.captures.price(observed, {}, f.product.price));
    }
  } finally {
    f.store.close();
  }
});

for (const state of [
  "DRAFT_SAVED",
  "DRAFT_VERIFIED",
  "SUBMIT_REQUESTED",
  "UNKNOWN_OUTCOME",
  "REJECTED",
]) {
  test(`promotion fails closed for incomplete persisted ${state} identity`, () => {
    const f = setup();
    try {
      f.reuse.remember(f.context, f.product);
      const row = f.store.put("shop", f.product);
      f.store.db
        .prepare("UPDATE products SET state=? WHERE id=?")
        .run(state, row.id);
      assert.throws(() => f.reuse.adopt("shop", f.product), /原任务/);
      assert.equal(f.store.get(row.id).state, state);
    } finally {
      f.store.close();
    }
  });
}
