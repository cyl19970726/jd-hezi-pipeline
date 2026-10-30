import { createHash } from "node:crypto";
import { z } from "zod";
import { validateProductCategorySemantics } from "./product-category-semantics.js";

export const factSchema = z.object({
  value: z.string().min(1),
  sourceUrl: z.string().url(),
  capturedAt: z.string().datetime(),
  evidence: z.string().min(1),
});
export const priceFactSchema = factSchema.extend({
  basis: z.enum(["subsidy", "jd-price"]).optional(),
});
export const assetSchema = z.object({
  role: z.enum(["main", "detail"]),
  origin: z.literal("android-album").optional(),
  url: z.string().url(),
  order: z.number().int().nonnegative(),
  path: z.string().optional(),
  originalPath: z.string().optional(),
  originalSha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  sha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  width: z.number().positive().optional(),
  height: z.number().positive().optional(),
});
export const productSchema = z.object({
  sku: z.string().regex(/^\d+$/),
  variant: z.string().default(""),
  url: z.string().url(),
  title: factSchema,
  price: priceFactSchema.nullable(),
  specs: z.record(z.string(), factSchema),
  assets: z.array(assetSchema),
  capturedAt: z.string().datetime(),
});
export const planSchema = z
  .object({
    version: z.literal(1),
    rulesVersion: z.string().min(1),
    shop: z.string().min(1),
    categoryPath: z.string().min(1),
    brand: z.string().min(1),
    displayTitle: factSchema.optional(),
    titleMode: z.enum(["source", "platform-generated"]).optional(),
    catalogBinding: z
      .object({ brandId: z.string().min(1), categoryId: z.string().min(1) })
      .optional(),
    unit: z.string().min(1),
    price: factSchema.extend({
      basis: z
        .enum([
          "subsidy",
          "jd-price",
          "competitor-minus-cent",
          "competitor-bounded",
        ])
        .optional(),
    }),
    pricingReviewId: z.string().uuid().optional(),
    competitivePricingReviewId: z.string().uuid().optional(),
    inventory: z.string().regex(/^\d+(\.\d{1,3})?$/),
    shippingTemplate: z.string().min(1),
    logistics: z
      .object({
        sourceItemId: z.string(),
        checkedAt: z.string().datetime(),
        templateId: z.string(),
        templateName: z.string(),
        addressIds: z.array(z.string()).min(1),
        areas: z
          .array(z.object({ areaId: z.string(), areaName: z.string() }))
          .min(1),
      })
      .optional(),
    fields: z.record(z.string(), factSchema),
    specs: z.record(z.string(), factSchema),
    authorization: z.object({
      category: z.literal(true),
      brandCategory: z.literal(true),
      source: z.string().min(1),
      checkedAt: z.string().datetime(),
    }),
    mediaReviewed: z.boolean(),
    mediaEvidenceDigest: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    afterSales: z
      .object({
        refund: factSchema,
        exchange: factSchema,
        warranty: factSchema,
      })
      .optional(),
    clearFields: z
      .array(z.enum(["model", "length", "width", "height", "origin"]))
      .optional(),
    replaceMedia: z.boolean().optional(),
    saveMode: z.enum(["draft", "ready"]).optional(),
    remoteMedia: z
      .object({
        main: z.array(z.string().url()),
        detail: z.array(z.string().url()),
      })
      .optional(),
  })
  .superRefine((plan, ctx) => {
    if (
      plan.titleMode === "platform-generated" &&
      (!plan.displayTitle || !plan.catalogBinding)
    )
      ctx.addIssue({
        code: "custom",
        message: "平台自动标题缺少标题事实或类目绑定",
      });
  });
export type Product = z.infer<typeof productSchema>;
export type Plan = z.infer<typeof planSchema>;
export type Asset = z.infer<typeof assetSchema>;
export const states = [
  "DISCOVERED",
  "EXTRACTED",
  "VALIDATED",
  "DRAFT_SAVED",
  "DRAFT_VERIFIED",
  "SUBMIT_REQUESTED",
  "SUBMITTED",
  "APPROVED",
  "REJECTED",
  "ON_SALE",
  "NEEDS_INPUT",
  "AUTH_REQUIRED",
  "RATE_LIMITED",
  "BUSINESS_BLOCKED",
  "UNKNOWN_OUTCOME",
] as const;
export type State = (typeof states)[number];
export type ErrorCode =
  | "CONTROL_REQUIRED"
  | "AUTH_REQUIRED"
  | "ACCOUNT_CHANGED"
  | "RATE_LIMITED"
  | "BUSINESS_BLOCKED"
  | "VALIDATION_MISSING"
  | "UNSUPPORTED_MEDIA"
  | "UI_CHANGED"
  | "UNKNOWN_OUTCOME"
  | "LOCKED"
  | "PAUSED"
  | "NEEDS_INPUT";
