import assert from "node:assert/strict";
import test from "node:test";
import type { Product } from "../src/model.js";
import {
  PRODUCT_FAMILY_MAX_AGE_MS,
  productFamilySnapshotHash,
  reuseProductFamilyFacts,
} from "../src/product-family.js";

const capturedAt = "2026-09-15T00:00:00.000Z";
const now = "2026-09-16T00:00:00.000Z";

function fact(value: string, evidence = `当前SKU页面明确标注${value}`) {
  return {
    value,
    sourceUrl: "https://item.jd.com/1001.html",
    capturedAt,
    evidence,
  };
}

function product(sku: string, specs: Product["specs"] = {}): Product {
  const url = `https://item.jd.com/${sku}.html`;
  return {
    sku,
    variant: "",
    url,
    title: { ...fact(`商品${sku}`), sourceUrl: url },
    price: null,
    specs,
    assets: [],
    capturedAt,
  };
}

function proof(donor: Product, recipient: Product) {
  return {
    version: 1,
    kind: "explicit-product-family-membership",
    familyId: "family-record-42",
    donorSku: donor.sku,
    recipientSku: recipient.sku,
    donorSnapshotHash: productFamilySnapshotHash(donor),
    recipientSnapshotHash: productFamilySnapshotHash(recipient),
    capturedAt,
    evidence: "厂家当前系列表逐项列出SKU 1001与SKU 1002属于同一产品家族",
    applicableFields: [
      { field: "品牌", evidence: "系列表声明全系列品牌一致" },
      { field: "生产厂家", evidence: "系列表声明全系列生产厂家一致" },
    ],
  };
}

test("reuses only permitted family facts and preserves both provenance layers", () => {
  const donor = product("1001", {
    品牌: fact("甲品牌", "供体详情页品牌参数"),
    生产厂家: fact("甲工厂", "供体详情页生产厂家参数"),
  });
  const recipient = product("1002");
  const result = reuseProductFamilyFacts({
    donor,
    recipient,
    proof: proof(donor, recipient),
    policy: { now },
  });

  assert.equal(result.product.specs.品牌.value, "甲品牌");
  assert.equal(result.product.specs.品牌.sourceUrl, donor.specs.品牌.sourceUrl);
  assert.equal(result.product.specs.品牌.capturedAt, capturedAt);
  assert.match(result.product.specs.品牌.evidence, /供体详情页品牌参数/);
  assert.match(
    result.product.specs.品牌.evidence,
    /供体SKU 1001 → 接收SKU 1002/,
  );
  assert.match(result.product.specs.品牌.evidence, /厂家当前系列表/);
  assert.match(result.product.specs.品牌.evidence, /全系列品牌一致/);
  assert.equal(result.decisions[0].outcome, "reused");
  assert.deepEqual(result.decisions[0].provenance?.donorFact, donor.specs.品牌);
  assert.deepEqual(recipient.specs, {});
});

test("rejects malformed or hostile proof instead of inferring membership", () => {
  const donor = product("1001", { 品牌: fact("甲品牌") });
  const recipient = product("1002");
  const hostile = {
    ...proof(donor, recipient),
    applicableFields: [
      { field: "重量", evidence: "标题看起来相同，所以应当相同" },
    ],
    inferredFromTitle: true,
  };
  const result = reuseProductFamilyFacts({
    donor,
    recipient,
    proof: hostile,
    policy: { now },
  });

  assert.deepEqual(result.product, recipient);
  assert.equal(result.decisions[0].reason, "invalid-proof");
});

test("rejects mismatched SKU and invalidates proof after either snapshot changes", () => {
  const donor = product("1001", { 品牌: fact("甲品牌") });
  const recipient = product("1002");
  const validProof = proof(donor, recipient);

  const wrongSku = reuseProductFamilyFacts({
    donor,
    recipient,
    proof: { ...validProof, recipientSku: "9999" },
    policy: { now },
  });
  assert.equal(wrongSku.decisions[0].reason, "sku-mismatch");

  const changedDonor = structuredClone(donor);
  changedDonor.title.evidence = "供体页面重新采集后的证据";
  const changed = reuseProductFamilyFacts({
    donor: changedDonor,
    recipient,
    proof: validProof,
    policy: { now },
  });
  assert.deepEqual(changed.product, recipient);
  assert.equal(changed.decisions[0].reason, "snapshot-mismatch");
});

test("never copies SKU-specific fields and never overwrites recipient conflicts", () => {
  const donor = product("1001", {
    品牌: fact("供体品牌"),
    重量: fact("1kg"),
    净含量: fact("500g"),
    包装数量: fact("12盒"),
  });
  const recipient = product("1002", { 品牌: fact("接收品牌") });
  const result = reuseProductFamilyFacts({
    donor,
    recipient,
    proof: {
      ...proof(donor, recipient),
      applicableFields: [{ field: "品牌", evidence: "品牌适用于整个系列" }],
    },
    policy: { now },
  });

  assert.equal(result.product.specs.品牌.value, "接收品牌");
  assert.equal(result.product.specs.重量, undefined);
  assert.equal(result.product.specs.净含量, undefined);
  assert.equal(result.product.specs.包装数量, undefined);
  assert.equal(result.decisions[0].reason, "recipient-already-has-fact");
});

test("applies the earlier of declared expiry and the bounded policy expiry", () => {
  const donor = product("1001", { 品牌: fact("甲品牌") });
  const recipient = product("1002");
  const base = proof(donor, recipient);

  const declaredExpired = reuseProductFamilyFacts({
    donor,
    recipient,
    proof: { ...base, expiresAt: "2026-09-15T12:00:00.000Z" },
    policy: { now, maxEvidenceAgeMs: PRODUCT_FAMILY_MAX_AGE_MS },
  });
  assert.equal(declaredExpired.decisions[0].reason, "expired-proof");

  const capped = reuseProductFamilyFacts({
    donor,
    recipient,
    proof: base,
    policy: {
      now: "2026-10-16T00:00:00.001Z",
      maxEvidenceAgeMs: PRODUCT_FAMILY_MAX_AGE_MS * 100,
    },
  });
  assert.equal(capped.decisions[0].reason, "expired-proof");
});
