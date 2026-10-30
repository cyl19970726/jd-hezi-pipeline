import test from "node:test";
import assert from "node:assert/strict";
import {
  ANDROID_CHECKPOINT_FRESH_MS,
  freshCheckpointTime,
  reusableAndroidShopFact,
} from "../src/android-checkpoints.js";

const now = Date.parse("2026-09-11T08:00:00.000Z");
const expected = {
  shop: "hezi-a",
  sku: "123",
  variant: "500mL 2瓶",
  sourceUrl: "https://item.jd.com/123.html",
};
const fact = {
  version: 1 as const,
  ...expected,
  shopName: "品牌京东自营旗舰店",
  observedAt: new Date(now - 1000).toISOString(),
  evidence: "当前商品店铺入口，店铺页名称核验",
};

test("shop fact reuse requires exact shop, SKU and currently selected variant", () => {
  assert.equal(
    reusableAndroidShopFact(fact, expected, now)?.shopName,
    fact.shopName,
  );
  for (const changed of [
    { ...expected, shop: "hezi-b" },
    { ...expected, sku: "456" },
    { ...expected, variant: "500mL 1瓶" },
    { ...expected, sourceUrl: "https://item.jd.com/456.html" },
  ])
    assert.equal(reusableAndroidShopFact(fact, changed, now), null);
});

test("shop facts expire after 24 hours and future observations fail closed", () => {
  const boundary = {
    ...fact,
    observedAt: new Date(now - ANDROID_CHECKPOINT_FRESH_MS).toISOString(),
  };
  assert.ok(reusableAndroidShopFact(boundary, expected, now));
  assert.equal(
    reusableAndroidShopFact(
      {
        ...fact,
        observedAt: new Date(
          now - ANDROID_CHECKPOINT_FRESH_MS - 1,
        ).toISOString(),
      },
      expected,
      now,
    ),
    null,
  );
  assert.equal(
    reusableAndroidShopFact(
      { ...fact, observedAt: new Date(now + 1).toISOString() },
      expected,
      now,
    ),
    null,
  );
});

test("unknown or malformed shop checkpoints are never reused", () => {
  for (const value of [
    null,
    {},
    { ...fact, version: 2 },
    { ...fact, shopName: "" },
    { ...fact, observedAt: "unknown" },
  ])
    assert.equal(reusableAndroidShopFact(value, expected, now), null);
});

test("shop checkpoint contains no quote that could bypass fresh price capture", () => {
  assert.equal("price" in fact, false);
  assert.equal("quote" in fact, false);
});

test("media checkpoint freshness rejects future timestamps", () => {
  assert.equal(
    freshCheckpointTime(new Date(now + 1).toISOString(), now),
    false,
  );
  assert.equal(
    freshCheckpointTime(new Date(now - 1000).toISOString(), now),
    true,
  );
});
