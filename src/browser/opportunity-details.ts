import { MarketDetails } from "../market-details.js";
import { Store } from "../store.js";
import type { BrowserConfig } from "./runtime.js";
import { ensureRequestHook } from "./request-hook.js";
import { Traffic } from "../traffic.js";

/** A frozen opportunity identity supplied by the opportunity workflow, not a search result. */
export interface OpportunityDetailIdentity {
  opportunityId: string;
  itemId: string;
  skuId: string;
  marketShopId: string;
}

export interface OpportunityDetailsArgs {
  database: string;
  opportunities: readonly OpportunityDetailIdentity[];
  /** A bounded round may hydrate at most three explicit opportunities. */
  limit?: number;
}

type PublishMetadata = {
  brandName: string;
  brandId: string | null;
  cid: string | null;
  categoryFullName: string | null;
};

const endpoint =
  "layui.config.item_server+'/mall/search/queryNormalItemDetails'";

function id(value: unknown, name: string) {
  if (
    (typeof value !== "string" && typeof value !== "number") ||
    String(value).trim() === ""
  )
    throw Error(`机会身份缺少${name}`);
  return String(value);
}

function cohort(input: readonly OpportunityDetailIdentity[]) {
  if (!Array.isArray(input) || input.length === 0)
    throw Error("需要至少一个明确的机会身份");
  const seen = new Set<string>();
  return input.map((raw) => {
    const value = {
      opportunityId: id(raw?.opportunityId, "opportunityId"),
      itemId: id(raw?.itemId, "itemId"),
      skuId: id(raw?.skuId, "skuId"),
      marketShopId: id(raw?.marketShopId, "marketShopId"),
    };
    const key = JSON.stringify(value);
    if (seen.has(key)) throw Error("机会队列包含重复身份");
    seen.add(key);
    return Object.freeze(value);
  });
}

