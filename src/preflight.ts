import { Catalog } from "./catalog.js";
import { Jobs, type Job } from "./jobs.js";
import { listingCustomizationPolicy } from "./listing-service-policy.js";
import { listingPrice } from "./listing-price.js";
import { PipelineError, validate, type ValidationPhase } from "./model.js";
import { SourceIndex } from "./source-index.js";
import { Store } from "./store.js";

export type PreflightIssueCode =
  | "COLLECT_REQUIRED"
  | "PRODUCT_MISSING"
  | "PLAN_REQUIRED"
  | "FACT_MISSING"
  | "PRICING_INVALID"
  | "TEMPLATE_FIELDS_MISSING"
  | "PENDING_OPERATION"
  | "CATALOG_MISSING"
  | "TEMPLATE_MISSING"
  | "TEMPLATE_STALE"
  | "FIELD_TYPE_UNSUPPORTED"
  | "POLICY_MISSING"
  | "POLICY_STALE"
  | "AUTHORIZATION_INVALID"
  | "VALIDATION_MISSING"
  | "SOURCE_ALREADY_EXISTS"
  | "SOURCE_INDEX_INCOMPLETE";

export interface PreflightIssue {
  code: PreflightIssueCode;
  message: string;
  field?: string;
}

export interface JobPreflight {
  jobId: string;
  sku: string;
  productId: string | null;
  ready: boolean;
  issues: PreflightIssue[];
}

export interface QueuePreflight {
  ready: boolean;
  checked: number;
  items: JobPreflight[];
}

export const COLLECTION_GATE_CODES = new Set<PreflightIssueCode>([
  "PENDING_OPERATION",
  "CATALOG_MISSING",
  "TEMPLATE_MISSING",
  "TEMPLATE_STALE",
  "TEMPLATE_FIELDS_MISSING",
  "FIELD_TYPE_UNSUPPORTED",
  "POLICY_MISSING",
  "POLICY_STALE",
  "AUTHORIZATION_INVALID",
  "SOURCE_ALREADY_EXISTS",
]);

export function collectionGateIssues(result: JobPreflight) {
  return result.issues.filter((entry) => COLLECTION_GATE_CODES.has(entry.code));
}

const DAY = 24 * 3600 * 1000;
// The current writer handles a plain input/textarea and an Ant single-select.
// Values outside the platform's known text/single-select family must be adapted
// explicitly instead of being discovered during a save.
export const SUPPORTED_TEMPLATE_FIELD_TYPES = new Set(["1", "3"]);

function issue(
  issues: PreflightIssue[],
  code: PreflightIssueCode,
  message: string,
  field?: string,
) {
  if (
    !issues.some(
      (x) => x.code === code && x.message === message && x.field === field,
    )
  )
    issues.push({ code, message, ...(field ? { field } : {}) });
}

function stale(checkedAt: unknown, now: number) {
  const time = Date.parse(String(checkedAt));
  return !Number.isFinite(time) || time > now + 60000 || now - time > DAY;
}

function controlledWaveKey(store: Store, jobs: Jobs, job: Job) {
  const assigned = [...jobs.events(job.id)]
    .reverse()
    .find((entry: any) => entry.kind === "source-assigned");
  if (!assigned) return null;
  let detail: any;
  try {
    detail = JSON.parse(String(assigned.detail));
  } catch {
    return null;
  }
  if (
    typeof detail?.waveKey !== "string" ||
    !detail.waveKey ||
    detail.sku !== job.sku
  )
    return null;
  const wave: any = store.meta(detail.waveKey);
  if (
    !wave ||
    !Array.isArray(wave.candidates) ||
    !Array.isArray(wave.groups) ||
    wave.candidates.filter((candidate: any) => candidate?.sku === job.sku)
      .length !== 1 ||
    !wave.groups.some(
      (group: any) =>
        Array.isArray(group?.items) &&
        group.items.some(
          (item: any) => item?.id === job.id && item?.sku === job.sku,
        ),
    )
  )
    return null;
  return detail.waveKey;
}

