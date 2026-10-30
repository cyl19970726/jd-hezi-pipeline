import { z } from "zod";
import {
  assessMedia,
  mediaEvidenceRecordSchema,
  type MediaAssessment,
  type MediaEvidenceRecord,
} from "./media-assessment.js";
import {
  canonical,
  digest,
  factSchema,
  PipelineError,
  productSchema,
  type Product,
} from "./model.js";
import {
  productFamilyProofSchema,
  productFamilySnapshotHash,
  reuseProductFamilyFacts,
  type ProductFamilyReuseDecision,
} from "./product-family.js";
import type { Store } from "./store.js";

const manualOriginSchema = z
  .object({
    kind: z.literal("manual"),
    operator: z.string().trim().min(1),
  })
  .strict();

const classifierOriginSchema = z
  .object({
    kind: z.literal("classifier"),
    provider: z.string().trim().min(1),
    providerOutputId: z.string().trim().min(1),
  })
  .strict();

export const mediaEvidenceRegistrationSchema = z
  .object({
    record: mediaEvidenceRecordSchema,
    origin: z.discriminatedUnion("kind", [
      manualOriginSchema,
      classifierOriginSchema,
    ]),
  })
  .strict();

export type MediaEvidenceRegistration = z.infer<
  typeof mediaEvidenceRegistrationSchema
>;

export interface RegisteredFamilyEvidence {
  proofId: string;
  decisions: ProductFamilyReuseDecision[];
}

export interface AppliedFamilyDecision extends ProductFamilyReuseDecision {
  proofId: string;
}

export interface AppliedFamilyEvidence {
  product: Product;
  decisions: AppliedFamilyDecision[];
  authorizedFacts: Record<string, z.infer<typeof factSchema>>;
  proofIds: string[];
  /** Compatibility alias for callers interested only in contributing proofs. */
  usedProofIds: string[];
}

export interface RegisteredMediaEvidence {
  evidenceIds: string[];
}

function initialize(store: Store) {
  store.db.exec(`
    CREATE TABLE IF NOT EXISTS automation_family_evidence(
      proof_id TEXT PRIMARY KEY,
      shop TEXT NOT NULL,
      donor_product_id TEXT NOT NULL REFERENCES products(id),
      recipient_product_id TEXT NOT NULL REFERENCES products(id),
      proof_json TEXT NOT NULL,
      registered_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS automation_family_recipient
      ON automation_family_evidence(shop,recipient_product_id);
    CREATE TABLE IF NOT EXISTS automation_family_applications(
      application_id TEXT PRIMARY KEY,
      shop TEXT NOT NULL,
      recipient_product_id TEXT NOT NULL REFERENCES products(id),
      raw_product_hash TEXT NOT NULL,
      raw_product_json TEXT NOT NULL,
      output_product_hash TEXT NOT NULL,
      output_product_json TEXT NOT NULL,
      proof_ids_json TEXT NOT NULL,
      decisions_json TEXT NOT NULL,
      applied_at TEXT NOT NULL,
      UNIQUE(shop,recipient_product_id,output_product_hash)
    );
    CREATE INDEX IF NOT EXISTS automation_family_application_output
      ON automation_family_applications(shop,recipient_product_id,output_product_hash);
    CREATE TABLE IF NOT EXISTS automation_media_evidence(
      evidence_id TEXT PRIMARY KEY,
      shop TEXT NOT NULL,
      product_id TEXT NOT NULL REFERENCES products(id),
      record_id TEXT NOT NULL,
      product_snapshot_hash TEXT NOT NULL,
      origin_json TEXT NOT NULL,
      record_json TEXT NOT NULL,
      registered_at TEXT NOT NULL,
      UNIQUE(shop,record_id)
    );
    CREATE INDEX IF NOT EXISTS automation_media_product
      ON automation_media_evidence(shop,product_id);
  `);
}

function productRows(store: Store, shop: string, sku: string): any[] {
  return store.db
    .prepare(
      "SELECT * FROM products WHERE shop=? AND sku=? AND product IS NOT NULL ORDER BY id",
    )
    .all(shop, sku) as any[];
}

