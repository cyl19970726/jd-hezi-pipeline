import test from "node:test";
import assert from "node:assert/strict";
import { example } from "../src/demo.js";
import {
  COLLECTION_PRICE_FRESH_MS,
  collectionNeed,
  mergeFreshPrice,
} from "../src/collection-needs.js";
import type { Product } from "../src/model.js";

const at = Date.parse("2026-09-12T00:00:00.000Z");
const fact = (value: string, sku = "100000000001") => ({
  value,
  sourceUrl: `https://item.jd.com/${sku}.html`,
  capturedAt: new Date(at).toISOString(),
  evidence: "测试明确标签",
});
function ready(): Product {
  const p = structuredClone(example().product);
  p.capturedAt = "2020-01-01T00:00:00.000Z";
  p.price = { ...fact("21.90"), basis: "jd-price" };
  p.specs["商品毛重"] = fact("0.5kg");
  p.specs["手机原图完整性"] = fact("已逐张核对");
  p.specs["京东销售规格"] = fact("蓝色 500g");
  return p;
}

test("collection need uses source readiness then requests only stale or missing price", () => {
  const p = ready();
  assert.equal(collectionNeed(null, "browser", at), "full");
  assert.equal(collectionNeed(p, "browser", at), "none");
  assert.equal(collectionNeed(p, "android", at), "none");
  delete p.specs["商品毛重"];
  assert.equal(collectionNeed(p, "browser", at), "full");
  assert.equal(collectionNeed(p, "android", at), "none");
  delete p.price;
  assert.equal(collectionNeed(p, "android", at), "price");
});

test("price freshness rejects old, future, wrong basis and foreign source URL", () => {
  const p = ready();
  assert.equal(
    collectionNeed(p, "browser", at + COLLECTION_PRICE_FRESH_MS + 1),
    "price",
  );
  assert.equal(collectionNeed(p, "browser", at - 1), "price");
  p.price = { ...fact("21.90"), basis: undefined };
  assert.equal(collectionNeed(p, "browser", at), "price");
  p.price = {
    ...fact("21.90", "999"),
    basis: "subsidy",
  };
  assert.equal(collectionNeed(p, "browser", at), "price");
});

test("fresh price merge changes only price and leaves input facts and assets untouched", () => {
  const existing = ready(),
    quote = structuredClone(existing);
  quote.price = {
    ...fact("19.90"),
    basis: "subsidy",
    evidence: "价格区明确补贴价",
  };
  quote.title.value = "不应采用的标题";
  quote.assets = [];
  quote.capturedAt = new Date(at + 1000).toISOString();
  const before = structuredClone(existing);
  const merged = mergeFreshPrice(existing, quote, at + 1000);
  assert.deepEqual(existing, before);
  assert.equal(merged.price?.value, "19.90");
  assert.deepEqual(merged.title, before.title);
  assert.deepEqual(merged.specs, before.specs);
  assert.deepEqual(merged.assets, before.assets);
  assert.equal(merged.capturedAt, before.capturedAt);
});

test("price merge rejects SKU, URL, variant and selected-spec mismatches", () => {
  const existing = ready(),
    quote = structuredClone(existing);
  quote.price = { ...fact("19.90"), basis: "jd-price" };
  const reject = (changed: Product) =>
    assert.throws(
      () => mergeFreshPrice(existing, changed, at),
      /不一致|当前SKU/,
    );
  reject({ ...quote, sku: "999", url: "https://item.jd.com/999.html" });
  reject({ ...quote, url: "https://item.jd.com/999.html" });
  reject({ ...quote, variant: "另一变体" });
  reject({
    ...quote,
    specs: {
      ...quote.specs,
      京东销售规格: { ...quote.specs["京东销售规格"], value: "红色 1kg" },
    },
  });
});

test("price merge rejects wrong basis, stale and future quotes", () => {
  const existing = ready(),
    quote = structuredClone(existing);
  quote.price = { ...fact("19.90"), basis: undefined };
  assert.throws(() => mergeFreshPrice(existing, quote, at), /明确、有效/);
  quote.price = {
    ...fact("19.90"),
    basis: "jd-price",
    capturedAt: new Date(at - COLLECTION_PRICE_FRESH_MS - 1).toISOString(),
  };
  assert.throws(() => mergeFreshPrice(existing, quote, at), /明确、有效/);
  quote.price = {
    ...quote.price,
    capturedAt: new Date(at + 1).toISOString(),
  };
  assert.throws(() => mergeFreshPrice(existing, quote, at), /明确、有效/);
});

test("quote merge rejects money formats the publisher cannot accept", () => {
  for (const value of ["1e3", "19.999", "-1", "0", "NaN"]) {
    const p = ready();
    const quote = structuredClone(p);
    quote.price!.value = value;
    assert.equal(collectionNeed(quote, "browser", at), "price");
    assert.throws(() => mergeFreshPrice(p, quote, at));
  }
});
