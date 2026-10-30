import type { CollectionPageResult } from "../analytics/collection.js";
import type { ObservationInput } from "../analytics/types.js";
import {
  inferResearchBrand,
  inferResearchCategory,
} from "../analytics/research-import.js";
import type { BrowserConfig } from "./runtime.js";
import { ensureRequestHook } from "./request-hook.js";
import { Store } from "../store.js";
import { Traffic } from "../traffic.js";

const ENDPOINT = "/search/mall/search/queryShopItemListByKeyword";
const safeNumericId = /^\d+$/;

export interface AnalyticsShopPageArgs {
  database: string;
  shopId: string;
  page: number;
  pageSize: number;
}

export interface AnalyticsShopPageResult extends CollectionPageResult {
  countSemantics: "item-groups";
  groupCount: number;
  skuCount: number;
  source: {
    endpoint: typeof ENDPOINT;
    method: "GET";
    contract: "verified-shop-list-2026-09";
  };
}

const integer = (
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
) => {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum)
    throw Error(
      `${label} must be a safe integer between ${minimum} and ${maximum}`,
    );
  return number;
};

const numericId = (value: unknown, label: string) => {
  const id = String(value ?? "");
  if (!safeNumericId.test(id)) throw Error(`${label} is unsafe or missing`);
  return id;
};

const required = (value: unknown, label: string) => {
  if (typeof value !== "string" || !value.trim())
    throw Error(`${label} is missing`);
  return value.trim();
};

const priceMinor = (value: unknown) => {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return null;
  return Math.round(number * 100);
};

/**
 * Parse the exact response contract observed in the verified shop-list source.
 * `totalCount` counts item groups, not guaranteed SKU observations. A final
 * page declares the item-group denominator separately from SKU observations;
 * the scheduler verifies all page coverage before promoting the run.
 */
export function parseAnalyticsShopPage(
  response: any,
  args: AnalyticsShopPageArgs,
  observedAt = new Date().toISOString(),
): AnalyticsShopPageResult {
  const requestedPage = integer(args.page, "page", 1, 100_000);
  const requestedPageSize = integer(args.pageSize, "pageSize", 1, 200);
  const shopId = numericId(args.shopId, "shopId");
  if (String(response?.code) !== "0")
    throw Error(
      `shop list request failed: ${String(response?.code ?? "missing code")}`,
    );
  const data = response?.data,
    list = data?.itemList;
  if (!data || !list || !Array.isArray(list.resultList))
    throw Error("shop list response is missing data.itemList.resultList");
  const page = integer(list.page, "response page", 1, 100_000);
  const pageSize = integer(list.pageSize, "response pageSize", 1, 200);
  const totalCount = integer(
    data.totalCount,
    "totalCount",
    0,
    Number.MAX_SAFE_INTEGER,
  );
  if (page !== requestedPage)
    throw Error(
      `response page ${page} differs from requested page ${requestedPage}`,
    );
  if (pageSize !== requestedPageSize)
    throw Error(
      `response pageSize ${pageSize} differs from requested pageSize ${requestedPageSize}`,
    );
  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
  if (page > totalPages)
    throw Error("response page exceeds the derived totalPages");
  if (data.totalPages != null && Number(data.totalPages) !== totalPages)
    throw Error("response totalPages conflicts with totalCount/pageSize");
  if (list.resultList.length > pageSize)
    throw Error("item group count exceeds response pageSize");

  const brandNames = Array.isArray(data.brandNameList)
    ? data.brandNameList.filter(
        (brand: unknown): brand is string => typeof brand === "string",
      )
    : [];
  const observations: ObservationInput[] = [];
  for (const [groupIndex, group] of list.resultList.entries()) {
    if (
      !group ||
      !Array.isArray(group.itemSkuInfo) ||
      !group.itemSkuInfo.length
    )
      throw Error(`item group ${groupIndex} is missing itemSkuInfo`);
    for (const sku of group.itemSkuInfo) {
      const rowShop = numericId(sku?.shopId, "SKU shopId");
      if (rowShop !== shopId)
        throw Error(
          `SKU shopId ${rowShop} differs from requested shopId ${shopId}`,
        );
      const itemId = numericId(sku?.itemId, "itemId");
      const skuId = numericId(sku?.skuId, "skuId");
      const title = required(sku?.skuName ?? sku?.itemName, "SKU title");
      const saleUnit = required(sku?.saleUnit, "saleUnit");
      const value = Number(sku?.saleCount);
      if (!Number.isFinite(value) || value < 0)
        throw Error(`saleCount is invalid for SKU ${skuId}`);
      const inferred = inferResearchBrand(title, brandNames);
      observations.push({
        platform: "hezi",
        shop: shopId,
        itemId,
        skuId,
        title,
        brand: inferred.brand,
        category: inferResearchCategory(title),
        packaging: title,
        saleUnit,
        sourceEntry: "hezi-shop-list-v1",
        field: "saleCount",
        fieldVersion: "2026-09",
        semanticsVersion: "display-cumulative-unknown-period-v1",
        currency: "CNY",
        value,
        priceMinor: priceMinor(sku?.sellPrice),
        raw: {
          itemId,
          skuId,
          shopId,
          brandId: safeNumericId.test(String(sku?.brandId ?? ""))
            ? String(sku.brandId)
            : null,
          brandIdentitySource: inferred.identitySource,
          sampleScope: "商城店铺列表实时只读样本；totalCount为商品组数",
          sourceEndpoint: ENDPOINT,
          countSemantics: "item-groups",
        },
      });
    }
  }
  if (totalCount === 0 && list.resultList.length)
    throw Error("zero totalCount conflicts with non-empty item groups");
  if (totalCount > 0 && !list.resultList.length)
    throw Error("non-zero totalCount returned an empty in-range page");

  const groupCount = list.resultList.length;
  const expectedGroups =
    page < totalPages ? pageSize : totalCount - pageSize * (page - 1);
  if (groupCount !== expectedGroups)
    throw Error(
      `item group count ${groupCount} differs from expected page coverage ${expectedGroups}`,
    );
  const completeScope = page === totalPages;
  return {
    observations,
    observedAt: new Date(Date.parse(observedAt)).toISOString(),
    totalPages,
    totalCount,
    page,
    completeScope,
    coverageCount: groupCount,
    countSemantics: "item-groups",
    groupCount,
    skuCount: observations.length,
    source: {
      endpoint: ENDPOINT,
      method: "GET",
      contract: "verified-shop-list-2026-09",
    },
  };
}

