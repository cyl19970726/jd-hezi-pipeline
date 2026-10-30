import { z } from "zod";
import type { Product } from "./model.js";

const fixedParts = ["品牌", "类目名称", "计价单位"];

export const platformTitleRuleSchema = z
  .object({
    mode: z.literal("platform-generated"),
    parts: z.array(z.string().trim().min(1)).min(1),
    separator: z.literal(" "),
  })
  .superRefine((rule, ctx) => {
    if (new Set(rule.parts).size !== rule.parts.length)
      ctx.addIssue({ code: "custom", message: "商品名称规则字段重复" });
    for (const part of fixedParts)
      if (rule.parts.filter((candidate) => candidate === part).length !== 1)
        ctx.addIssue({
          code: "custom",
          message: `商品名称规则必须且只能包含一次${part}`,
        });
  });

export type PlatformTitleRule = z.infer<typeof platformTitleRuleSchema>;

const placeholder = /^(?:暂无|无|未知|不详|未提供|n\/?a|-{1,2}|—)$/i;

/**
 * Mirrors a verified platform title rule.  It is deliberately driven only by
 * persisted template parts, never a category ID or a hand-written title rule.
 */
export function platformGeneratedTitle(input: {
  rule: PlatformTitleRule;
  brand: string;
  categoryPath: string;
  specs: Product["specs"];
  unit: string;
  source: Product["title"];
  ruleEvidence: string;
}): Product["title"] | null {
  const leaf = input.categoryPath
    .split(/\s*(?:>|→)\s*/)
    .at(-1)
    ?.trim();
  const values = input.rule.parts.map((part) => {
    if (part === "品牌") return input.brand.trim();
    if (part === "类目名称") return leaf ?? "";
    if (part === "计价单位") return input.unit.trim();
    return input.specs[part]?.value.trim() ?? "";
  });
  if (values.some((value) => !value || placeholder.test(value))) return null;
  const value = values.join(input.rule.separator);
  if (value.length > 80) return null;
  const partsEvidence = input.rule.parts
    .map((part, index) => {
      const fact = input.specs[part];
      return fact
        ? `${part}=${values[index]}（${fact.evidence}）`
        : `${part}=${values[index]}`;
    })
    .join("；");
  return {
    ...input.source,
    value,
    evidence:
      input.source.evidence +
      `；按已核验平台商品名称规则 ${input.rule.parts.join("+")} 生成；${partsEvidence}；${input.ruleEvidence}`,
  };
}
