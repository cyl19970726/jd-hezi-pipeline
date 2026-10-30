import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.js";
import { example } from "../src/demo.js";
import { listingPrice } from "../src/listing-price.js";
import { validate } from "../src/model.js";
test("JD listing has no dependency on competitor records and keeps the explicit subsidy fact", () => {
  const s = new Store(":memory:");
  try {
    const { product, plan } = example();
    product.price = {
      value: "27.80",
      basis: "subsidy",
      sourceUrl: product.url,
      capturedAt: new Date().toISOString(),
      evidence: "页面明确标注补贴价",
    };
    const p = listingPrice(s, plan.shop, product);
    assert.equal(p.price.value, "27.80");
    assert.equal(p.pricingReviewId, undefined);
    assert.equal(p.rulesVersion, "catalog-jd-v1");
    assert.ok(
      !validate(product, { ...plan, ...p }).some((x) => /比价|补贴价/.test(x)),
    );
    product.price = null;
    assert.throws(() => listingPrice(s, plan.shop, product), /补贴价/);
  } finally {
    s.close();
  }
});
test("unlabelled source prices cannot silently become subsidy or fall back to a competitor", () => {
  const s = new Store(":memory:");
  try {
    const { product, plan } = example();
    product.price = {
      value: "34.9",
      sourceUrl: product.url,
      capturedAt: new Date().toISOString(),
      evidence: "无标签划线价",
    };
    assert.throws(() => listingPrice(s, plan.shop, product), /补贴价/);
  } finally {
    s.close();
  }
});

test("explicit JD price is a labelled fallback, never relabelled as subsidy", () => {
  const s = new Store(":memory:");
  try {
    const { product, plan } = example();
    product.price = {
      ...product.title,
      value: "34.90",
      basis: "jd-price",
      evidence: "优惠说明明确京东价34.90",
    };
    const p = listingPrice(s, plan.shop, product);
    assert.equal(p.price.basis, "jd-price");
    assert.equal(p.rulesVersion, "catalog-jd-v2");
    assert.ok(
      !validate(product, { ...plan, ...p }).some((x) =>
        /价格|售价|补贴价/.test(x),
      ),
    );
    s.setMeta("listing-price:" + plan.shop, "jd-subsidy");
    assert.throws(() => listingPrice(s, plan.shop, product), /补贴价/);
  } finally {
    s.close();
  }
});

test("regular-first policy requires recapture and accepts regular or explicit subsidy fallback", () => {
  const s = new Store(":memory:");
  try {
    const { product, plan } = example();
    const effective = new Date().toISOString();
    s.setMeta("listing-price:" + plan.shop, "jd-regular-preferred");
    s.setMeta("listing-price-effective-at:" + plan.shop, effective);
    product.price = {
      ...product.title,
      capturedAt: "2026-01-01T00:00:00Z",
      value: "55.8",
      basis: "subsidy",
      evidence: "补贴价55.8",
    };
    assert.throws(
      () => listingPrice(s, plan.shop, product),
      /旧报价必须重新采集/,
    );
    product.price.capturedAt = effective;
    assert.equal(listingPrice(s, plan.shop, product).price.value, "55.8");
    for (const label of ["日常价", "京东价"]) {
      product.price = {
        ...product.price,
        value: "59",
        basis: "jd-price",
        evidence: label + "59",
      };
      const result = listingPrice(s, plan.shop, product);
      assert.equal(result.price.value, "59");
      assert.equal(result.price.evidence, label + "59");
    }
    product.price = null;
    assert.throws(
      () => listingPrice(s, plan.shop, product),
      (error: Error) =>
        /缺少明确日常价/.test(error.message) && !/旧报价/.test(error.message),
    );
    product.price = {
      ...product.title,
      value: "59",
      basis: "jd-price",
      capturedAt: "不是时间",
      evidence: "日常价59",
    };
    assert.throws(
      () => listingPrice(s, plan.shop, product),
      (error: Error) =>
        /缺少有效采集时间证据/.test(error.message) &&
        !/旧报价/.test(error.message),
    );
    product.price = {
      ...product.price,
      value: "到手价",
      capturedAt: "2026-01-01T00:00:00Z",
    };
    assert.throws(
      () => listingPrice(s, plan.shop, product),
      (error: Error) =>
        /缺少明确日常价/.test(error.message) && !/旧报价/.test(error.message),
    );
  } finally {
    s.close();
  }
});