export class PipelineError extends Error {
  constructor(
    public code: ErrorCode,
    message: string,
    public details: unknown = null,
  ) {
    super(message);
    this.name = "PipelineError";
  }
}
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object")
    return (
      "{" +
      Object.entries(value)
        .filter(([, v]) => v !== undefined)
        // Preserve the service's existing canonical order across Ego's zh-CN locale.
        .sort(([a], [b]) => a.localeCompare(b, "en-US"))
        .map(([k, v]) => JSON.stringify(k) + ":" + canonical(v))
        .join(",") +
      "}"
    );
  return JSON.stringify(value);
}
export function digest(value: unknown) {
  return createHash("sha256").update(canonical(value)).digest("hex");
}
export function mediaSubjectDigest(product: Product) {
  return digest({
    sku: product.sku,
    variant: product.variant,
    selectedSaleSpec: product.specs["京东销售规格"],
    assets: product.assets.map(({ url, role, order, sha256 }) => ({
      url,
      role,
      order,
      sha256,
    })),
  });
}
export function identity(shop: string, sku: string, variant = "") {
  return digest([shop, "jd", sku, variant]);
}
export function parseSku(input: string): string {
  if (/^\d+$/.test(input)) return input;
  const u = new URL(input);
  const m = u.pathname.match(/^\/(\d+)\.html$/);
  if (u.hostname !== "item.jd.com" || !m)
    throw new PipelineError("NEEDS_INPUT", "请输入京东单品 URL 或 SKU。");
  return m[1];
}
export function money(input: string): string | null {
  const s = input.replace(/[¥￥,\s]/g, "");
  return /^\d+(\.\d{1,2})?$/.test(s) && Number(s) > 0
    ? Number(s).toFixed(2)
    : null;
}
export function classify(message: string): ErrorCode {
  if (/资质|经营范围|授权品牌/.test(message)) return "BUSINESS_BLOCKED";
  if (/passport\.jd|sso\.csgmall|扫码登录|请先登录|AUTH_REQUIRED/.test(message))
    return "AUTH_REQUIRED";
  if (/WAF|风控|验证码|risk_handler|访问频繁|RATE_LIMITED/i.test(message))
    return "RATE_LIMITED";
  if (/必填|不能为空|请填写|请输入|请上传/.test(message))
    return "VALIDATION_MISSING";
  return "UI_CHANGED";
}
export interface MediaReferences {
  main: string[];
  detail: string[];
}
export interface Row {
  id: string;
  shop: string;
  sku: string;
  variant: string;
  state: State;
  product: Product | null;
  plan: Plan | null;
  dataHash: string;
  remoteId: string | null;
  remoteCode: string | null;
  verifiedHash: string | null;
  error: string | null;
  revision: number;
  mediaReferences: MediaReferences | null;
}
export interface RemoteRecord {
  itemId: string;
  code: string;
  sku: string;
  title: string;
  shop: string;
  status: string;
  platformWarning?: string | null;
  mediaReferences?: MediaReferences;
}
export interface RemoteSnapshot extends RemoteRecord {
  logistics?: {
    hasOrderInfo?: number;
    templateId: string;
    addressIds: string[];
    areas: { areaId: string; areaName: string }[];
  };
  fields: Record<string, string>;
  specs: Record<string, string>;
  mainImages: { url: string; loaded: boolean }[];
  detailImages: { url: string; loaded: boolean }[];
  requiredMissing: string[];
}
export interface Adapter {
  checkShop(shop: string): Promise<void>;
  find(
    product: Product,
    plan: Plan,
  ): Promise<{ complete: boolean; records: RemoteRecord[] }>;
  save(
    product: Product,
    plan: Plan,
    itemId: string | null,
    mediaReferences?: MediaReferences | null,
  ): Promise<RemoteRecord>;
  read(itemId: string): Promise<RemoteSnapshot>;
  submit(itemId: string): Promise<RemoteRecord>;
  withdraw?(itemId: string): Promise<RemoteRecord>;
}
export type ValidationPhase = "facts" | "final";

