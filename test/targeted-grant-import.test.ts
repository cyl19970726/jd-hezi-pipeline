import { test } from "node:test";
import assert from "node:assert/strict";
import { Catalog } from "../src/catalog.js";
import { Store } from "../src/store.js";
import { importTargetedGrantReceipt } from "../src/targeted-grant-import.js";

const shop = "shop";
const sourceUrl =
  "https://b.csgmall.com.cn/shop-view/#/shop-view/brand/regulate";
const checkedAt = "2026-09-21T02:00:00.000Z";

function setup() {
  const store = new Store(":memory:");
  new Catalog(store).import({
    shop,
    brands: [
      {
        id: "1008901",
        name: "维达",
        sourceUrl,
        checkedAt: "2026-09-20T00:00:00.000Z",
      },
    ],
    categories: [
      {
        id: "root",
        parentId: null,
        name: "日用",
        path: "日用",
        selectable: false,
        sourceUrl,
        checkedAt: "2026-09-20T00:00:00.000Z",
      },
    ],
    grants: [
      {
        id: "34284",
        brandId: "1008901",
        status: "approved",
        validFrom: "2020-01-01T00:00:00.000Z",
        validUntil: "2027-01-01T00:00:00.000Z",
        scopes: [{ categoryId: "root", descendants: true }],
        sourceUrl,
        checkedAt: "2026-09-20T00:00:00.000Z",
      },
    ],
  });
  return store;
}

function receipt(overrides: Record<string, unknown> = {}) {
  return {
    shop,
    supplierId: "42",
    grantId: "34284",
    brandId: "1008901",
    sourceUrl,
    checkedAt,
    categoryEvidence: {
      sourceUrl: "https://b.csgmall.com.cn/shop-view/#/shop-view/goods/add",
      checkedAt: "2026-09-21T01:55:00.000Z",
      nodes: [
        {
          id: "root",
          parentId: null,
          name: "日用",
          path: "日用",
          selectable: false,
        },
        {
          id: "leaf",
          parentId: "root",
          name: "纸品",
          path: "日用 > 纸品",
          selectable: true,
        },
      ],
    },
    detail: {
      id: "34284",
      supplierId: "42",
      supplierName: shop,
      brandId: "1008901",
      brandName: "维达",
      supplierBrandStatus: 1,
      validStatus: 0,
      validTimeBegin: "2020-01-01",
      validTimeEnd: "2027-01-01",
      supplierBrandCatVos: [
        { catId: "root", status: 1 },
        { catId: "unrelated", status: 1 },
      ],
    },
    ...overrides,
  };
}

const targetPlan = {
  shop,
  brand: "维达",
  categoryPath: "日用 > 纸品",
  catalogBinding: { brandId: "1008901", categoryId: "leaf" },
};

test("targeted receipt refreshes only its current projection and verified category path", () => {
  const store = setup();
  try {
    const result = importTargetedGrantReceipt(
      store,
      receipt(),
      Date.parse(checkedAt),
    );
    assert.deepEqual(result, {
      grantId: "current:34284",
      brandId: "1008901",
      categoryId: "leaf",
      status: "approved",
      eligible: true,
      scopes: ["root"],
      checkedAt,
    });
    assert.equal(
      store.db
        .prepare(
          "SELECT status FROM catalog_grants WHERE shop=? AND id='34284'",
        )
        .get(shop)?.status,
      "approved",
    );
    assert.equal(
      store.db
        .prepare(
          "SELECT checked_at FROM catalog_categories WHERE shop=? AND id='leaf'",
        )
        .get(shop)?.checked_at,
      receipt().categoryEvidence.checkedAt,
    );
    assert.equal(
      store.db
        .prepare(
          "SELECT 1 FROM catalog_categories WHERE shop=? AND id='unrelated'",
        )
        .get(shop),
      undefined,
    );
  } finally {
    store.close();
  }
});

