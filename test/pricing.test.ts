import test from "node:test";
import assert from "node:assert/strict";
import { decidePrice, type PriceReview } from "../src/pricing.js";
const at = "2026-09-10T05:00:00.000Z";
const review = (): PriceReview => ({
  shopId: "ours",
  sourceSku: "900000000003",
  sourceIdentityHash: "facts",
  checkedAt: at,
  complete: true,
  searchUrls: [
    "https://b.csgmall.com.cn/mall-view/product/search?keyword=示例甲品牌",
  ],
  offers: [
    {
      id: "one",
      shopId: "other",
      url: "https://b.csgmall.com.cn/mall-view/product/detail?itemId=1",
      price: "17.20",
      checkedAt: at,
      match: "exact",
      evidence: ["相同条码及10g胶饵单盒"],
      available: true,
      unconditional: true,
      minimum: 1,
      shippingKnown: true,
    },
  ],
});
const now = Date.parse(at) + 1000;
test("uses integer cents and allows competitor price below subsidy", () =>
  assert.equal(
    decidePrice(review(), { value: "28.90", basis: "subsidy" }, now).value,
    "17.19",
  ));
test("never prices against our own listing", () => {
  const r = review();
  r.offers[0].shopId = "ours";
  assert.equal(
    decidePrice(r, { value: "28.90", basis: "subsidy" }, now).value,
    "28.90",
  );
});
test("unresolved plausible match prevents fallback or undercut", () => {
  const r = review();
  r.offers.push({
    ...r.offers[0],
    id: "powder",
    price: "4.89",
    match: "unknown",
  });
  assert.throws(() => decidePrice(r, null, now), /同款/);
});
test("different package is excluded with evidence", () => {
  const r = review();
  r.offers.push({
    ...r.offers[0],
    id: "powder",
    price: "4.89",
    match: "different",
    evidence: ["粉剂袋装，非胶饵盒装"],
  });
  assert.equal(decidePrice(r, null, now).value, "17.19");
});
test("incomplete search cannot be treated as no competitor", () => {
  const r = review();
  r.complete = false;
  assert.throws(
    () => decidePrice(r, { value: "28.90", basis: "subsidy" }, now),
    /完整/,
  );
});
test("stale and future quotes cannot produce a decision", () => {
  for (const offset of [-3600001, 60001]) {
    const r = review();
    r.offers[0].checkedAt = new Date(now + offset).toISOString();
    assert.throws(() => decidePrice(r, null, now), /时间|过期/);
  }
});
test("one cent quote cannot become a zero price", () => {
  const r = review();
  r.offers[0].price = "0.01";
  assert.throws(() => decidePrice(r, null, now), /零/);
});
test("missing subsidy label is never accepted as fallback", () => {
  const r = review();
  r.offers = [];
  assert.throws(() => decidePrice(r, { value: "19.90" }, now), /补贴价/);
});
test("conditional exact quote requires resolution", () => {
  const r = review();
  r.offers[0].minimum = 3;
  assert.throws(() => decidePrice(r, null, now), /购买条件/);
});

import { Store } from "../src/store.js";
import { PricingStore, pricingIdentity } from "../src/pricing-store.js";
import { example } from "../src/demo.js";
test("persisted review binds source identity and detects plan price tampering", () => {
  const store = new Store(":memory:");
  try {
    const db = new PricingStore(store),
      { product, plan } = example();
    const r = review();
    r.checkedAt = r.offers[0].checkedAt = new Date().toISOString();
    r.sourceSku = product.sku;
    r.sourceIdentityHash = pricingIdentity(product);
    const id = db.save(plan.shop, product, r);
    plan.pricingReviewId = id;
    plan.price = {
      ...plan.price,
      value: "17.19",
      basis: "competitor-minus-cent",
    };
    assert.doesNotThrow(() => db.verify(plan.shop, product, plan));
    plan.price.value = "4.88";
    assert.throws(() => db.verify(plan.shop, product, plan), /决策不一致/);
    product.specs["总净含量"].value = "1000g";
    assert.throws(() => db.verify(plan.shop, product, plan), /资料已变化/);
  } finally {
    store.close();
  }
});
test("missing or foreign-shop persisted review cannot authorize publishing", () => {
  const store = new Store(":memory:");
  try {
    const db = new PricingStore(store),
      { product, plan } = example();
    plan.pricingReviewId = "f45e44d1-fc45-4cd4-baa5-e641ce3a85be";
    assert.throws(() => db.verify(plan.shop, product, plan), /不存在/);
  } finally {
    store.close();
  }
});

