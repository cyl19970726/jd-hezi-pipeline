import { Store } from "../store.js";
import { JdTraffic } from "../jd-traffic.js";
import { digest } from "../model.js";
import type { BrowserConfig } from "./runtime.js";

export const SOURCE_SEARCH_PARSER = "jd-source-search/2";

export function sourceSearchReady() {
  return (
    !!document.querySelector(".plugin_goodsCardWrapper[data-sku]") ||
    !!document.querySelector('a[href*="item.jd.com/"]') ||
    /(?:抱歉，没有找到|暂无相关商品|未找到相关商品|没有搜索到相关商品)/u.test(
      document.body?.textContent ?? "",
    )
  );
}

/** Discovery only: a search card never proves a product's brand, model or pack. */
export function readSourceSearchCards(input: { query: string; limit: number }) {
  const pageUrl = new URL(location.href);
  if (
    pageUrl.hostname !== "search.jd.com" ||
    pageUrl.searchParams.get("keyword") !== input.query
  )
    throw Error("京东搜索页面与当前查询不一致");
  const candidates = new Map<
    string,
    { sku: string; url: string; title: string }
  >();
  for (const card of Array.from(
    document.querySelectorAll(".plugin_goodsCardWrapper[data-sku]"),
  )) {
    const sku = card.getAttribute("data-sku")?.trim() ?? "";
    if (!/^\d+$/.test(sku)) continue;
    const chatSkus = new Set<string>();
    for (const anchor of Array.from(card.querySelectorAll("a[href]"))) {
      try {
        const url = new URL(anchor.getAttribute("href")!, location.href);
        if (url.hostname !== "chat.jd.com" || url.pathname !== "/index.action")
          continue;
        const pid = url.searchParams.get("pid")?.trim() ?? "";
        if (/^\d+$/.test(pid)) chatSkus.add(pid);
      } catch {
        continue;
      }
    }
    if (chatSkus.size && (chatSkus.size !== 1 || !chatSkus.has(sku))) continue;
    const titleNode = card.querySelector(
      "[class*='goods_title_container'] [title]",
    );
    const title = (
      titleNode?.getAttribute("title") ||
      titleNode?.textContent ||
      ""
    )
      .replace(/\s+/g, " ")
      .trim();
    if (title.length < 4 || !/[\p{L}]/u.test(title)) continue;
    candidates.set(sku, {
      sku,
      url: `https://item.jd.com/${sku}.html`,
      title: title.slice(0, 600),
    });
  }
  for (const anchor of Array.from(document.querySelectorAll("a[href]"))) {
    let url: URL;
    try {
      url = new URL(anchor.getAttribute("href")!, location.href);
    } catch {
      continue;
    }
    const match = url.pathname.match(/^\/(\d+)\.html$/);
    if (
      !match ||
      url.hostname !== "item.jd.com" ||
      !/^https?:$/.test(url.protocol)
    )
      continue;
    const title = (
      anchor.getAttribute("title") ||
      anchor.textContent ||
      anchor.querySelector("img")?.getAttribute("alt") ||
      ""
    )
      .replace(/\s+/g, " ")
      .trim();
    if (title.length < 4 || !/[\p{L}]/u.test(title)) continue;
    const existing = candidates.get(match[1]);
    if (!existing || title.length > existing.title.length)
      candidates.set(match[1], {
        sku: match[1],
        url: `https://item.jd.com/${match[1]}.html`,
        title: title.slice(0, 600),
      });
  }
  const noResults =
    /(?:抱歉，没有找到|暂无相关商品|未找到相关商品|没有搜索到相关商品)/u.test(
      document.body?.textContent ?? "",
    );
  if (!candidates.size && !noResults) {
    const visibleTitles = Array.from(document.querySelectorAll("[title]")).some(
      (node) => (node.getAttribute("title") ?? "").trim().length >= 4,
    );
    throw Error(
      visibleTitles
        ? "京东搜索页存在商品标题，但当前卡片布局尚未适配"
        : "京东搜索结果尚未加载完成且没有明确无结果文案",
    );
  }
  return {
    parserVersion: "jd-source-search/2",
    query: input.query,
    checkedAt: new Date().toISOString(),
    candidates: [...candidates.values()].slice(0, input.limit),
  };
}

/** One normal search page per call, using the existing account and persistent budget. */
export async function searchSourceCandidates(
  page: any,
  config: BrowserConfig,
  args: { database: string; query: string; limit?: number },
  health: (page: any) => Promise<unknown>,
) {
  const query = args.query?.trim(),
    limit = args.limit ?? 5;
  if (
    !query ||
    query.length > 200 ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 10
  )
    throw Error("搜索需要明确关键词，每次最多十个候选");
  if (args.database !== config.sourceDatabasePath)
    throw Error("搜索状态库与当前店铺不一致");
  const store = new Store(args.database);
  let unlock: (() => void) | undefined;
  try {
    unlock = store.lock("publisher");
    const traffic = new JdTraffic(store, config.shop);
    traffic.assertRunning();
    const cacheKey =
      "source-search:" + digest({ shop: config.shop, query, limit });
    const cached = store.meta(cacheKey);
    const age = Date.now() - Date.parse(cached?.checkedAt);
    if (
      age >= 0 &&
      age < 900000 &&
      cached.parserVersion === SOURCE_SEARCH_PARSER &&
      cached.query === query &&
      Array.isArray(cached.candidates)
    )
      return cached;
    return await traffic.exclusive("browser", async () => {
      await health(page);
      const url =
        "https://search.jd.com/Search?keyword=" +
        encodeURIComponent(query) +
        "&enc=utf-8";
      let samePage = false;
      try {
        const current = new URL(await page.url());
        samePage =
          current.hostname === "search.jd.com" &&
          current.pathname === "/Search" &&
          current.searchParams.get("keyword") === query;
      } catch {
        samePage = false;
      }
      if (!samePage) await traffic.navigate(url, () => page.goto(url));
      await health(page);
      await page.waitForFunction(
        () => document.readyState === "complete",
        undefined,
        { timeout: 20000 },
      );
      await health(page);
      try {
        await page.waitForFunction(sourceSearchReady, undefined, {
          timeout: 10000,
        });
      } catch {
        await health(page);
        // Produce the specific unsupported-layout/not-ready error and never cache it.
        await page.evaluate(readSourceSearchCards, { query, limit });
        throw Error("京东搜索结果等待超时");
      }
      const receipt = await page.evaluate(readSourceSearchCards, {
        query,
        limit,
      });
      store.setMeta(cacheKey, receipt);
      return receipt;
    });
  } catch (error: any) {
    if (["RATE_LIMITED", "AUTH_REQUIRED"].includes(error?.code)) {
      const traffic = new JdTraffic(store, config.shop);
      if (error.code === "RATE_LIMITED") traffic.risk(error.message);
      else traffic.pauseAccount("AUTH_REQUIRED", error.message);
    }
    throw error;
  } finally {
    unlock?.();
    store.close();
  }
}