test("a newer revoked projection blocks its matching older historical grant", () => {
  const store = setup();
  try {
    importTargetedGrantReceipt(
      store,
      receipt({ detail: { ...receipt().detail, supplierBrandStatus: 3 } }),
      Date.parse(checkedAt),
    );
    const grant = store.db
      .prepare("SELECT status FROM catalog_grants WHERE shop=? AND id=?")
      .get(shop, "current:34284");
    assert.equal(grant?.status, "revoked");
    assert.equal(
      store.db
        .prepare(
          "SELECT COUNT(*) AS n FROM catalog_scopes WHERE shop=? AND grant_id=?",
        )
        .get(shop, "current:34284")?.n,
      0,
    );
    assert.throws(
      () =>
        new Catalog(store).authorize(targetPlan as any, Date.parse(checkedAt)),
      /没有覆盖/,
    );
  } finally {
    store.close();
  }
});

test("valid authorization preserves all explicit active scopes already in the catalog and reports target eligibility", () => {
  const store = setup();
  try {
    store.db
      .prepare("INSERT INTO catalog_categories VALUES(?,?,?,?,?,?,?,?)")
      .run(
        shop,
        "other",
        "root",
        "其他纸品",
        "日用 > 其他纸品",
        1,
        sourceUrl,
        "2026-09-20T00:00:00.000Z",
      );
    const result = importTargetedGrantReceipt(
      store,
      receipt({
        detail: {
          ...receipt().detail,
          supplierBrandCatVos: [{ catId: "other", status: 1 }],
        },
      }),
      Date.parse(checkedAt),
    );
    assert.equal(result.status, "approved");
    assert.equal(result.eligible, false);
    assert.deepEqual(result.scopes, ["other"]);
    assert.equal(
      store.db
        .prepare(
          "SELECT checked_at FROM catalog_categories WHERE shop=? AND id=?",
        )
        .get(shop, "other")?.checked_at,
      "2026-09-20T00:00:00.000Z",
    );
  } finally {
    store.close();
  }
});

test("unknown validity refreshes category evidence but leaves authorization projection untouched", () => {
  const store = setup();
  try {
    const result = importTargetedGrantReceipt(
      store,
      receipt({
        detail: {
          ...receipt().detail,
          validStatus: 1,
          validTimeBegin: undefined,
          validTimeEnd: undefined,
        },
      }),
      Date.parse(checkedAt),
    );
    assert.deepEqual(result.status, "unknown");
    assert.equal(
      store.db
        .prepare("SELECT 1 FROM catalog_grants WHERE shop=? AND id=?")
        .get(shop, "current:34284"),
      undefined,
    );
    assert.equal(
      store.db
        .prepare(
          "SELECT checked_at FROM catalog_categories WHERE shop=? AND id=?",
        )
        .get(shop, "leaf")?.checked_at,
      receipt().categoryEvidence.checkedAt,
    );
  } finally {
    store.close();
  }
});

test("unknown validity shadows a prior current projection without inventing dates", () => {
  const store = setup();
  try {
    importTargetedGrantReceipt(store, receipt(), Date.parse(checkedAt));
    assert.equal(
      new Catalog(store).authorize(targetPlan as any, Date.parse(checkedAt))
        .grantId,
      "current:34284",
    );
    const result = importTargetedGrantReceipt(
      store,
      receipt({
        detail: {
          ...receipt().detail,
          validStatus: 1,
          validTimeBegin: undefined,
          validTimeEnd: undefined,
        },
      }),
      Date.parse(checkedAt),
    );
    assert.equal(result.status, "unknown");
    const projection = store.db
      .prepare(
        "SELECT status,valid_from,valid_until,checked_at FROM catalog_grants WHERE shop=? AND id=?",
      )
      .get(shop, "current:34284");
    assert.equal(projection?.status, "pending");
    assert.equal(projection?.valid_from, "2019-12-31T16:00:00.000Z");
    assert.equal(projection?.valid_until, "2027-01-01T15:59:59.000Z");
    assert.equal(projection?.checked_at, checkedAt);
    assert.throws(
      () =>
        new Catalog(store).authorize(targetPlan as any, Date.parse(checkedAt)),
      /没有覆盖/,
    );
  } finally {
    store.close();
  }
});

