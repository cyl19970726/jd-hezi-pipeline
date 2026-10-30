import { z } from "zod";
import { digest, factSchema, productSchema, type Product } from "./model.js";

export const PRODUCT_FAMILY_REUSABLE_FIELDS = ["品牌", "生产厂家"] as const;
export const PRODUCT_FAMILY_DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const PRODUCT_FAMILY_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export const productFamilyFieldSchema = z.enum(PRODUCT_FAMILY_REUSABLE_FIELDS);

const fieldApplicabilitySchema = z
  .object({
    field: productFamilyFieldSchema,
    evidence: z.string().min(1),
  })
  .strict();

export const productFamilyProofSchema = z
  .object({
    version: z.literal(1),
    kind: z.literal("explicit-product-family-membership"),
    familyId: z.string().min(1),
    donorSku: z.string().regex(/^\d+$/),
    recipientSku: z.string().regex(/^\d+$/),
    donorSnapshotHash: z.string().regex(/^[a-f0-9]{64}$/),
    recipientSnapshotHash: z.string().regex(/^[a-f0-9]{64}$/),
    capturedAt: z.string().datetime(),
    expiresAt: z.string().datetime().optional(),
    evidence: z.string().min(1),
    applicableFields: z.array(fieldApplicabilitySchema).min(1),
  })
  .strict()
  .superRefine((proof, context) => {
    const fields = proof.applicableFields.map(({ field }) => field);
    if (new Set(fields).size !== fields.length) {
      context.addIssue({
        code: "custom",
        path: ["applicableFields"],
        message: "字段适用证明不得重复",
      });
    }
    if (
      proof.expiresAt &&
      Date.parse(proof.expiresAt) <= Date.parse(proof.capturedAt)
    ) {
      context.addIssue({
        code: "custom",
        path: ["expiresAt"],
        message: "到期时间必须晚于证据采集时间",
      });
    }
  });

export type ProductFamilyProof = z.infer<typeof productFamilyProofSchema>;
export type ProductFamilyReusableField = z.infer<
  typeof productFamilyFieldSchema
>;

export type ProductFamilyReuseReason =
  | "reused"
  | "invalid-proof"
  | "sku-mismatch"
  | "snapshot-mismatch"
  | "future-proof"
  | "expired-proof"
  | "missing-donor-fact"
  | "recipient-already-has-fact";

export interface ProductFamilyReuseDecision {
  field: ProductFamilyReusableField | null;
  outcome: "reused" | "skipped";
  reason: ProductFamilyReuseReason;
  detail: string;
  provenance?: {
    familyId: string;
    donorSku: string;
    recipientSku: string;
    donorSnapshotHash: string;
    recipientSnapshotHash: string;
    membershipEvidence: string;
    membershipCapturedAt: string;
    applicabilityEvidence: string;
    donorFact: z.infer<typeof factSchema>;
  };
}

export interface ProductFamilyReuseInput {
  donor: Product;
  recipient: Product;
  proof: unknown;
  policy: {
    /** Required so the operation is deterministic and has no ambient clock. */
    now: string;
    /** Defaults to 7 days and can never exceed 30 days. */
    maxEvidenceAgeMs?: number;
  };
}

export interface ProductFamilyReuseResult {
  product: Product;
  decisions: ProductFamilyReuseDecision[];
}

/** Hash the complete current Product snapshot used by a membership proof. */
export function productFamilySnapshotHash(product: Product): string {
  return digest(productSchema.parse(product));
}

function skipped(
  reason: ProductFamilyReuseReason,
  detail: string,
  fields: ProductFamilyReusableField[] = [],
): ProductFamilyReuseDecision[] {
  if (!fields.length)
    return [{ field: null, outcome: "skipped", reason, detail }];
  return fields.map((field) => ({
    field,
    outcome: "skipped",
    reason,
    detail,
  }));
}

/**
 * Reuse only explicitly proven family-level facts. This never merges SKUs and
 * never infers family membership from titles, media, hashes, or shared values.
 */
