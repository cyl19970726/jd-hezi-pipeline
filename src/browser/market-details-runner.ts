import { Store } from "../store.js";
import { MarketScan, marketItems } from "../market-scan.js";
import { MarketDetails } from "../market-details.js";
import type { BrowserConfig } from "./runtime.js";
import { ensureRequestHook } from "./request-hook.js";
import { Traffic } from "../traffic.js";
export async function readMarketDetails(
  page: any,
  config: BrowserConfig,
  args: { database: string; runId: string; limit?: number },
  health: (p: any) => Promise<unknown>,
) {
  const store = new Store(args.database),
    market = new MarketScan(store),
    details = new MarketDetails(store),
    traffic = new Traffic(store, config.shop);
  let release: (() => void) | undefined;
  try {
    release = store.lock("publisher");
    store.assertRunning(config.shop);
    const limit = args.limit ?? 3;
    if (!Number.isInteger(limit) || limit < 1 || limit > 3)
      throw Error("每轮最多三个竞品详情");
    const run = market.get(args.runId);
    if (run.shop !== config.shop || run.status !== "complete")
      throw Error("需要本店已完成覆盖的商城查询");
    const pages = market.pages(args.runId);
    if (pages.some((p) => Date.now() - Date.parse(p.checkedAt) > 3600000))
      throw Error("商城查询已过期，先重新核验搜索范围");
    const rows = marketItems(pages);
    const cached = (r: (typeof rows)[number]) => {
      const value = details.fresh(config.shop, r.itemId);
      if (
        value &&
        (value.shopId !== r.shopId ||
          r.skus.some((s) => !value.skus.some((d) => d.id === s.skuId)))
      )
        throw Error("缓存详情与搜索销售SKU不一致，需重新核对搜索");
      return value;
    };
    const pending = rows.filter((r) => !cached(r));
    const results = [];
    if (pending.length) {
      await health(page);
      await ensureRequestHook(page);
      const url = String(pages[0].url);
      if (!(await page.url()).includes("/mall-view/")) {
        await traffic.run("market-page", async () => {
          await page.goto(url);
          await page.waitForFunction(
            () => !!document.querySelector(".layui-laypage-count"),
            undefined,
            { timeout: 20000 },
          );
          await health(page);
        });
      }
      for (const row of pending.slice(0, limit)) {
        store.assertRunning(config.shop);
        await health(page);
        const response = await traffic.run<any>("market-detail", () =>
          page.cdp("Runtime.evaluate", {
            expression: `new Promise(resolve=>layui.admin.req(layui.config.item_server+'/mall/search/queryNormalItemDetails',${JSON.stringify({ platformId: 20, itemId: row.itemId, areaId: -1, accountType: 2 })},res=>resolve(res),'GET'))`,
            awaitPromise: true,
            returnByValue: true,
          }),
        );
        if (response.exceptionDetails || !response.result?.value)
          throw Error("商城详情未返回有效回执");
        await health(page);
        const id = details.save(
          config.shop,
          row.itemId,
          row.shopId,
          response.result.value,
          new Date().toISOString(),
          row.skus.map((s) => s.skuId),
        );
        const record = details.get(id);
        results.push(record);
      }
    }
    const remaining = rows.filter((r) => !cached(r)).length;
    return {
      runId: args.runId,
      totalItems: rows.length,
      freshDetails: rows.length - remaining,
      remaining,
      networkDetails: results.length,
      results,
    };
  } finally {
    release?.();
    store.close();
  }
}