/** Read-only local readiness check. It never collects, scans, plans, or writes. */
export function preflightJob(
  store: Store,
  jobs: Jobs,
  input: Job | string,
  now = Date.now(),
  options: { phase?: ValidationPhase } = {},
): JobPreflight {
  const job = typeof input === "string" ? jobs.get(input) : input;
  const issues: PreflightIssue[] = [];
  const row = job.productId
    ? (() => {
        try {
          return store.get(job.productId!);
        } catch {
          return null;
        }
      })()
    : (store.list().find((x) => x.shop === jobs.shop && x.sku === job.sku) ??
      null);
  const templateRow = store.db
    .prepare("SELECT * FROM category_templates WHERE shop=? AND category_id=?")
    .get(jobs.shop, job.recipe.categoryId);
  const policyRow = store.db
    .prepare("SELECT * FROM shop_policies WHERE shop=? AND id=?")
    .get(jobs.shop, job.recipe.policyId);
  const category = store.db
    .prepare("SELECT * FROM catalog_categories WHERE shop=? AND id=?")
    .get(jobs.shop, job.recipe.categoryId);
  const brand = store.db
    .prepare("SELECT * FROM catalog_brands WHERE shop=? AND id=?")
    .get(jobs.shop, job.recipe.brandId);

  if (!category || !brand)
    issue(issues, "CATALOG_MISSING", "所选品牌或类目目录缺失，请先同步");

  if (!templateRow)
    issue(issues, "TEMPLATE_MISSING", "类目模板缺失，请先读取模板");
  else {
    if (stale(templateRow.checked_at, now))
      issue(issues, "TEMPLATE_STALE", "类目模板已过期，请重新读取");
    try {
      const template = JSON.parse(String(templateRow.template));
      if (!Array.isArray(template.fields) || !template.fields.length)
        issue(
          issues,
          "TEMPLATE_FIELDS_MISSING",
          "类目模板缺少字段类型信息，请重新读取模板",
        );
      if (Array.isArray(template.fields))
        for (const field of template.fields)
          if (
            (field.required || row?.plan?.specs?.[String(field.name)]) &&
            !SUPPORTED_TEMPLATE_FIELD_TYPES.has(String(field.selectType))
          )
            issue(
              issues,
              "FIELD_TYPE_UNSUPPORTED",
              `规格字段 ${String(field.name)} 的类型 ${String(field.selectType)} 暂不支持`,
              String(field.name),
            );
    } catch {
      issue(issues, "TEMPLATE_MISSING", "类目模板内容无法解析，请重新读取");
    }
  }
  if (!policyRow) issue(issues, "POLICY_MISSING", "店铺规则缺失，请先同步");
  else if (stale(policyRow.checked_at, now))
    issue(issues, "POLICY_STALE", "店铺规则已过期，请重新同步");

  const authorizationInput =
    row?.product && row.plan
      ? row.plan
      : category && brand
        ? {
            shop: jobs.shop,
            brand: String(brand.name),
            categoryPath: String(category.path),
            catalogBinding: {
              brandId: job.recipe.brandId,
              categoryId: job.recipe.categoryId,
            },
          }
        : null;
  if (authorizationInput) {
    try {
      new Catalog(store).authorize(authorizationInput, now);
    } catch (error) {
      issue(
        issues,
        "AUTHORIZATION_INVALID",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  if (controlledWaveKey(store, jobs, job)) {
    try {
      const matches = new SourceIndex(store).lookup(jobs.shop, job.sku);
      if (matches.length)
        issue(
          issues,
          "SOURCE_ALREADY_EXISTS",
          `受控新建批次的SKU ${job.sku} 已存在于来源索引：${[
            ...new Set(matches.map((match) => match.itemId)),
          ].join("、")}`,
        );
    } catch {
      // An incomplete index cannot prove that a remote product already exists.
    }
  }

  if (!row) {
    issue(issues, "COLLECT_REQUIRED", "商品尚未采集，已标记待采集");
    return {
      jobId: job.id,
      sku: job.sku,
      productId: null,
      ready: false,
      issues,
    };
  }
  if (!row.product) issue(issues, "PRODUCT_MISSING", "商品来源资料缺失");
  if (!row.plan) issue(issues, "PLAN_REQUIRED", "商品计划尚未生成");
  if (store.pending(row.id))
    issue(
      issues,
      "PENDING_OPERATION",
      "商品存在未完成写入，必须先对账确认结果",
    );
  if (row.product) {
    const required = ["商品毛重", "包装名称", "包装数量"];
    const customization = listingCustomizationPolicy(
      store,
      jobs.shop,
      job.recipe.categoryId,
    );
    if (templateRow) {
      try {
        const template = JSON.parse(String(templateRow.template));
        if (Array.isArray(template.specs)) required.push(...template.specs);
      } catch {
        // The malformed template is already reported above.
      }
    }
    for (const name of [...new Set(required)]) {
      // This is a source-fact gate. An approved shop policy supplies this
      // listing field later, but must never be written back as a JD fact.
      if (name === "是否可定制" && customization) continue;
      if (!row.product.specs[name])
        issue(issues, "FACT_MISSING", `缺少有来源的商品事实：${name}`, name);
    }
    try {
      listingPrice(store, jobs.shop, row.product);
    } catch (error) {
      issue(
        issues,
        "PRICING_INVALID",
        error instanceof Error ? error.message : String(error),
        "price",
      );
    }
  }
  if (row.product && row.plan) {
    for (const message of validate(row.product, row.plan, options))
      issue(issues, "VALIDATION_MISSING", message);
  }
  if (!row.remoteId) {
    try {
      new SourceIndex(store).lookup(jobs.shop, job.sku);
    } catch (error) {
      issue(
        issues,
        "SOURCE_INDEX_INCOMPLETE",
        error instanceof PipelineError
          ? error.message
          : "全店来源索引尚未完整同步或已过期",
      );
    }
  }
  return {
    jobId: job.id,
    sku: job.sku,
    productId: row.id,
    ready: issues.length === 0,
    issues,
  };
}

export function preflightQueue(
  store: Store,
  jobs: Jobs,
  inputs: (Job | string)[] = jobs
    .list()
    .filter((job) => job.status === "QUEUED"),
  now = Date.now(),
): QueuePreflight {
  const items = inputs.map((job) => preflightJob(store, jobs, job, now));
  return {
    ready: items.every((item) => item.ready),
    checked: items.length,
    items,
  };
}

export function preflightMessage(result: JobPreflight) {
  return result.issues.map((x) => x.message).join("；");
}
