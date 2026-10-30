import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  applyFamilyEvidence,
  assessStoredMedia,
  registerFamilyEvidence,
  registerMediaEvidence,
} from "../src/automation-evidence.js";
import {
  MEDIA_ASSESSMENT_RULE_VERSION,
  type MediaEvidenceRecord,
} from "../src/media-assessment.js";
import type { Product } from "../src/model.js";
import {
  productFamilySnapshotHash,
  type ProductFamilyProof,
} from "../src/product-family.js";
import { Store } from "../src/store.js";

const now = new Date().toISOString();

function fact(value: string, sku: string) {
  return {
    value,
    sourceUrl: `https://item.jd.com/${sku}.html`,
    capturedAt: now,
    evidence: `SKU ${sku} 当前页面明确标注 ${value}`,
  };
}

function product(sku: string, specs: Product["specs"] = {}): Product {
  return {
    sku,
    variant: "标准装",
    url: `https://item.jd.com/${sku}.html`,
    title: fact(`商品${sku}`, sku),
    price: null,
    specs,
    assets: [],
    capturedAt: now,
  };
}

function familyProof(donor: Product, recipient: Product): ProductFamilyProof {
  return {
    version: 1,
    kind: "explicit-product-family-membership",
    familyId: "manufacturer-family-sheet-1",
    donorSku: donor.sku,
    recipientSku: recipient.sku,
    donorSnapshotHash: productFamilySnapshotHash(donor),
    recipientSnapshotHash: productFamilySnapshotHash(recipient),
    capturedAt: now,
    evidence: "厂家当前系列表明确逐项列出两个SKU",
    applicableFields: [
      { field: "品牌", evidence: "厂家系列表声明品牌覆盖全系列" },
    ],
  };
}

test("family evidence persists, reloads, and invalidates after donor source changes", () => {
  const file = join(mkdtempSync(join(tmpdir(), "hezi-evidence-")), "state.db");
  const donor = product("1001", { 品牌: fact("甲品牌", "1001") });
  const recipient = product("1002");
  let store = new Store(file);
  store.put("shop-a", donor);
  store.put("shop-a", recipient);
  const registered = registerFamilyEvidence(
    store,
    "shop-a",
    familyProof(donor, recipient),
  );
  store.close();

  store = new Store(file);
  const applied = applyFamilyEvidence(store, "shop-a", recipient);
  assert.equal(applied.product.specs.品牌.value, "甲品牌");
  assert.deepEqual(applied.usedProofIds, [registered.proofId]);
  assert.deepEqual(applied.proofIds, [registered.proofId]);
  assert.deepEqual(applied.authorizedFacts.品牌, applied.product.specs.品牌);

  store.put("shop-a", applied.product);
  const reread = applyFamilyEvidence(store, "shop-a", applied.product);
  assert.deepEqual(reread.product, applied.product);
  assert.deepEqual(reread.authorizedFacts.品牌, applied.product.specs.品牌);
  assert.deepEqual(reread.proofIds, [registered.proofId]);

  const changedDonor = structuredClone(donor);
  changedDonor.title.evidence = "重新采集后的供体来源";
  store.put("shop-a", changedDonor);
  const stale = applyFamilyEvidence(store, "shop-a", applied.product);
  assert.equal(stale.product.specs.品牌, undefined);
  assert.deepEqual(stale.authorizedFacts, {});
  assert.equal(stale.decisions[0].reason, "snapshot-mismatch");
  assert.deepEqual(stale.usedProofIds, []);
  store.close();
});

test("changed current data drops only exact old derived facts and reports stale proof", () => {
  const store = new Store(":memory:");
  const donor = product("1501", { 品牌: fact("甲品牌", "1501") });
  const recipient = product("1502");
  store.put("shop-a", donor);
  store.put("shop-a", recipient);
  registerFamilyEvidence(store, "shop-a", familyProof(donor, recipient));
  const applied = applyFamilyEvidence(store, "shop-a", recipient);
  store.put("shop-a", applied.product);

  const changed = structuredClone(applied.product);
  changed.specs.商品毛重 = fact("1kg", "1502");
  changed.price = {
    ...fact("29.90", "1502"),
    evidence: "当前SKU刷新得到明确京东价",
    basis: "jd-price",
  };
  changed.assets = [
    {
      role: "main",
      order: 0,
      url: "https://img.example.com/current-1502.jpg",
      sha256: "c".repeat(64),
    },
  ];
  store.put("shop-a", changed);
  const refreshed = applyFamilyEvidence(store, "shop-a", changed);
  assert.equal(refreshed.product.specs.品牌, undefined);
  assert.deepEqual(refreshed.product.specs.商品毛重, changed.specs.商品毛重);
  assert.deepEqual(refreshed.product.price, changed.price);
  assert.deepEqual(refreshed.product.assets, changed.assets);
  assert.deepEqual(refreshed.authorizedFacts, {});
  assert.deepEqual(refreshed.proofIds, []);
  assert.ok(
    refreshed.decisions.some(
      (decision) => decision.reason === "snapshot-mismatch",
    ),
  );
  store.close();
});