function parsedProduct(row: any): Product {
  return productSchema.parse(JSON.parse(String(row.product)));
}

function rowForProofSnapshot(
  store: Store,
  shop: string,
  sku: string,
  snapshotHash: string,
  role: "供体" | "接收",
): any {
  const matching = productRows(store, shop, sku).filter(
    (row) => productFamilySnapshotHash(parsedProduct(row)) === snapshotHash,
  );
  if (matching.length !== 1)
    throw new PipelineError(
      "NEEDS_INPUT",
      `${role} SKU 当前没有唯一匹配该证明快照的来源商品`,
    );
  return matching[0];
}

function exactCurrentRow(store: Store, shop: string, product: Product): any {
  const candidates = productRows(store, shop, product.sku).filter((row) => {
    const stored = parsedProduct(row);
    return stored.variant === product.variant;
  });
  if (candidates.length !== 1)
    throw new PipelineError("NEEDS_INPUT", "当前店铺没有唯一匹配的商品来源");
  const row = candidates[0];
  if (
    productFamilySnapshotHash(parsedProduct(row)) !==
    productFamilySnapshotHash(product)
  )
    throw new PipelineError(
      "NEEDS_INPUT",
      "调用商品不是数据库中的当前来源快照",
    );
  return row;
}

export function registerFamilyEvidence(
  store: Store,
  shop: string,
  proofInput: unknown,
): RegisteredFamilyEvidence {
  initialize(store);
  const proof = productFamilyProofSchema.parse(proofInput);
  const donorRow = rowForProofSnapshot(
    store,
    shop,
    proof.donorSku,
    proof.donorSnapshotHash,
    "供体",
  );
  const recipientRow = rowForProofSnapshot(
    store,
    shop,
    proof.recipientSku,
    proof.recipientSnapshotHash,
    "接收",
  );
  if (recipientRow.plan)
    throw new PipelineError(
      "NEEDS_INPUT",
      "已有计划的商品不能注册家族复用证据",
    );
  if (recipientRow.remote_id)
    throw new PipelineError(
      "NEEDS_INPUT",
      "已有远端绑定的商品不能注册家族复用证据",
    );
  if (store.pending(String(recipientRow.id)))
    throw new PipelineError(
      "UNKNOWN_OUTCOME",
      "接收商品有未完成操作，不能注册证据",
    );

  const checked = reuseProductFamilyFacts({
    donor: parsedProduct(donorRow),
    recipient: parsedProduct(recipientRow),
    proof,
    policy: { now: new Date().toISOString() },
  });
  if (checked.decisions.some((decision) => decision.reason !== "reused"))
    throw new PipelineError(
      "NEEDS_INPUT",
      "家族证明不能从当前来源产生完整、无冲突的允许字段事实",
      checked.decisions,
    );

  const proofId = digest({ type: "product-family-evidence-v1", shop, proof });
  store.db
    .prepare(
      `INSERT OR IGNORE INTO automation_family_evidence
       (proof_id,shop,donor_product_id,recipient_product_id,proof_json,registered_at)
       VALUES(?,?,?,?,?,?)`,
    )
    .run(
      proofId,
      shop,
      donorRow.id,
      recipientRow.id,
      JSON.stringify(proof),
      new Date().toISOString(),
    );
  return { proofId, decisions: checked.decisions };
}