/**
 * Read exactly one public mall shop-list page. The caller owns the shared
 * publisher lock through its ExternalAdapterGuard; this adapter never locks.
 */
export async function readAnalyticsShopPage(
  page: any,
  config: BrowserConfig,
  args: AnalyticsShopPageArgs,
  health: (page: any) => Promise<unknown>,
): Promise<AnalyticsShopPageResult> {
  required(args.database, "database");
  required(config.shop, "configured shop");
  numericId(args.shopId, "shopId");
  integer(args.page, "page", 1, 100_000);
  integer(args.pageSize, "pageSize", 1, 200);
  await health(page);
  const current = new URL(await page.url());
  if (!/(^|\.)csgmall\.com\.cn$/.test(current.hostname))
    throw Error("analytics collection requires a csgmall.com.cn page");
  if (!current.pathname.startsWith("/mall-view/"))
    throw Error("analytics collection requires a public mall page");
  if (/supplier|publish|editor/i.test(current.pathname))
    throw Error(
      "analytics collection cannot run on a supplier publishing page",
    );
  await ensureRequestHook(page);
  const parameters = {
    shopId: args.shopId,
    shopInfoId: args.shopId,
    type: 1,
    platformId: 20,
    accountType: 2,
    accountId: 1,
    pageNum: args.page,
    pageSize: args.pageSize,
  };
  const expression = `new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Object.assign(new Error('analytics shop-list timeout'),{kind:'timeout'})),20000);try{layui.admin.req(${JSON.stringify(ENDPOINT)},${JSON.stringify(parameters)},response=>{clearTimeout(timer);resolve(response)},'GET')}catch(error){clearTimeout(timer);reject(error)}})`;
  const store = new Store(args.database);
  let receipt: any;
  try {
    receipt = await new Traffic(store, config.shop).run(
      "analytics-shop-page",
      () =>
        page.cdp("Runtime.evaluate", {
          expression,
          awaitPromise: true,
          returnByValue: true,
        }),
    );
  } finally {
    store.close();
  }
  if (receipt.exceptionDetails || !receipt.result?.value)
    throw Object.assign(
      new Error(
        receipt.exceptionDetails?.exception?.description ??
          receipt.exceptionDetails?.text ??
          "shop list request returned no value",
      ),
      {
        kind: /timeout/i.test(
          receipt.exceptionDetails?.exception?.description ?? "",
        )
          ? "timeout"
          : "unavailable",
      },
    );
  await health(page);
  return parseAnalyticsShopPage(receipt.result.value, args);
}
