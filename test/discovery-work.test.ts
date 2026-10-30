import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.js";
import { Discovery } from "../src/discovery.js";
import { SourceIndex } from "../src/source-index.js";
import { discoveryWork, enqueueDiscovery } from "../src/discovery-work.js";
import { Catalog } from "../src/catalog.js";
import { Planner } from "../src/planner.js";
import { Jobs } from "../src/jobs.js";
function fixture() {
  const s = new Store(":memory:");
  const id = new Discovery(s).start({
    shop: "ours",
    brandId: "brand",
    jdBrandId: "1",
    jdShopId: "2",
    shopName: "official",
    kind: "self-operated",
    evidenceUrl: "https://mall.jd.com/index-2.html",
    verifiedAt: new Date().toISOString(),
    seeds: ["https://mall.jd.com/view_search-1-2-99-1-20-1.html"],
  });
  for (const [sku, status] of [
    ["123", "verified"],
    ["456", "verified"],
    ["789", "pending"],
  ])
    s.db
      .prepare("INSERT INTO discovery_skus VALUES(?,?,?,?,NULL)")
      .run(
        id,
        sku,
        status,
        JSON.stringify({ variants: [{ sku, hint: "spec " + sku }] }),
      );
  return { s, id };
}
test("missing index keeps absence unknown and never creates publishing jobs", () => {
  const { s, id } = fixture();
  try {
    const r = discoveryWork(s, "ours", id);
    assert.equal(r.counts["index-required"], 2);
    assert.equal(r.counts["source-pending"], 1);
    assert.equal(s.db.prepare("SELECT COUNT(*) n FROM jobs").get()?.n, 0);
    assert.throws(() => discoveryWork(s, "other", id), /当前店铺/);
  } finally {
    s.close();
  }
});

test("verified discovery assignments are atomic, repeatable and cannot replace existing recipes", () => {
  const { s, id } = fixture();
  try {
    const now = new Date().toISOString(),
      ev = { checkedAt: now, sourceUrl: "https://b.csgmall.com.cn/shop-view/" };
    new Catalog(s).import({
      shop: "ours",
      brands: [{ id: "brand", name: "brand", ...ev }],
      categories: [
        {
          id: "leaf",
          parentId: null,
          name: "leaf",
          path: "leaf",
          selectable: true,
          ...ev,
        },
      ],
      grants: [
        {
          id: "g",
          brandId: "brand",
          status: "approved",
          validFrom: new Date(Date.now() - 86400000).toISOString(),
          validUntil: new Date(Date.now() + 86400000).toISOString(),
          scopes: [{ categoryId: "leaf", descendants: false }],
          ...ev,
        },
      ],
    });
    new Planner(s).importTemplate("ours", "leaf", { specs: ["规格"], ...ev });
    s.db
      .prepare("INSERT INTO shop_policies VALUES('ours','p','{}',?)")
      .run(now);
    const index = new SourceIndex(s),
      scan = index.begin("ours");
    index.finish(
      scan,
      ["visible-normal", "visible-draft", "hidden-normal", "hidden-draft"].map(
        (partition) => ({ partition, expected: 0, seen: 0 }),
      ),
    );
    const recipe = {
      brandId: "brand",
      categoryId: "leaf",
      policyId: "p",
      unit: "件",
      through: "submit" as const,
    };
    assert.throws(() =>
      enqueueDiscovery(s, "ours", id, ["123", "789"], recipe),
    );
    assert.equal(new Jobs(s, "ours").list().length, 0);
    const a = enqueueDiscovery(s, "ours", id, ["123", "456", "123"], recipe);
    assert.equal(a.items.length, 2);
    const b = enqueueDiscovery(s, "ours", id, ["123", "456"], recipe);
    assert.deepEqual(
      b.items.map((x) => x.id),
      a.items.map((x) => x.id),
    );
    assert.ok(b.items.every((x) => x.reused));
    assert.equal(new Jobs(s, "ours").events(a.items[0].id).length, 1);
    assert.throws(
      () => enqueueDiscovery(s, "other", id, ["123"], recipe),
      /当前店铺/,
    );
    assert.throws(
      () =>
        enqueueDiscovery(s, "ours", id, ["123"], {
          ...recipe,
          brandId: "other",
        }),
      /品牌/,
    );
    s.db
      .prepare(
        "UPDATE category_templates SET checked_at='2000-01-01T00:00:00Z'",
      )
      .run();
    assert.throws(
      () => enqueueDiscovery(s, "ours", id, ["123"], recipe),
      /过期/,
    );
    s.db.prepare("UPDATE category_templates SET checked_at=?").run(now);
    assert.throws(
      () => enqueueDiscovery(s, "ours", id, ["123"], { ...recipe, unit: "箱" }),
      /不同上架规则/,
    );
    s.db.prepare("UPDATE catalog_grants SET status='revoked'").run();
    assert.throws(
      () => enqueueDiscovery(s, "ours", id, ["456"], recipe),
      /授权/,
    );
  } finally {
    s.close();
  }
});
test("planning preserves duplicate matches, separate variants and untouched discovery checkpoints", () => {
  const { s, id } = fixture();
  try {
    const i = new SourceIndex(s),
      scan = i.begin("ours");
    for (const itemId of ["1", "2"])
      i.put(
        scan,
        "ours",
        {
          itemId,
          code: itemId,
          sku: "",
          shop: "ours",
          title: "item",
          status: "在售",
        },
        "r",
        ["123"],
        true,
      );
    i.finish(
      scan,
      ["visible-normal", "visible-draft", "hidden-normal", "hidden-draft"].map(
        (partition) => ({
          partition,
          expected: partition === "visible-normal" ? 2 : 0,
          seen: partition === "visible-normal" ? 2 : 0,
        }),
      ),
    );
    const r = discoveryWork(s, "ours", id);
    assert.equal(r.rows[0].kind, "duplicate");
    assert.equal(r.rows[0].records.length, 2);
    assert.equal(r.rows[1].kind, "unassigned");
    assert.equal(r.rows[2].kind, "source-pending");
    assert.equal(new Discovery(s).get(id).status, "pages");
  } finally {
    s.close();
  }
});