test("a targeted projection does not hide a different valid grant", () => {
  const store = setup();
  try {
    store.db
      .prepare("INSERT INTO catalog_grants VALUES(?,?,?,'approved',?,?,?,?)")
      .run(
        shop,
        "independent",
        "1008901",
        "2020-01-01T00:00:00.000Z",
        "2027-01-01T00:00:00.000Z",
        sourceUrl,
        "2026-09-21T01:00:00.000Z",
      );
    store.db
      .prepare("INSERT INTO catalog_scopes VALUES(?,?,?,?)")
      .run(shop, "independent", "root", 1);
    importTargetedGrantReceipt(
      store,
      receipt({ detail: { ...receipt().detail, supplierBrandStatus: 3 } }),
      Date.parse(checkedAt),
    );
    assert.equal(
      new Catalog(store).authorize(targetPlan as any, Date.parse(checkedAt))
        .grantId,
      "independent",
    );
  } finally {
    store.close();
  }
});

test("an older targeted receipt cannot clear scopes from a newer current projection", () => {
  const store = setup();
  try {
    importTargetedGrantReceipt(store, receipt(), Date.parse(checkedAt));
    const older = "2026-09-21T01:00:00.000Z";
    assert.throws(
      () =>
        importTargetedGrantReceipt(
          store,
          receipt({
            checkedAt: older,
            detail: { ...receipt().detail, supplierBrandStatus: 3 },
          }),
          Date.parse(checkedAt),
        ),
      /早于当前投影/,
    );
    assert.equal(
      store.db
        .prepare(
          "SELECT COUNT(*) AS n FROM catalog_scopes WHERE shop=? AND grant_id=?",
        )
        .get(shop, "current:34284")?.n,
      1,
    );
  } finally {
    store.close();
  }
});

test("receipt cannot relabel a historical or current grant ID, or claim another supplier", () => {
  const store = setup();
  try {
    assert.throws(
      () =>
        importTargetedGrantReceipt(
          store,
          receipt({ brandId: "999" }),
          Date.parse(checkedAt),
        ),
      /不完全一致|目录/,
    );
    store.db
      .prepare("INSERT INTO catalog_brands VALUES(?,?,?,?,?)")
      .run(shop, "999", "另一品牌", sourceUrl, "2026-09-20T00:00:00.000Z");
    store.db
      .prepare("INSERT INTO catalog_grants VALUES(?,?,?,'approved',?,?,?,?)")
      .run(
        shop,
        "current:34284",
        "999",
        "2020-01-01T00:00:00.000Z",
        "2027-01-01T00:00:00.000Z",
        sourceUrl,
        "2026-09-20T00:00:00.000Z",
      );
    assert.throws(
      () => importTargetedGrantReceipt(store, receipt(), Date.parse(checkedAt)),
      /绑定另一品牌/,
    );
    assert.throws(
      () =>
        importTargetedGrantReceipt(
          store,
          receipt({ detail: { ...receipt().detail, supplierId: "43" } }),
          Date.parse(checkedAt),
        ),
      /不完全一致/,
    );
  } finally {
    store.close();
  }
});

test("rejects an unverified path rather than refreshing a category by assertion", () => {
  const store = setup();
  try {
    assert.throws(
      () =>
        importTargetedGrantReceipt(
          store,
          receipt({
            categoryEvidence: {
              ...receipt().categoryEvidence,
              nodes: [
                {
                  id: "leaf",
                  parentId: null,
                  name: "纸品",
                  path: "not-proof",
                  selectable: true,
                },
              ],
            },
          }),
          Date.parse(checkedAt),
        ),
      /已核验路径/,
    );
  } finally {
    store.close();
  }
});