import { Engine } from "../src/engine.js";
import { MemoryAdapter } from "../src/demo.js";
test("competitor plan submits without pretending source is subsidy", async () => {
  const store = new Store(":memory:");
  try {
    const { product, plan } = example();
    product.price = null;
    const db = new PricingStore(store);
    const r = review();
    r.checkedAt = r.offers[0].checkedAt = new Date().toISOString();
    r.sourceSku = product.sku;
    r.sourceIdentityHash = pricingIdentity(product);
    plan.pricingReviewId = db.save(plan.shop, product, r);
    plan.price = {
      ...plan.price,
      basis: "competitor-minus-cent",
      value: "17.19",
    };
    const row = store.put(plan.shop, product);
    store.setPlan(row.id, plan);
    const adapter = new MemoryAdapter();
    await new Engine(store, adapter).run(row.id, "submit");
    assert.equal(adapter.submits, 1);
    assert.equal(store.get(row.id).product?.price, null);
  } finally {
    store.close();
  }
});
test("forged competitor decision makes zero remote writes", async () => {
  const store = new Store(":memory:");
  try {
    const { product, plan } = example();
    plan.pricingReviewId = "f45e44d1-fc45-4cd4-baa5-e641ce3a85be";
    plan.price = {
      ...plan.price,
      basis: "competitor-minus-cent",
      value: "0.01",
    };
    const row = store.put(plan.shop, product);
    store.setPlan(row.id, plan);
    const adapter = new MemoryAdapter();
    await assert.rejects(
      new Engine(store, adapter).run(row.id, "submit"),
      /不存在/,
    );
    assert.equal(adapter.saves, 0);
    assert.equal(adapter.submits, 0);
  } finally {
    store.close();
  }
});
import { validate } from "../src/model.js";
test("new catalog plans cannot omit competitor search just because subsidy exists", () => {
  const { product, plan } = example();
  plan.rulesVersion = "catalog-v3";
  assert.ok(validate(product, plan).some((x) => x.includes("同款比价记录")));
});
test("completed publication rechecks remote without requiring an expired quote for a new write", async (t) => {
  const store = new Store(":memory:");
  try {
    const { product, plan } = example();
    const r = review();
    r.checkedAt = r.offers[0].checkedAt = new Date().toISOString();
    r.sourceSku = product.sku;
    r.sourceIdentityHash = pricingIdentity(product);
    plan.pricingReviewId = new PricingStore(store).save(plan.shop, product, r);
    plan.price = {
      ...plan.price,
      value: "17.19",
      basis: "competitor-minus-cent",
    };
    const row = store.put(plan.shop, product);
    store.setPlan(row.id, plan);
    const adapter = new MemoryAdapter(),
      engine = new Engine(store, adapter);
    await engine.run(row.id, "submit");
    t.mock.timers.enable({ apis: ["Date"], now: Date.now() + 7200000 });
    await engine.reconcile(row.id);
    await engine.run(row.id, "submit");
    assert.equal(adapter.saves, 1);
    assert.equal(adapter.submits, 1);
    assert.equal(store.get(row.id).state, "SUBMITTED");
  } finally {
    t.mock.timers.reset();
    store.close();
  }
});