export function applyFamilyEvidence(
  store: Store,
  shop: string,
  recipientInput: Product,
): AppliedFamilyEvidence {
  initialize(store);
  const recipient = productSchema.parse(recipientInput);
  const recipientRow = exactCurrentRow(store, shop, recipient);
  const stored = store.db
    .prepare(
      `SELECT * FROM automation_family_evidence
       WHERE shop=? AND recipient_product_id=? ORDER BY registered_at,proof_id`,
    )
    .all(shop, recipientRow.id) as any[];
  if (!stored.length) {
    return {
      product: structuredClone(recipient),
      decisions: [],
      authorizedFacts: {},
      proofIds: [],
      usedProofIds: [],
    };
  }

  const currentHash = productFamilySnapshotHash(recipient);
  const acceptsCurrentAsRaw = stored.some((row) => {
    const proof = productFamilyProofSchema.parse(
      JSON.parse(String(row.proof_json)),
    );
    return proof.recipientSnapshotHash === currentHash;
  });
  let rawRecipient = recipient;
  if (!acceptsCurrentAsRaw) {
    const exactReceipt: any = store.db
      .prepare(
        `SELECT raw_product_json FROM automation_family_applications
         WHERE shop=? AND recipient_product_id=? AND output_product_hash=?`,
      )
      .get(shop, recipientRow.id, currentHash);
    if (exactReceipt) {
      rawRecipient = productSchema.parse(
        JSON.parse(String(exactReceipt.raw_product_json)),
      );
    } else {
      rawRecipient = structuredClone(recipient);
      const receipts = store.db
        .prepare(
          `SELECT raw_product_json,output_product_json,decisions_json
           FROM automation_family_applications
           WHERE shop=? AND recipient_product_id=? ORDER BY applied_at,application_id`,
        )
        .all(shop, recipientRow.id) as any[];
      for (const receipt of receipts) {
        const historicalRaw = productSchema.parse(
          JSON.parse(String(receipt.raw_product_json)),
        );
        const historicalOutput = productSchema.parse(
          JSON.parse(String(receipt.output_product_json)),
        );
        const derivedFields = new Set(
          (
            JSON.parse(
              String(receipt.decisions_json),
            ) as AppliedFamilyDecision[]
          )
            .filter(
              (decision) =>
                decision.outcome === "reused" && decision.field !== null,
            )
            .map((decision) => decision.field!),
        );
        for (const field of derivedFields) {
          if (
            !historicalRaw.specs[field] &&
            historicalOutput.specs[field] &&
            rawRecipient.specs[field] &&
            canonical(rawRecipient.specs[field]) ===
              canonical(historicalOutput.specs[field])
          )
            delete rawRecipient.specs[field];
        }
      }
    }
  }

  const output = structuredClone(rawRecipient);
  const decisions: AppliedFamilyDecision[] = [];
  const usedProofIds: string[] = [];
  const authorizedFacts: Record<string, z.infer<typeof factSchema>> = {};

  for (const row of stored) {
    const proofId = String(row.proof_id);
    const proof = productFamilyProofSchema.parse(
      JSON.parse(String(row.proof_json)),
    );
    const donorRow = store.get(String(row.donor_product_id));
    if (donorRow.shop !== shop || !donorRow.product)
      throw new PipelineError(
        "NEEDS_INPUT",
        "家族证据的供体已不属于当前店铺或缺少来源快照",
      );
    const donor = donorRow.product;
    const result = reuseProductFamilyFacts({
      donor,
      recipient: rawRecipient,
      proof,
      policy: { now: new Date().toISOString() },
    });
    let used = false;
    for (const decision of result.decisions) {
      if (decision.outcome === "reused" && decision.field) {
        if (output.specs[decision.field]) {
          decisions.push({
            ...decision,
            proofId,
            outcome: "skipped",
            reason: "recipient-already-has-fact",
            detail: "较早的当前证据已提供该字段，未覆盖",
          });
          continue;
        }
        output.specs[decision.field] = result.product.specs[decision.field];
        authorizedFacts[decision.field] = structuredClone(
          result.product.specs[decision.field],
        );
        used = true;
      }
      decisions.push({ ...decision, proofId });
    }
    if (used) usedProofIds.push(proofId);
  }

  const proofIds = [...usedProofIds];
  const rawProductHash = productFamilySnapshotHash(rawRecipient);
  const outputProductHash = productFamilySnapshotHash(output);
  const applicationId = digest({
    type: "family-application-v1",
    shop,
    recipientProductId: recipientRow.id,
    rawProductHash,
    outputProductHash,
    proofIds,
    decisions,
  });
  store.db
    .prepare(
      `INSERT OR IGNORE INTO automation_family_applications
       (application_id,shop,recipient_product_id,raw_product_hash,raw_product_json,
        output_product_hash,output_product_json,proof_ids_json,decisions_json,applied_at)
       VALUES(?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      applicationId,
      shop,
      recipientRow.id,
      rawProductHash,
      JSON.stringify(rawRecipient),
      outputProductHash,
      JSON.stringify(output),
      JSON.stringify(proofIds),
      JSON.stringify(decisions),
      new Date().toISOString(),
    );

  return {
    product: productSchema.parse(output),
    decisions,
    authorizedFacts,
    proofIds,
    usedProofIds,
  };
}

function validateOrigin(
  record: MediaEvidenceRecord,
  origin: MediaEvidenceRegistration["origin"],
) {
  if (origin.kind === "manual") {
    if (record.reviewKind !== "human" || record.reviewer !== origin.operator)
      throw new PipelineError(
        "NEEDS_INPUT",
        "人工媒体证据必须由同名操作人产生 human 评审记录",
      );
    return;
  }
  if (
    record.reviewKind !== "verified-classifier" ||
    record.reviewer !== origin.provider
  )
    throw new PipelineError(
      "NEEDS_INPUT",
      "分类器媒体证据必须保留同名 provider 的 verified-classifier 原始记录",
    );
}

export function registerMediaEvidence(
  store: Store,
  shop: string,
  productId: string,
  inputs: readonly unknown[],
): RegisteredMediaEvidence {
  initialize(store);
  const row = store.get(productId);
  if (row.shop !== shop || !row.product)
    throw new PipelineError(
      "NEEDS_INPUT",
      "媒体证据商品不属于当前店铺或缺少来源",
    );
  const product = productSchema.parse(row.product);
  const registrations = inputs.map((input) =>
    mediaEvidenceRegistrationSchema.parse(input),
  );

  const values = registrations.map(({ record, origin }) => {
    validateOrigin(record, origin);
    const assessment = assessMedia(product, [record]);
    if (
      !assessment.assets.some((asset) =>
        asset.evidenceRecordIds.includes(record.id),
      )
    )
      throw new PipelineError(
        "NEEDS_INPUT",
        "媒体证据不覆盖当前商品的精确销售规格与素材位置",
      );
    const evidenceId = digest({
      type: "media-evidence-v1",
      shop,
      productId,
      productSnapshotHash: productFamilySnapshotHash(product),
      origin,
      record,
    });
    return { evidenceId, record, origin };
  });

  store.tx(() => {
    for (const value of values) {
      const existing: any = store.db
        .prepare(
          "SELECT evidence_id FROM automation_media_evidence WHERE shop=? AND record_id=?",
        )
        .get(shop, value.record.id);
      if (existing && String(existing.evidence_id) !== value.evidenceId)
        throw new PipelineError(
          "NEEDS_INPUT",
          "同一媒体评审记录 ID 已绑定不同的不可变证据",
        );
      store.db
        .prepare(
          `INSERT OR IGNORE INTO automation_media_evidence
           (evidence_id,shop,product_id,record_id,product_snapshot_hash,origin_json,record_json,registered_at)
           VALUES(?,?,?,?,?,?,?,?)`,
        )
        .run(
          value.evidenceId,
          shop,
          productId,
          value.record.id,
          productFamilySnapshotHash(product),
          JSON.stringify(value.origin),
          JSON.stringify(value.record),
          new Date().toISOString(),
        );
    }
  });
  return { evidenceIds: values.map(({ evidenceId }) => evidenceId) };
}

export function assessStoredMedia(
  store: Store,
  shop: string,
  productInput: Product,
): MediaAssessment {
  initialize(store);
  const product = productSchema.parse(productInput);
  const candidates = productRows(store, shop, product.sku).filter(
    (row) => parsedProduct(row).variant === product.variant,
  );
  if (candidates.length !== 1) return assessMedia(product, []);
  const records = store.db
    .prepare(
      `SELECT record_json FROM automation_media_evidence
       WHERE shop=? AND product_id=? ORDER BY registered_at,evidence_id`,
    )
    .all(shop, candidates[0].id)
    .map((row: any) => JSON.parse(String(row.record_json)));
  return assessMedia(product, records);
}