export function validate(
  product: Product,
  plan: Plan,
  options: { phase?: ValidationPhase } = {},
): string[] {
  const phase = options.phase ?? "final";
  const errors: string[] = [];
  if (parseSku(product.url) !== product.sku)
    errors.push("来源 URL 与 SKU 不一致");
  if (
    plan.displayTitle &&
    plan.displayTitle.sourceUrl !== product.url &&
    !product.assets.some((asset) => asset.url === plan.displayTitle!.sourceUrl)
  )
    errors.push("显示标题来源必须是当前SKU商品页或已知原图");
  errors.push(...validateProductCategorySemantics(product, plan));
  if (!money(plan.price.value))
    errors.push("售价必须为明确的正数，最多两位小数");
  if (plan.rulesVersion === "catalog-v3" && !plan.pricingReviewId)
    errors.push("新上架规则要求持久化同款比价记录");
  if (
    plan.price.basis === "competitor-bounded" ||
    plan.competitivePricingReviewId ||
    plan.rulesVersion === "catalog-competitive-v1"
  ) {
    if (
      !plan.competitivePricingReviewId ||
      plan.price.basis !== "competitor-bounded" ||
      plan.rulesVersion !== "catalog-competitive-v1" ||
      !plan.catalogBinding
    )
      errors.push("有界竞品定价缺少持久化复核或类目绑定");
    if (plan.pricingReviewId) errors.push("两种竞品定价凭证不能混用");
  } else if (plan.price.basis === "competitor-minus-cent") {
    if (!plan.pricingReviewId) errors.push("竞品定价缺少持久化比价记录");
  } else {
    if (
      !product.price?.basis ||
      product.price.basis !== plan.price.basis ||
      (plan.price.basis === "jd-price" && plan.rulesVersion !== "catalog-jd-v2")
    )
      errors.push(
        "缺少明确补贴价或京东价来源，禁止使用到手价或无标签划线价；请重新采集核价",
      );
    if (product.price && money(product.price.value) !== money(plan.price.value))
      errors.push("计划售价与来源价格不一致");
  }
  for (const role of ["main", "detail"] as const) {
    const a = product.assets.filter((x) => x.role === role);
    if (role === "main" && a.length > 10) errors.push("主图最多10张");
    if (a.length < (role === "main" ? 3 : 1))
      errors.push(`${role} 有效图片不足`);
    if (a.some((asset, index) => asset.order !== index))
      errors.push(`${role} 图片来源顺序无效`);
    if (phase === "final") {
      if (a.some((x) => !x.path || !x.sha256 || !x.width || !x.height))
        errors.push(`${role} 图片尚未下载和解码验证`);
    }
  }
  if (new Date(plan.authorization.checkedAt).getTime() > Date.now() + 60000)
    errors.push("资质核验时间不能在未来");
  if (Date.now() - Date.parse(plan.authorization.checkedAt) > 24 * 3600 * 1000)
    errors.push("资质核验超过24小时，请重新核对当前账号");
  if (
    plan.specs["总净含量"] &&
    !/^\d+(?:\.\d+)?\s*(?:g|kg|克|千克|mL|ml|L|升|毫升)$/i.test(
      plan.specs["总净含量"].value,
    )
  )
    errors.push("总净含量必须包含质量或体积单位");
  return errors;
}
export function expectedFields(
  product: Product,
  plan: Plan,
): Record<string, string> {
  const title = (plan.displayTitle?.value ?? product.title.value).replace(
    /\*/g,
    "×",
  );
  return {
    ...Object.fromEntries(
      Object.entries(plan.fields).map(([k, v]) => [k, v.value]),
    ),
    ...(plan.afterSales
      ? {
          after_refund: plan.afterSales.refund.value,
          after_exchange: plan.afterSales.exchange.value,
          after_warranty: plan.afterSales.warranty.value,
          after_refund_mode: "2",
          after_exchange_mode: "2",
        }
      : {}),
    title:
      plan.titleMode === "platform-generated"
        ? title
        : title.endsWith("/" + plan.unit)
          ? title
          : title + "/" + plan.unit,
    category: plan.categoryPath,
    brand: plan.brand,
    unit: plan.unit,
    price: money(plan.price.value)!,
    inventory: plan.inventory,
    shippingTemplate: plan.shippingTemplate,
    sourceUrl: product.url,
  };
}
export function verify(
  snapshot: RemoteSnapshot,
  product: Product,
  plan: Plan,
  mediaReferences?: MediaReferences | null,
): string[] {
  const errors: string[] = [];
  const normalize = (s: string) => s.replace(/\s/g, "").replace(/＞/g, ">");
  // The platform currently reloads the volume suffix as `ML`.  This is the
  // only equivalence accepted for total net content; all other text and units
  // remain exact evidence rather than a broad case-insensitive comparison.
  const normalizeTotalNetContent = (s: string) =>
    normalize(s).replace(/(?:mL|ml|ML)$/, "mL");
  const normalizeSpec = (key: string, value: string) =>
    key === "纸张尺寸" &&
    plan.catalogBinding?.categoryId === "10015007" &&
    /^a4$/i.test(normalize(value))
      ? "A4"
      : key === "总净含量"
        ? normalizeTotalNetContent(value)
        : key === "规格"
          ? normalize(value).replace(
              /^(\d+(?:\.\d+)?)(?:mL|ml|ML)(×\d+瓶)$/,
              "$1mL$2",
            )
          : key === "净含量"
            ? normalize(value).toLowerCase()
            : key === "型号" &&
                plan.catalogBinding?.categoryId === "10049005" &&
                /^\d+[A-Za-z]{1,4}$/.test(normalize(value))
              ? // This supplier clip template persists numeric models' Latin suffix
                // in lower case. Keep every digit, suffix character and other field exact.
                normalize(value).toLowerCase()
              : ((key === "尺寸规格" &&
                    plan.catalogBinding?.categoryId === "10048009") ||
                    (key === "书写粗细" &&
                      plan.catalogBinding?.categoryId === "10041013")) &&
                  /^\d+(?:\.\d+)?mm$/i.test(normalize(value))
                ? normalize(value).replace(/mm$/i, "mm")
                : key === "材质" &&
                    plan.catalogBinding?.categoryId === "10048009" &&
                    /^pp$/i.test(normalize(value))
                  ? "PP"
                  : normalize(value);
  if (snapshot.shop !== plan.shop || snapshot.sku !== product.sku)
    errors.push("远端店铺或 SKU 身份不匹配");
  for (const [k, v] of Object.entries(expectedFields(product, plan))) {
    const actual = snapshot.fields[k] ?? "";
    const equal =
      k === "price"
        ? money(actual) === money(v)
        : ["inventory", "weight", "length", "width", "height"].includes(k)
          ? actual.trim() !== "" && Number(actual) === Number(v)
          : normalize(actual) === normalize(v);
    if (!equal) errors.push(`字段 ${k} 读回不一致：预期 ${v}，实际 ${actual}`);
  }
  for (const [k, v] of Object.entries(plan.specs))
    if (normalizeSpec(k, snapshot.specs[k] ?? "") !== normalizeSpec(k, v.value))
      errors.push(`规格 ${k} 未持久化或不一致`);
  for (const key of plan.clearFields ?? [])
    if ((snapshot.fields[key] ?? "").trim())
      errors.push(`字段 ${key} 应清空但仍有继承值`);
  for (const [role, list] of [
    ["main", snapshot.mainImages],
    ["detail", snapshot.detailImages],
  ] as const) {
    if (list.length !== product.assets.filter((a) => a.role === role).length)
      errors.push(`${role} 图片数量未持久化`);
    if (list.some((a) => !a.loaded || !/^https?:/.test(a.url)))
      errors.push(`${role} 图片不可加载或未上传到平台`);
    const refs = (mediaReferences ?? plan.remoteMedia)?.[role];
    if (
      !refs ||
      refs.length !== list.length ||
      refs.some((url, i) => url !== list[i]?.url)
    )
      errors.push(`${role} 平台图片引用或顺序尚未核对`);
  }
  if (plan.logistics) {
    const sorted = (xs: string[]) => JSON.stringify([...xs].sort());
    if (
      !snapshot.logistics ||
      snapshot.logistics.templateId !== plan.logistics.templateId ||
      sorted(snapshot.logistics.addressIds) !==
        sorted(plan.logistics.addressIds) ||
      sorted(snapshot.logistics.areas.map((x) => x.areaId)) !==
        sorted(plan.logistics.areas.map((x) => x.areaId))
    )
      errors.push("配送范围、模板或发货地址未完整持久化");
  }
  errors.push(...snapshot.requiredMissing.map((k) => `必填缺失：${k}`));
  return errors;
}
