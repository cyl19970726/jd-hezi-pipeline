import { Store } from "../store.js";
import { MarketScan, readMarketPage } from "../market-scan.js";
import type { BrowserConfig } from "./runtime.js";
import { ensureRequestHook } from "./request-hook.js";
import { Traffic } from "../traffic.js";
/** Small resumable rounds; the caller owns scheduling and never runs two publisher operations. */
export async function scanMarket(
  page: any,
  config: BrowserConfig,
  args: { database: string; runId: string; limit?: number },
  health: (page: any) => Promise<unknown>,
) {
  const store = new Store(args.database),
    scan = new MarketScan(store),
    traffic = new Traffic(store, config.shop);
  let release: (() => void) | undefined;
  try {
    release = store.lock("publisher");
    store.assertRunning(config.shop);
    const limit = args.limit ?? 3;
    if (!Number.isInteger(limit) || limit < 1 || limit > 5)
      throw Error("每轮最多五个商城页面");
    let run = scan.get(args.runId);
    if (run.shop !== config.shop) throw Error("商城搜索店铺不符");
    if (run.status !== "running")
      return scan.list(config.shop).find((x) => x.id === args.runId);
    await health(page);
    await ensureRequestHook(page);
    const url =
      "https://b.csgmall.com.cn/mall-view/product/search?keyword=" +
      encodeURIComponent(String(run.query));
    if ((await page.url()) !== url) {
      await traffic.run("market-page", async () => {
        await page.goto(url);
        await page.waitForFunction(
          () => document.querySelector(".layui-laypage-count"),
          undefined,
          { timeout: 20000 },
        );
        await health(page);
      });
    }
    for (let i = 0; i < limit; i++) {
      store.assertRunning(config.shop);
      run = scan.get(args.runId);
      if (run.status !== "running") break;
      let p = await page.evaluate(readMarketPage);
      if (p.page !== run.next_page) {
        const before = p.rows
          .flatMap((r: any) => r.skus.map((s: any) => s.skuId))
          .join(",");
        await traffic.run("market-page", async () => {
          if (p.page === Number(run.next_page) - 1)
            await page.click(".layui-laypage-next");
          else {
            await page.fill(".layui-laypage-skip input", String(run.next_page));
            await page.click(".layui-laypage-btn");
          }
          await page.waitForFunction(
            ({ next, before }: any) =>
              document
                .querySelector(".layui-laypage-curr")
                ?.textContent?.trim() === String(next) &&
              [
                ...document.querySelectorAll<HTMLElement>(
                  ".goods-item .thumb-list li",
                ),
              ]
                .map((x) => x.dataset.skuid)
                .join(",") !== before,
            { next: run.next_page, before },
            { timeout: 20000 },
          );
          await health(page);
        });
        p = await page.evaluate(readMarketPage);
      }
      scan.save(args.runId, p);
    }
    return scan.list(config.shop).find((x) => x.id === args.runId);
  } finally {
    release?.();
    store.close();
  }
}
