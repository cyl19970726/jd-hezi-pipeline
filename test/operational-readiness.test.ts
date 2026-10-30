import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.js";
import { Catalog } from "../src/catalog.js";
import { OperationalReadiness } from "../src/operational-readiness.js";
import { SourceIndex } from "../src/source-index.js";

const shop = "readiness-shop";
const coverage = [
  "visible-normal",
  "visible-draft",
  "hidden-normal",
  "hidden-draft",
].map((partition) => ({
  partition,
  expected: 0,
  seen: 0,
}));

function fixture(grantStatus: "approved" | "revoked" = "approved") {
  const store = new Store(":memory:");
  const now = Date.now();
  const checkedAt = new Date(now - 1_000).toISOString();
  new Catalog(store).import({
    shop,
    categories: [
      {
        id: "category-id",
        parentId: null,
        name: "办公用品",
        path: "办公用品",
        selectable: true,
        sourceUrl: "https://supplier.example/categories",
        checkedAt,
      },
    ],
    brands: [
      {
        id: "supplier-brand-id",
        name: "测试品牌",
        sourceUrl: "https://supplier.example/brands",
        checkedAt,
      },
    ],
    grants: [
      {
        id: "grant-id",
        brandId: "supplier-brand-id",
        status: grantStatus,
        validFrom: new Date(now - 60_000).toISOString(),
        validUntil: new Date(now + 60_000).toISOString(),
        scopes: [{ categoryId: "category-id", descendants: false }],
        sourceUrl: "https://supplier.example/grants",
        checkedAt,
      },
    ],
  });
  const index = new SourceIndex(store);
  const scan = index.begin(shop);
  index.finish(scan, coverage);
  return { store, index, now, checkedAt };
}

const exactInput = {
  shop,
  brand: { id: "supplier-brand-id", name: "测试品牌" },
  category: { id: "category-id", path: "办公用品" },
  sourceSku: "123456",
};

test("projects exact authorization evidence and a clear exact-source lookup", () => {
  const { store, now, checkedAt } = fixture();
  try {
    const result = new OperationalReadiness(store).evaluate(exactInput, {
      now,
    });
    assert.equal(result.scope, "authorization-and-exact-source-duplicate");
    assert.deepEqual(result.authorization, {
      status: "authorized",
      grantId: "grant-id",
      brandId: "supplier-brand-id",
      categoryId: "category-id",
      checkedAt,
    });
    assert.deepEqual(result.sourceDuplicate, {
      status: "clear",
      sourceSku: "123456",
      matches: [],
    });
    assert.equal(result.eligibility.ready, true);
    assert.deepEqual(result.eligibility.nextChecks, [
      "source-facts",
      "price",
      "preparation",
      "publish-preflight",
    ]);
  } finally {
    store.close();
  }
});

test("reports exact duplicate records from SourceIndex and blocks the scoped eligibility", () => {
  const { store, index, now } = fixture();
  try {
    const scan = index.begin(shop);
    index.put(
      scan,
      shop,
      {
        itemId: "remote-item",
        code: "remote-code",
        title: "renamed item",
        shop,
        status: "已发布",
        sku: "",
      },
      "revision",
      ["123456"],
      true,
    );
    index.finish(
      scan,
      coverage.map((entry) =>
        entry.partition === "visible-normal"
          ? { ...entry, expected: 1, seen: 1 }
          : entry,
      ),
    );
    const result = new OperationalReadiness(store).evaluate(exactInput, {
      now,
    });
    assert.equal(result.sourceDuplicate.status, "duplicate");
    if (result.sourceDuplicate.status === "duplicate")
      assert.equal(result.sourceDuplicate.matches[0]?.itemId, "remote-item");
    assert.equal(result.eligibility.status, "blocked");
    assert.equal(result.eligibility.ready, false);
  } finally {
    store.close();
  }
});

test("keeps name hints preliminary and never treats missing exact identities as eligible", () => {
  const { store, now } = fixture();
  try {
    const result = new OperationalReadiness(store).evaluate(
      {
        shop,
        hints: { brandName: "测试品牌", categoryPath: "办公用品" },
        sourceSku: "123456",
      },
      { now },
    );
    assert.equal(result.hints.authority, "preliminary-name-hints-only");
    assert.equal(result.authorization.status, "needs-input");
    assert.equal(result.sourceDuplicate.status, "clear");
    assert.equal(result.eligibility.ready, false);
  } finally {
    store.close();
  }
});

test("uses Catalog.authorize revocation semantics instead of local grant logic", () => {
  const { store, now } = fixture("revoked");
  try {
    const result = new OperationalReadiness(store).evaluate(exactInput, {
      now,
    });
    assert.equal(result.authorization.status, "blocked");
    assert.match(
      result.authorization.status === "blocked"
        ? result.authorization.reason
        : "",
      /没有覆盖/,
    );
    assert.equal(result.eligibility.ready, false);
  } finally {
    store.close();
  }
});