export function reuseProductFamilyFacts(
  input: ProductFamilyReuseInput,
): ProductFamilyReuseResult {
  const donor = productSchema.parse(input.donor);
  const recipient = productSchema.parse(input.recipient);
  const output = structuredClone(recipient);
  const parsedProof = productFamilyProofSchema.safeParse(input.proof);
  if (!parsedProof.success) {
    return {
      product: output,
      decisions: skipped(
        "invalid-proof",
        parsedProof.error.issues
          .map(
            (issue) => `${issue.path.join(".") || "proof"}: ${issue.message}`,
          )
          .join("；"),
      ),
    };
  }

  const proof = parsedProof.data;
  const fields = proof.applicableFields.map(({ field }) => field);
  if (proof.donorSku !== donor.sku || proof.recipientSku !== recipient.sku) {
    return {
      product: output,
      decisions: skipped(
        "sku-mismatch",
        "成员关系证明中的供体或接收 SKU 与当前商品不一致",
        fields,
      ),
    };
  }
  if (
    proof.donorSnapshotHash !== productFamilySnapshotHash(donor) ||
    proof.recipientSnapshotHash !== productFamilySnapshotHash(recipient)
  ) {
    return {
      product: output,
      decisions: skipped(
        "snapshot-mismatch",
        "成员关系证明绑定的商品快照已变化",
        fields,
      ),
    };
  }

  const now = Date.parse(input.policy.now);
  if (!Number.isFinite(now))
    throw new TypeError("policy.now 必须是有效的 ISO 日期时间");
  const requestedMaxAge =
    input.policy.maxEvidenceAgeMs ?? PRODUCT_FAMILY_DEFAULT_MAX_AGE_MS;
  if (!Number.isInteger(requestedMaxAge) || requestedMaxAge <= 0)
    throw new TypeError("policy.maxEvidenceAgeMs 必须是正整数");
  const maxAge = Math.min(requestedMaxAge, PRODUCT_FAMILY_MAX_AGE_MS);
  const capturedAt = Date.parse(proof.capturedAt);
  if (capturedAt > now) {
    return {
      product: output,
      decisions: skipped(
        "future-proof",
        "成员关系证据的采集时间晚于当前策略时间",
        fields,
      ),
    };
  }
  const policyExpiry = capturedAt + maxAge;
  const declaredExpiry = proof.expiresAt
    ? Date.parse(proof.expiresAt)
    : Number.POSITIVE_INFINITY;
  if (now > Math.min(policyExpiry, declaredExpiry)) {
    return {
      product: output,
      decisions: skipped(
        "expired-proof",
        "成员关系证据已超过声明期限或策略允许的最长复用期",
        fields,
      ),
    };
  }

  const decisions: ProductFamilyReuseDecision[] = [];
  for (const applicability of proof.applicableFields) {
    const field = applicability.field;
    const donorFact = donor.specs[field];
    if (!donorFact) {
      decisions.push({
        field,
        outcome: "skipped",
        reason: "missing-donor-fact",
        detail: "供体当前快照中没有该字段事实",
      });
      continue;
    }
    if (recipient.specs[field]) {
      decisions.push({
        field,
        outcome: "skipped",
        reason: "recipient-already-has-fact",
        detail: "接收商品已有该字段事实，未覆盖",
      });
      continue;
    }

    const provenance = {
      familyId: proof.familyId,
      donorSku: donor.sku,
      recipientSku: recipient.sku,
      donorSnapshotHash: proof.donorSnapshotHash,
      recipientSnapshotHash: proof.recipientSnapshotHash,
      membershipEvidence: proof.evidence,
      membershipCapturedAt: proof.capturedAt,
      applicabilityEvidence: applicability.evidence,
      donorFact: structuredClone(donorFact),
    };
    output.specs[field] = {
      ...donorFact,
      evidence:
        `${donorFact.evidence}；产品家族事实复用：供体SKU ${donor.sku} → 接收SKU ${recipient.sku}` +
        `；成员关系证据（${proof.capturedAt}）：${proof.evidence}` +
        `；字段适用证据：${applicability.evidence}`,
    };
    decisions.push({
      field,
      outcome: "reused",
      reason: "reused",
      detail: "已复用明确允许且适用于该家族的字段事实",
      provenance,
    });
  }

  return { product: productSchema.parse(output), decisions };
}
