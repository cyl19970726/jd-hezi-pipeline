import test from "node:test";
import assert from "node:assert/strict";
import { example } from "../src/demo.js";
import {
  completeAndroid,
  requireAndroidPriceOnlyProduct,
} from "../src/android-complete.js";
import { Store } from "../src/store.js";
import type { AndroidSession } from "../src/android-session.js";

test("price-only result keeps an explicit positive quote and excludes media", () => {
  const product = example().product;
  const result = requireAndroidPriceOnlyProduct(product);
  assert.equal(result.price?.value, product.price?.value);
  assert.equal(result.price?.basis, "subsidy");
  assert.deepEqual(result.assets, []);
  assert.notEqual(result, product);
});

test("price-only result fails without an explicit positive price basis", () => {
  const product = example().product;
  for (const price of [
    null,
    { ...product.price!, basis: undefined },
    { ...product.price!, value: "0" },
    { ...product.price!, value: "不是价格" },
  ])
    assert.throws(
      () => requireAndroidPriceOnlyProduct({ ...product, price }),
      /明确补贴价或京东价/,
    );
});

test("price-only completion returns before shop and media checkpoint work", async () => {
  const store = new Store(":memory:");
  try {
    const product = example().product;
    product.specs["京东销售规格"] = {
      ...product.title,
      value: "500mL 2瓶",
    };
    const selected =
      '<hierarchy><node content-desc="已选中款式 500mL 2瓶" /></hierarchy>';
    const unavailable = new Proxy(
      {},
      {
        get: () => () => {
          throw new Error(
            "price-only must not use the shop, album or media session",
          );
        },
      },
    ) as AndroidSession;
    const result = await completeAndroid(
      store,
      "ours",
      "/unused",
      unavailable,
      product,
      selected,
      { priceOnly: true },
    );
    assert.equal(result.price?.basis, "subsidy");
    assert.deepEqual(result.assets, []);
    assert.equal(store.meta("android-capture:ours:" + product.sku), null);
    assert.equal(store.meta("android-shop-fact:ours:" + product.sku), null);
  } finally {
    store.close();
  }
});