test("family registration is shop-scoped and rejects planned, bound, or pending recipients", () => {
  for (const blocked of ["plan", "remote", "pending"] as const) {
    const store = new Store(":memory:");
    const donor = product("2001", { 品牌: fact("乙品牌", "2001") });
    const recipient = product("2002");
    store.put("shop-a", donor);
    const recipientRow = store.put("shop-a", recipient);
    if (blocked === "plan")
      store.db
        .prepare("UPDATE products SET plan=? WHERE id=?")
        .run(JSON.stringify({ existing: true }), recipientRow.id);
    if (blocked === "remote")
      store.db
        .prepare("UPDATE products SET remote_id='9001' WHERE id=?")
        .run(recipientRow.id);
    if (blocked === "pending") store.intent(recipientRow.id, "save");

    assert.throws(() =>
      registerFamilyEvidence(store, "shop-a", familyProof(donor, recipient)),
    );
    assert.throws(() =>
      registerFamilyEvidence(store, "shop-b", familyProof(donor, recipient)),
    );
    store.close();
  }
});

function mediaProduct(sku: string): Product {
  const selected = fact("清新茉莉 2瓶", sku);
  return {
    ...product(sku, { 京东销售规格: selected }),
    assets: [
      {
        role: "main",
        order: 0,
        url: `https://img.example.com/${sku}.jpg`,
        sha256: "a".repeat(64),
      },
    ],
  };
}

function mediaRecord(product: Product): MediaEvidenceRecord {
  return {
    id: `manual-review-${product.sku}`,
    subject: {
      sku: product.sku,
      variant: product.variant,
      selectedSaleSpec: product.specs["京东销售规格"],
    },
    asset: {
      role: product.assets[0].role,
      order: product.assets[0].order,
      url: product.assets[0].url,
      sha256: product.assets[0].sha256!,
    },
    verdict: "approved",
    reviewKind: "human",
    reviewer: "operator-li",
    ruleVersion: MEDIA_ASSESSMENT_RULE_VERSION,
    reviewedAt: now,
    evidence: [
      {
        source: "manual-inspection/session-1",
        capturedAt: now,
        observation: "人工核对图片内容与当前销售规格一致",
      },
    ],
  };
}

test("media evidence remains shop-scoped audit metadata without governing source media", () => {
  const file = join(mkdtempSync(join(tmpdir(), "hezi-media-")), "state.db");
  const source = mediaProduct("3001");
  let store = new Store(file);
  const row = store.put("shop-a", source);
  registerMediaEvidence(store, "shop-a", row.id, [
    {
      record: mediaRecord(source),
      origin: { kind: "manual", operator: "operator-li" },
    },
  ]);
  store.put("shop-b", source);
  store.close();

  store = new Store(file);
  const shopA = assessStoredMedia(store, "shop-a", source);
  const shopB = assessStoredMedia(store, "shop-b", source);
  assert.equal(shopA.verdict, "approved");
  assert.equal(shopB.verdict, "approved");
  assert.deepEqual(shopA.assets[0].evidenceRecordIds, ["manual-review-3001"]);
  assert.deepEqual(shopB.assets[0].evidenceRecordIds, []);
  store.close();
});

test("media registration rejects fabricated provider identity and foreign SKU hash reuse", () => {
  const store = new Store(":memory:");
  const source = mediaProduct("4001");
  const row = store.put("shop-a", source);
  const manual = mediaRecord(source);
  assert.throws(() =>
    registerMediaEvidence(store, "shop-a", row.id, [
      {
        record: {
          ...manual,
          reviewKind: "verified-classifier",
          reviewer: "provider-real",
        },
        origin: {
          kind: "classifier",
          provider: "provider-other",
          providerOutputId: "output-1",
        },
      },
    ]),
  );

  const foreign = mediaProduct("4999");
  foreign.assets[0].sha256 = source.assets[0].sha256;
  assert.throws(() =>
    registerMediaEvidence(store, "shop-a", row.id, [
      {
        record: mediaRecord(foreign),
        origin: { kind: "manual", operator: "operator-li" },
      },
    ]),
  );
  store.close();
});
