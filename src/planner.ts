import { isClockListingCategory, listingTitle } from "./listing-title.js";
import { listingPrice } from "./listing-price.js";
import { CompetitivePricing } from "./competitive-pricing.js";
import { listingCustomizationPolicy } from "./listing-service-policy.js";
import { listingPackingDisplayFact } from "./packing-display.js";
import { brandEquivalent } from "./brand-identity.js";
import { Store } from "./store.js";
import { Catalog } from "./catalog.js";
import { PipelineError, planSchema, type Plan, type Product } from "./model.js";
import { z } from "zod";
import {
  platformGeneratedTitle,
  platformTitleRuleSchema,
} from "./platform-title.js";
const templateSchema = z.object({
  categoryId: z.string().min(1).optional(),
  specs: z.array(z.string().trim().min(1)).min(1),
  fields: z
    .array(
      z.object({
        id: z.string().min(1),
        name: z.string().trim().min(1),
        required: z.boolean(),
        selectType: z.string().min(1),
      }),
    )
    .min(1)
    .optional(),
  titleRule: platformTitleRuleSchema.optional(),
  sourceUrl: z.url().refine((v) => {
    const url = new URL(v);
    return (
      url.protocol === "https:" &&
      url.hostname === "b.csgmall.com.cn" &&
      url.pathname.startsWith("/shop-view/")
    );
  }),
  checkedAt: z
    .string()
    .refine(
      (v) =>
        Number.isFinite(Date.parse(v)) && Date.parse(v) <= Date.now() + 60000,
    ),
});
export function kilograms(raw: string) {
  const m = raw.trim().match(/^(\d+(?:\.\d+)?)\s*(kg|千克|公斤|g|克)$/i);
  if (!m || Number(m[1]) <= 0)
    throw new PipelineError("NEEDS_INPUT", "重量必须明确单位且大于零");
  return String(
    Number(m[1]) / (m[2].toLowerCase() === "g" || m[2] === "克" ? 1000 : 1),
  );
}
export function optionalTemplateSpecs(
  specs: Product["specs"],
  fields?: {
    name: string;
    required: boolean;
  }[],
) {
  if (!fields) return {};
  const placeholder = /^(?:暂无|无|未知|不详|未提供|n\/?a|-{1,2}|—)$/i;
  return Object.fromEntries(
    fields.flatMap((field) => {
      if (field.required) return [];
      const fact = specs[field.name],
        value = fact?.value.trim() ?? "";
      return fact && value && !placeholder.test(value)
        ? [[field.name, fact]]
        : [];
    }),
  );
}

