import { z } from "zod";
import {
  assetSchema,
  canonical,
  factSchema,
  parseSku,
  productSchema,
  type Asset,
  type Product,
} from "./model.js";

/** Retained for parsing and displaying historical evidence records. */
export const MEDIA_ASSESSMENT_RULE_VERSION = "media-v1" as const;

const boundAssetSchema = assetSchema
  .pick({
    url: true,
    role: true,
    order: true,
    sha256: true,
  })
  .required({ sha256: true });

const subjectSchema = z
  .object({
    sku: z.string().regex(/^\d+$/),
    variant: z.string(),
    selectedSaleSpec: factSchema,
  })
  .strict();

const actualEvidenceSchema = z
  .object({
    source: z.string().min(1),
    capturedAt: z.string().datetime(),
    observation: z.string().min(1),
  })
  .strict();

export const mediaEvidenceRecordSchema = z
  .object({
    id: z.string().min(1),
    subject: subjectSchema,
    asset: boundAssetSchema.strict(),
    verdict: z.enum(["approved", "rejected"]),
    reviewKind: z.enum(["human", "verified-classifier"]),
    reviewer: z.string().min(1),
    ruleVersion: z.string().min(1),
    reviewedAt: z.string().datetime(),
    evidence: z.array(actualEvidenceSchema).min(1),
  })
  .strict();

export type MediaEvidenceRecord = z.infer<typeof mediaEvidenceRecordSchema>;
export type MediaVerdict = "approved" | "needs_review" | "rejected";

export interface AssetMediaAssessment {
  asset: Asset;
  verdict: MediaVerdict;
  reasons: string[];
  evidenceRecordIds: string[];
}

export interface MediaAssessment {
  verdict: MediaVerdict;
  mediaReviewed: boolean;
  assets: AssetMediaAssessment[];
}

function subjectFor(product: Product) {
  const selectedSaleSpec = product.specs["京东销售规格"];
  return selectedSaleSpec
    ? { sku: product.sku, variant: product.variant, selectedSaleSpec }
    : null;
}

function boundAsset(asset: Asset) {
  return asset.sha256
    ? {
        url: asset.url,
        role: asset.role,
        order: asset.order,
        sha256: asset.sha256,
      }
    : null;
}

/**
 * The source-media policy accepts every asset collected for the selected JD SKU.
 * Evidence records remain readable for audit and registration compatibility, but
 * they never decide whether an image is included or excluded.
 */
export function assessMedia(
  productInput: Product,
  evidenceInputs: readonly unknown[],
): MediaAssessment {
  const product = productSchema.parse(productInput);
  const records = evidenceInputs.map((record) =>
    mediaEvidenceRecordSchema.parse(record),
  );
  const subject = subjectFor(product);
  const sourceMatchesSku = (() => {
    try {
      return parseSku(product.url) === product.sku;
    } catch {
      return false;
    }
  })();
  const sourceOrderIsValid = (asset: Asset) =>
    product.assets
      .filter((candidate) => candidate.role === asset.role)
      .indexOf(asset) === asset.order;

  const assets = product.assets.map((asset): AssetMediaAssessment => {
    const content = boundAsset(asset);
    // Keep exact bindings available to the legacy evidence registry. They are
    // provenance only; a missing, rejected, or conflicting review cannot remove
    // a source image under the P0 policy.
    const evidenceRecordIds =
      subject && content
        ? records
            .filter(
              (record) =>
                canonical(record.subject) === canonical(subject) &&
                canonical(record.asset) === canonical(content),
            )
            .map((record) => record.id)
            .sort()
        : [];
    const reasons: string[] = [];
    if (!sourceMatchesSku)
      reasons.push("source URL does not identify this SKU");
    if (!sourceOrderIsValid(asset))
      reasons.push("source asset order is invalid");
    return {
      asset,
      verdict: reasons.length ? "rejected" : "approved",
      reasons: reasons.length
        ? reasons
        : ["selected SKU source asset retained in source order"],
      evidenceRecordIds,
    };
  });

  const verdict: MediaVerdict = assets.some(
    (asset) => asset.verdict === "rejected",
  )
    ? "rejected"
    : assets.length > 0
      ? "approved"
      : "needs_review";
  return { verdict, mediaReviewed: verdict === "approved", assets };
}
