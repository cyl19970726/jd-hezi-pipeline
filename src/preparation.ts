import { digest, PipelineError, type Product } from "./model.js";
import {
  normalizeProduct,
  NORMALIZATION_VERSION,
  type NormalizationContext,
} from "./normalization.js";
import { prepareSaleText } from "./sale-text.js";
import { Store } from "./store.js";
import { applyFamilyEvidence } from "./automation-evidence.js";
import { listingCustomizationPolicy } from "./listing-service-policy.js";

export const BASE_REQUIRED_FACTS = ["商品毛重", "包装名称", "包装数量"];

/** Requirements come from the actual selected template, never a guessed category. */
export function preparationRequirements(
  store: Store,
  shop: string,
  categoryId: string,
) {
  if (
    !store.db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='category_templates'",
      )
      .get()
  )
    return [...BASE_REQUIRED_FACTS];
  const row = store.db
    .prepare(
      "SELECT template FROM category_templates WHERE shop=? AND category_id=?",
    )
    .get(shop, categoryId);
  const template = row ? JSON.parse(String(row.template)) : null;
  const requirements = [
    ...new Set([
      ...BASE_REQUIRED_FACTS,
      ...(Array.isArray(template?.specs) ? template.specs : []),
    ]),
  ] as string[];
  return listingCustomizationPolicy(store, shop, categoryId)
    ? requirements.filter((name) => name !== "是否可定制")
    : requirements;
}

/** Immutable local source/decision history. Never contacts JD or HZ. */
export class Preparation {
  constructor(readonly store: Store) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS preparation_observations(
      shop TEXT NOT NULL,sku TEXT NOT NULL,input_hash TEXT NOT NULL,product TEXT NOT NULL,created_at TEXT NOT NULL,
      PRIMARY KEY(shop,sku,input_hash));
      CREATE TABLE IF NOT EXISTS preparation_results(
      shop TEXT NOT NULL,sku TEXT NOT NULL,input_hash TEXT NOT NULL,requirements_hash TEXT NOT NULL,
      rules_version TEXT NOT NULL,result TEXT NOT NULL,created_at TEXT NOT NULL,
      PRIMARY KEY(shop,sku,input_hash,requirements_hash,rules_version));`);
  }
  analyze(
    shop: string,
    product: Product,
    required: string[],
    verifiedFamily?: ReturnType<typeof applyFamilyEvidence>,
    context?: NormalizationContext,
  ) {
    const inputHash = digest(product),
      requirements = [...new Set(required)].sort();
    const family = verifiedFamily ?? {
      product,
      proofIds: [],
      authorizedFacts: {} as Product["specs"],
    };
    const requirementsHash = digest({
      requirements,
      normalizationContext: context ?? {},
      proofIds: family.proofIds,
      authorizedFacts: family.authorizedFacts,
    });
    const cached = this.store.db
      .prepare(
        "SELECT result FROM preparation_results WHERE shop=? AND sku=? AND input_hash=? AND requirements_hash=? AND rules_version=?",
      )
      .get(
        shop,
        product.sku,
        inputHash,
        requirementsHash,
        NORMALIZATION_VERSION,
      );
    if (cached)
      return {
        ...(JSON.parse(String(cached.result)) as ReturnType<
          typeof normalizeProduct
        >),
        inputHash,
        requirementsHash,
        cached: true,
      };
    const local = structuredClone(family.product);
    for (const field of Object.keys(family.authorizedFacts))
      delete local.specs[field];
    const result = normalizeProduct(
      prepareSaleText(local),
      requirements,
      context,
    );
    for (const [field, fact] of Object.entries(family.authorizedFacts)) {
      result.product.specs[field] = fact;
      const resolution = {
        field,
        status: "resolved" as const,
        value: fact.value,
        evidence: [
          {
            sourceField: field,
            value: fact.value,
            sourceUrl: fact.sourceUrl,
            capturedAt: fact.capturedAt,
            evidence: fact.evidence,
            rule: "verified-family:" + family.proofIds.join(","),
          },
        ],
        ruleVersion: NORMALIZATION_VERSION,
      };
      result.resolutions[field] = resolution;
      result.fields = result.fields
        .filter((r) => r.field !== field)
        .concat(resolution);
    }
    result.issues = result.blockingReasons = requirements
      .filter((field) => result.resolutions[field]?.status !== "resolved")
      .map(
        (field) =>
          result.resolutions[field]?.blockingReason ??
          `${field}尚未获得可靠来源或解析结果`,
      );
    this.store.tx(() => {
      this.store.db
        .prepare(
          "INSERT OR IGNORE INTO preparation_observations VALUES(?,?,?,?,?)",
        )
        .run(
          shop,
          product.sku,
          inputHash,
          JSON.stringify(product),
          new Date().toISOString(),
        );
      this.store.db
        .prepare(
          "INSERT OR IGNORE INTO preparation_results VALUES(?,?,?,?,?,?,?)",
        )
        .run(
          shop,
          product.sku,
          inputHash,
          requirementsHash,
          NORMALIZATION_VERSION,
          JSON.stringify(result),
          new Date().toISOString(),
        );
    });
    return { ...result, inputHash, requirementsHash, cached: false };
  }
  apply(id: string, required: string[], context?: NormalizationContext) {
    const row = this.store.get(id);
    if (!row.product) throw new PipelineError("NEEDS_INPUT", "缺商品来源记录");
    if (this.store.pending(id))
      throw new PipelineError(
        "UNKNOWN_OUTCOME",
        "先对账未完成写入，不能重新整理商品",
      );
    if (
      row.remoteId ||
      row.plan ||
      ["SUBMITTED", "APPROVED", "ON_SALE"].includes(row.state)
    )
      throw new PipelineError(
        "BUSINESS_BLOCKED",
        "已计划或已绑定商品只允许离线对照，不自动改写",
      );
    const result = this.analyze(
      row.shop,
      row.product,
      required,
      applyFamilyEvidence(this.store, row.shop, row.product),
      context,
    );
    // A conflicting interpretation must not write even unrelated inferred fields.
    if (
      result.fields.some(
        (field) =>
          field.status === "conflicting" && required.includes(field.field),
      )
    )
      return result;
    if (digest(row.product) !== digest(result.product)) {
      this.store.put(row.shop, result.product);
      this.store.event(id, "FACTS_NORMALIZED", {
        inputHash: result.inputHash,
        requirementsHash: result.requirementsHash,
        rulesVersion: result.rulesVersion,
      });
    }
    return result;
  }
}