function safeString(value: unknown) {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function safeIdentifier(value: unknown) {
  if (typeof value === "string") return value.trim() === "" ? null : value;
  return typeof value === "number" && Number.isSafeInteger(value)
    ? String(value)
    : null;
}

function publishMetadata(payload: unknown): PublishMetadata {
  const publish = (payload as any)?.data?.itemPublishVo;
  const brandName =
    typeof publish?.brandName === "string" ? publish.brandName : "";
  return {
    brandName,
    brandId: safeIdentifier(publish?.brandId),
    cid: safeIdentifier(publish?.cid),
    categoryFullName: safeString(publish?.categoryFullName),
  };
}

function suggestedJdLinks(sourceSkus: string[]) {
  return sourceSkus.map(
    (sku) => `https://item.jd.com/${encodeURIComponent(sku)}.html`,
  );
}

function cachedMetadata(store: Store, receiptId: string) {
  const row = store.db
    .prepare("SELECT payload FROM market_details WHERE id=?")
    .get(receiptId) as { payload?: unknown } | undefined;
  if (!row || typeof row.payload !== "string")
    throw Error("竞品详情证据不存在");
  return publishMetadata(JSON.parse(row.payload));
}

function receipt(
  opportunity: OpportunityDetailIdentity,
  detail: ReturnType<MarketDetails["get"]>,
  metadata: PublishMetadata,
  cache: "fresh-cache" | "network",
) {
  if (detail.shopId !== opportunity.marketShopId)
    throw Error("详情回执与机会店铺身份不一致");
  const sku = detail.skus.find(
    (candidate) => candidate.id === opportunity.skuId,
  );
  if (!sku) throw Error("详情回执缺少机会目标SKU");
  return {
    opportunityId: opportunity.opportunityId,
    itemId: opportunity.itemId,
    skuId: opportunity.skuId,
    marketShopId: opportunity.marketShopId,
    receiptId: detail.id,
    cache,
    verified: {
      checkedAt: detail.checkedAt,
      itemPublishVo: metadata,
      sku: {
        id: sku.id,
        title: sku.title,
        price: sku.price,
        available: sku.available,
        unit: sku.unit,
        attributes: sku.attributes,
        sourceSkus: sku.sourceSkus,
      },
    },
    suggestions: {
      jdItemLinks: suggestedJdLinks(sku.sourceSkus),
      reviewRequired: true,
      reason: "京东链接仅是详情中观察到的来源线索，不能单独证明同款或授权发布",
    },
  };
}

async function readResponse(page: any, itemId: string) {
  const response = await page.cdp("Runtime.evaluate", {
    expression: `new Promise(resolve=>layui.admin.req(${endpoint},${JSON.stringify({ platformId: 20, itemId, areaId: -1, accountType: 2 })},res=>resolve(res),'GET'))`,
    awaitPromise: true,
    returnByValue: true,
  });
  if (response.exceptionDetails || !response.result?.value)
    throw Error("商城详情未返回有效回执");
  return response.result.value;
}

/**
 * Hydrate a caller-owned, explicit opportunity cohort. This deliberately has
 * no search-run argument and does not claim any search-scope completeness.
 */
export async function hydrateOpportunityDetails(
  page: any,
  config: BrowserConfig,
  args: OpportunityDetailsArgs,
  health: (page: any) => Promise<unknown>,
) {
  const opportunities = cohort(args.opportunities);
  const limit = args.limit ?? 3;
  if (!Number.isInteger(limit) || limit < 1 || limit > 3)
    throw Error("每轮最多三个机会详情");
  const selected = opportunities.slice(0, limit);
  const store = new Store(args.database);
  const details = new MarketDetails(store);
  const traffic = new Traffic(store, config.shop);
  let release: (() => void) | undefined;
  try {
    release = store.lock("publisher");
    store.assertRunning(config.shop);
    await health(page);
    let current = new URL(await page.url());
    // Inventory and authorization reads leave the shared page on known lists.
    // Never silently discard a product editor's changes.
    if (
      current.hostname === "b.csgmall.com.cn" &&
      (current.href === config.listUrl ||
        current.href ===
          "https://b.csgmall.com.cn/shop-view/#/shop-view/brand/regulate")
    ) {
      const first = selected[0];
      const target = new URL("/mall-view/product/detail", current.origin);
      target.searchParams.set("itemId", first.itemId);
      target.searchParams.set("skuId", first.skuId);
      await traffic.run("opportunity-workspace", async () => {
        await page.goto(target.href);
        await page.waitForFunction(
          () => typeof (window as any).layui?.admin?.req === "function",
          undefined,
          { timeout: 20000 },
        );
        await health(page);
      });
      current = new URL(await page.url());
    }
    if (!/(^|\.)csgmall\.com\.cn$/.test(current.hostname))
      throw Error("机会详情需要 csgmall.com.cn 的商城页面");
    if (!current.pathname.startsWith("/mall-view/"))
      throw Error("机会详情需要 mall-view 商城页面");
    if (/supplier|publish|editor/i.test(current.pathname))
      throw Error("机会详情不能在供应商发布页面运行");
    await ensureRequestHook(page);

    const receipts = [];
    for (const opportunity of selected) {
      store.assertRunning(config.shop);
      const cached = details.fresh(config.shop, opportunity.itemId);
      if (cached) {
        receipts.push(
          receipt(
            opportunity,
            cached,
            cachedMetadata(store, cached.id),
            "fresh-cache",
          ),
        );
        continue;
      }
      await health(page);
      const payload = await traffic.run("opportunity-detail", () =>
        readResponse(page, opportunity.itemId),
      );
      await health(page);
      const receiptId = details.save(
        config.shop,
        opportunity.itemId,
        opportunity.marketShopId,
        payload,
        new Date().toISOString(),
        [opportunity.skuId],
      );
      receipts.push(
        receipt(
          opportunity,
          details.get(receiptId),
          publishMetadata(payload),
          "network",
        ),
      );
    }
    return { receipts };
  } finally {
    release?.();
    store.close();
  }
}