const fixedTitleParts = new Set(["品牌", "类目名称", "计价单位"]);
export class Planner {
  constructor(readonly store: Store) {
    store.db.exec(
      `CREATE TABLE IF NOT EXISTS category_templates(shop TEXT,category_id TEXT,template TEXT NOT NULL,checked_at TEXT NOT NULL,PRIMARY KEY(shop,category_id));CREATE TABLE IF NOT EXISTS shop_policies(shop TEXT,id TEXT,policy TEXT NOT NULL,checked_at TEXT NOT NULL,PRIMARY KEY(shop,id));`,
    );
  }
  importTemplate(shop: string, categoryId: string, input: unknown) {
    const parsed = templateSchema.safeParse(input);
    if (!parsed.success)
      throw new PipelineError(
        "NEEDS_INPUT",
        "类目模板结构、来源或核验时间无效",
      );
    const template = parsed.data,
      fields = template.fields;
    if (
      !shop.trim() ||
      !categoryId.trim() ||
      (template.categoryId !== undefined &&
        template.categoryId !== categoryId) ||
      new Set(template.specs).size !== template.specs.length ||
      (fields &&
        (new Set(fields.map((f) => f.id)).size !== fields.length ||
          new Set(fields.map((f) => f.name)).size !== fields.length ||
          fields.filter((f) => f.required).length !== template.specs.length ||
          template.specs.some(
            (name) => !fields.some((f) => f.required && f.name === name),
          ))) ||
      (template.titleRule &&
        (!fields ||
          template.titleRule.parts.some(
            (part) =>
              !fixedTitleParts.has(part) &&
              !fields.some((field) => field.name === part),
          )))
    )
      throw new PipelineError(
        "NEEDS_INPUT",
        "类目模板身份、重复字段或必填规格不一致",
      );
    this.store.db
      .prepare("INSERT OR REPLACE INTO category_templates VALUES(?,?,?,?)")
      .run(shop, categoryId, JSON.stringify(template), template.checkedAt);
  }
  importPolicy(
    shop: string,
    id: string,
    policy: {
      inventory: string;
      logistics: NonNullable<Plan["logistics"]>;
      afterSales?: Plan["afterSales"];
      sourceUrl: string;
      checkedAt: string;
    },
  ) {
    this.store.db
      .prepare("INSERT OR REPLACE INTO shop_policies VALUES(?,?,?,?)")
      .run(shop, id, JSON.stringify(policy), policy.checkedAt);
  }
  build(
    shop: string,
    p: Product,
    brandId: string,
    categoryId: string,
    policyId: string,
    unit: string,
  ): Plan {
    const c = this.store.db
        .prepare("SELECT * FROM catalog_categories WHERE shop=? AND id=?")
        .get(shop, categoryId),
      b = this.store.db
        .prepare("SELECT * FROM catalog_brands WHERE shop=? AND id=?")
        .get(shop, brandId);
    const t = this.store.db
        .prepare(
          "SELECT * FROM category_templates WHERE shop=? AND category_id=?",
        )
        .get(shop, categoryId),
      policyRow = this.store.db
        .prepare("SELECT * FROM shop_policies WHERE shop=? AND id=?")
        .get(shop, policyId);
    if (!c || !b || !t || !policyRow)
      throw new PipelineError("NEEDS_INPUT", "缺少目录、类目模板或店铺规则");
    if (
      Date.now() - Date.parse(String(t.checked_at)) > 86400000 ||
      Date.now() - Date.parse(String(policyRow.checked_at)) > 86400000
    )
      throw new PipelineError("NEEDS_INPUT", "模板或店铺规则需重新同步");
    const sourceBrand = p.specs["品牌"]?.value;
    if (!sourceBrand || !brandEquivalent(sourceBrand, String(b.name)))
      throw new PipelineError(
        "NEEDS_INPUT",
        "来源品牌与所选授权品牌不一致或缺失",
      );
    const template = JSON.parse(String(t.template)),
      policy = JSON.parse(String(policyRow.policy));
    const customization = listingCustomizationPolicy(
      this.store,
      shop,
      categoryId,
    );
    const need = (name: string) => {
      if (name === "是否可定制" && customization) return customization;
      const f = p.specs[name];
      if (!f)
        throw new PipelineError("NEEDS_INPUT", "缺少有来源的商品事实：" + name);
      return f;
    };
    const baseline = listingPrice(this.store, shop, p);
    const pricing =
      new CompetitivePricing(this.store).build(shop, p, categoryId, unit) ??
      baseline;
    const displayTitle = listingTitle(p, String(b.name), String(c.path));
    if (isClockListingCategory(String(c.path)) && !displayTitle)
      throw new PipelineError(
        "NEEDS_INPUT",
        "钟表标题缺少当前SKU型号或所选销售规格，不能生成可发布标题",
      );
    const specs = {
      ...Object.fromEntries(template.specs.map((n: string) => [n, need(n)])),
      ...optionalTemplateSpecs(p.specs, template.fields),
    } as Product["specs"];
    const platformTitle = template.titleRule
      ? platformGeneratedTitle({
          rule: template.titleRule,
          brand: String(b.name),
          categoryPath: String(c.path),
          specs,
          unit,
          source: p.title,
          ruleEvidence: `模板来源 ${template.sourceUrl}；核验时间 ${template.checkedAt}`,
        })
      : null;
    if (template.titleRule && !platformTitle)
      throw new PipelineError("NEEDS_INPUT", "平台商品名称规则缺少明确字段");
    const plan = planSchema.parse({
      version: 1,
      ...pricing,
      shop,
      categoryPath: c.path,
      brand: b.name,
      ...(platformTitle
        ? { displayTitle: platformTitle, titleMode: "platform-generated" }
        : displayTitle
          ? { displayTitle }
          : {}),
      catalogBinding: { brandId, categoryId },
      unit,
      inventory: policy.inventory,
      shippingTemplate: policy.logistics.templateName,
      logistics: policy.logistics,
      fields: {
        weight: {
          ...need("商品毛重"),
          value: kilograms(need("商品毛重").value),
        },
        packingName: listingPackingDisplayFact(categoryId, need("包装名称"), p),
        packingCount: need("包装数量"),
      },
      specs,
      authorization: {
        category: true,
        brandCategory: true,
        source: "数据库授权关系",
        checkedAt: new Date().toISOString(),
      },
      mediaReviewed: false,
      ...(policy.afterSales ? { afterSales: policy.afterSales } : {}),
      clearFields: ["origin", "model", "length", "width", "height"],
      replaceMedia: true,
      saveMode: "ready",
    });
    new Catalog(this.store).authorize(plan);
    return plan;
  }
}
