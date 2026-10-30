import { test } from "node:test";
import assert from "node:assert/strict";
import { enrichJd } from "../src/browser/jd-business.js";
import type { Product } from "../src/model.js";
const p: Product = {
  sku: "123",
  variant: "",
  url: "https://item.jd.com/123.html",
  title: {
    value: "x",
    sourceUrl: "https://item.jd.com/123.html",
    capturedAt: "2026-09-09T00:00:00Z",
    evidence: "page",
  },
  price: null,
  specs: {},
  assets: [],
  capturedAt: "2026-09-09T00:00:00Z",
};
test("business response is bound to requested SKU and only retains product facts", () => {
  assert.throws(() => enrichJd(p, { wareInfoReadMap: { product_id: "456" } }));
  const result = enrichJd(p, {
    wareInfoReadMap: { product_id: "123", weight: "0.02", warranty: "无质保" },
    userInfo: { secret: "not retained" },
  });
  assert.equal(result.specs["商品毛重"].value, "0.02kg");
  assert.equal(result.specs["京东质保"].value, "无质保");
  assert.equal(JSON.stringify(result).includes("secret"), false);
  assert.deepEqual(p.specs, {});
});
test("invalid or zero weight does not become a fact", () => {
  for (const weight of ["0", "unknown", null])
    assert.equal(
      enrichJd(p, { wareInfoReadMap: { product_id: "123", weight } }).specs[
        "商品毛重"
      ],
      undefined,
    );
});
const business = (priceItemList: any[]) => ({
  wareInfoReadMap: { product_id: "123" },
  warePriceGatherVO: { priceItemList },
  price: { p: "1.00", op: "2.00", m: "3.00" },
});
test("SKU-bound structured jdPrice supplements a missing DOM price", () => {
  const result = enrichJd(
    p,
    business([
      {
        price: "39",
        priceType: "doublePrice",
        priceLabelList: [{ labelTxt: "学生价" }],
      },
      { price: "49", priceType: "jdPrice", priceLabelList: [] },
      { price: "45", priceType: "plusPrice" },
    ]),
  );
  assert.equal(result.price?.value, "49.00");
  assert.equal(result.price?.basis, "jd-price");
  assert.match(result.price?.evidence ?? "", /priceType=jdPrice/);
  assert.doesNotMatch(result.price?.evidence ?? "", /DOM|可见标签/);
});
test("structured regularPrice has priority over jdPrice", () => {
  const result = enrichJd(
    p,
    business([
      {
        price: "129",
        priceType: "regularPrice",
        priceLabelList: [{ labelTxt: "日常价" }],
      },
      { price: "139", priceType: "jdPrice" },
    ]),
  );
  assert.equal(result.price?.value, "129.00");
  assert.match(result.price?.evidence ?? "", /priceType=regularPrice/);
});
test("invalid, personalized and raw response prices are never selected", () => {
  for (const list of [
    [{ price: "0", priceType: "jdPrice" }],
    [{ price: "39", priceType: "doublePrice" }],
    [{ price: "39", priceType: "plusPrice" }],
    [{ price: "39", priceType: "finalPrice" }],
  ])
    assert.equal(enrichJd(p, business(list)).price, null);
  assert.equal(enrichJd(p, business([])).price, null);
});
test("an invalid explicit regularPrice blocks jdPrice fallback", () => {
  for (const regularPrice of ["0", "bad", null])
    assert.equal(
      enrichJd(
        p,
        business([
          { price: regularPrice, priceType: "regularPrice" },
          { price: "59", priceType: "jdPrice" },
        ]),
      ).price,
      null,
    );
  assert.equal(
    enrichJd(
      p,
      business([
        { price: "59", priceType: "regularPrice" },
        { price: "bad", priceType: "regularPrice" },
        { price: "58", priceType: "jdPrice" },
      ]),
    ).price,
    null,
  );
});
test("adopted jdPrice requires every same-type entry to be valid", () => {
  assert.equal(
    enrichJd(
      p,
      business([
        { price: "59", priceType: "jdPrice" },
        { price: "0", priceType: "jdPrice" },
      ]),
    ).price,
    null,
  );
  assert.equal(
    enrichJd(
      p,
      business([
        { price: "59", priceType: "jdPrice" },
        { price: "59.00", priceType: "jdPrice" },
      ]),
    ).price?.value,
    "59.00",
  );
});
test("structured and DOM regular conflicts fail closed", () => {
  const dom = {
    ...p,
    price: {
      ...p.title,
      value: "59.00",
      basis: "jd-price" as const,
    },
    priceCandidates: [{ text: "59", selector: "日常价", basis: "jd-price" }],
  };
  assert.equal(
    enrichJd(dom, business([{ price: "60", priceType: "jdPrice" }])).price,
    null,
  );
  assert.equal(
    enrichJd(
      { ...dom, priceEvidence: { regularPriceAmbiguous: true } } as any,
      business([{ price: "59", priceType: "jdPrice" }]),
    ).price,
    null,
  );
});
test("equal DOM and structured prices retain direct DOM evidence", () => {
  const dom = {
    ...p,
    price: {
      ...p.title,
      value: "59",
      evidence: "日常价：¥59",
      basis: "jd-price" as const,
    },
    priceCandidates: [{ text: "59.00", selector: "日常价", basis: "jd-price" }],
  };
  const result = enrichJd(
    dom,
    business([{ price: "59.00", priceType: "jdPrice" }]),
  );
  assert.equal(result.price?.value, "59.00");
  assert.equal(result.price?.evidence, "日常价：¥59");
});
test("duplicate normalized structured prices agree; distinct prices conflict", () => {
  assert.equal(
    enrichJd(
      p,
      business([
        { price: "59", priceType: "jdPrice" },
        { price: "59.00", priceType: "jdPrice" },
      ]),
    ).price?.value,
    "59.00",
  );
  assert.equal(
    enrichJd(
      p,
      business([
        { price: "59", priceType: "jdPrice" },
        { price: "60", priceType: "jdPrice" },
      ]),
    ).price,
    null,
  );
});
