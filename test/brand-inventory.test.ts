import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.js";
import {
  BrandInventory,
  potentiallyActiveBrand,
} from "../src/brand-inventory.js";
const row = (id: number) => ({
  id,
  brandId: id,
  brandName: "品牌" + id,
  supplierId: 42,
  supplierName: "shop",
  supplierBrandStatus: 1,
  validStatus: 0,
  validTimeBegin: "2020-01-01",
  validTimeEnd: "2099-01-01",
});
const page = (n: number, total: number, rows: any[]) => ({
  pageNum: n,
  pageSize: 10,
  totalCount: total,
  result: rows,
});
test("brand snapshot resumes after committed pages and never treats partial coverage as complete", () => {
  const s = new Store(":memory:");
  try {
    const a = new BrandInventory(s),
      id = a.start("shop", "42");
    a.savePage(
      id,
      page(
        1,
        11,
        Array.from({ length: 10 }, (_, i) => row(i + 1)),
      ),
    );
    const b = new BrandInventory(s);
    assert.equal(b.get(id).next_page, 2);
    assert.throws(() => b.complete(id), /不完整/);
    b.savePage(id, page(2, 11, [row(11)]));
    for (const r of b.pending(id))
      b.saveDetail(id, r.grant_id, { ...r.list, supplierBrandCatVos: [] });
    assert.equal(b.complete(id).listed, 11);
  } finally {
    s.close();
  }
});
test("duplicate, foreign identity or changed total rolls back page and keeps cursor", () => {
  const s = new Store(":memory:");
  try {
    const a = new BrandInventory(s),
      id = a.start("shop", "42");
    a.savePage(
      id,
      page(
        1,
        11,
        Array.from({ length: 10 }, (_, i) => row(i + 1)),
      ),
    );
    assert.throws(() => a.savePage(id, page(2, 11, [row(1)])));
    assert.throws(() => a.savePage(id, page(2, 12, [row(11), row(12)])));
    assert.throws(() =>
      a.savePage(id, page(2, 11, [{ ...row(11), supplierId: 99 }])),
    );
    assert.equal(a.get(id).next_page, 2);
  } finally {
    s.close();
  }
});
test("pending extensions, disabled and expired grants are not active; China end date remains inclusive", () => {
  const now = Date.parse("2026-09-10T15:00:00Z");
  assert.equal(
    potentiallyActiveBrand({ ...row(1), validTimeEnd: "2026-09-10" }, now),
    true,
  );
  for (const supplierBrandStatus of [0, 2, 3, 5, 6])
    assert.equal(
      potentiallyActiveBrand({ ...row(1), supplierBrandStatus }, now),
      false,
    );
  assert.equal(
    potentiallyActiveBrand({ ...row(1), validTimeEnd: "2026-09-09" }, now),
    false,
  );
});

test("only a complete snapshot replaces old grants; inactive category entries never authorize", async () => {
  const { Catalog } = await import("../src/catalog.js");
  const s = new Store(":memory:");
  try {
    const c = new Catalog(s),
      i = new BrandInventory(s),
      at = new Date().toISOString(),
      url = "https://b.csgmall.com.cn/";
    c.import({
      shop: "shop",
      categories: [
        {
          id: "c1",
          parentId: null,
          name: "类目",
          path: "类目",
          selectable: true,
          checkedAt: at,
          sourceUrl: url,
        },
      ],
      brands: [{ id: "1", name: "品牌1", checkedAt: at, sourceUrl: url }],
      grants: [
        {
          id: "old",
          brandId: "1",
          status: "approved",
          validFrom: "2020-01-01T00:00:00Z",
          validUntil: "2099-01-01T00:00:00Z",
          scopes: [{ categoryId: "c1", descendants: true }],
          checkedAt: at,
          sourceUrl: url,
        },
      ],
    });
    const id = i.start("shop", "42");
    i.savePage(id, page(1, 2, [row(1), { ...row(2), supplierBrandStatus: 3 }]));
    assert.throws(() => i.activateCatalog(id), /尚未完成/);
    assert.equal(
      s.db.prepare("select status from catalog_grants where id='old'").get()
        ?.status,
      "approved",
    );
    i.saveDetail(id, "1", {
      ...row(1),
      supplierBrandCatVos: [
        { catId: "c1", status: 1 },
        { catId: "unknown-old", status: 0 },
      ],
    });
    i.complete(id);
    const result = i.activateCatalog(id);
    assert.equal(result.grants, 1);
    assert.equal(
      s.db.prepare("select status from catalog_grants where id='old'").get()
        ?.status,
      "revoked",
    );
    assert.equal(
      s.db
        .prepare(
          "select count(*) as n from catalog_scopes where grant_id='current:1'",
        )
        .get()?.n,
      1,
    );
  } finally {
    s.close();
  }
});
