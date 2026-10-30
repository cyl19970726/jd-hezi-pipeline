import assert from "node:assert/strict";
import test from "node:test";
import {
  MEDIA_ASSESSMENT_RULE_VERSION,
  assessMedia,
  type MediaEvidenceRecord,
} from "../src/media-assessment.js";
import type { Product } from "../src/model.js";

const capturedAt = "2026-09-16T01:00:00.000Z";
const saleSpec = {
  value: "清新茉莉 2瓶",
  sourceUrl: "https://item.jd.com/123.html",
  capturedAt,
  evidence: "selected sale specification shown for SKU 123",
};
const product: Product = {
  sku: "123",
  variant: "清新茉莉 2瓶",
  url: "https://item.jd.com/123.html",
  title: { ...saleSpec, value: "驱蚊液" },
  price: null,
  specs: { 京东销售规格: saleSpec },
  assets: [
    {
      role: "main",
      order: 0,
      url: "https://img.example/a.jpg",
      sha256: "a".repeat(64),
    },
    {
      role: "detail",
      order: 0,
      url: "https://img.example/b.jpg",
      sha256: "b".repeat(64),
    },
  ],
  capturedAt,
};

function record(
  overrides: Partial<MediaEvidenceRecord> = {},
): MediaEvidenceRecord {
  return {
    id: "legacy-review-0",
    subject: {
      sku: product.sku,
      variant: product.variant,
      selectedSaleSpec: saleSpec,
    },
    asset: {
      role: "main",
      order: 0,
      url: product.assets[0].url,
      sha256: "a".repeat(64),
    },
    verdict: "rejected",
    reviewKind: "human",
    reviewer: "operator-li",
    ruleVersion: MEDIA_ASSESSMENT_RULE_VERSION,
    reviewedAt: capturedAt,
    evidence: [
      {
        source: "manual/session",
        capturedAt,
        observation: "legacy inspection",
      },
    ],
    ...overrides,
  };
}

test("source policy retains every selected-SKU asset without image review or hash deduplication", () => {
  const repeated = {
    ...product,
    assets: [
      product.assets[0],
      { ...product.assets[0], order: 1 },
      { ...product.assets[1], order: 0 },
    ],
  };
  const result = assessMedia(repeated, []);
  assert.equal(result.verdict, "approved");
  assert.equal(result.mediaReviewed, true);
  assert.deepEqual(
    result.assets.map((asset) => asset.verdict),
    ["approved", "approved", "approved"],
  );
});

test("legacy evidence remains auditable but cannot exclude a source asset", () => {
  const result = assessMedia(product, [record()]);
  assert.equal(result.verdict, "approved");
  assert.equal(result.assets[0].verdict, "approved");
  assert.deepEqual(result.assets[0].evidenceRecordIds, ["legacy-review-0"]);
});

test("source SKU identity and contiguous source order remain enforced", () => {
  const wrongSku = assessMedia({ ...product, sku: "999" }, []);
  assert.equal(wrongSku.verdict, "rejected");
  assert.match(wrongSku.assets[0].reasons.join(" "), /SKU/);

  const reordered = assessMedia(
    { ...product, assets: [{ ...product.assets[0], order: 2 }] },
    [],
  );
  assert.equal(reordered.verdict, "rejected");
  assert.match(reordered.assets[0].reasons.join(" "), /order/);
});

test("old media evidence digest is no longer a validation gate", async () => {
  const { example } = await import("../src/demo.js");
  const { mediaSubjectDigest, validate } = await import("../src/model.js");
  const { product, plan } = example();
  plan.mediaReviewed = false;
  plan.mediaEvidenceDigest = mediaSubjectDigest(product);
  product.assets[1].sha256 = product.assets[0].sha256;
  product.assets[0].url += "?changed=1";
  assert.ok(
    !validate(product, plan).some((message) =>
      /图片内容尚未核对|图片重复|适用性证据已失效/.test(message),
    ),
  );
});
