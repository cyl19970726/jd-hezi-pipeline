import { Store } from "../store.js";
import { JdTraffic } from "../jd-traffic.js";
import { Discovery } from "../discovery.js";
import { readShopListing, readSkuVariants } from "./discovery-readers.js";
import type { BrowserConfig } from "./runtime.js";
import { JdCaptureStore } from "../jd-capture.js";
export async function discoverSource(
  page: any,
  config: BrowserConfig,
  args: { database: string; runId: string; limit?: number },
  health: (page: any) => Promise<any>,
) {
  const store = new Store(args.database),
    discovery = new Discovery(store);
  let release: (() => void) | undefined;
  let owned = false;
  try {
    release = store.lock("publisher");
    const traffic = new JdTraffic(store, config.shop);
    traffic.assertRunning();
    const limit = args.limit ?? 3;
    if (!Number.isInteger(limit) || limit < 1 || limit > 5)
      throw Error("每轮最多五个来源页面");
    const run = discovery.get(args.runId);
    if (run.source.shop !== config.shop) throw Error("来源任务店铺不符");
    owned = true;
    if (Date.now() - Date.parse(run.source.verifiedAt) > 86400000)
      throw Error("可信店铺证据已过期，先复核来源");
    const current = new Date().toISOString();
    if (
      !store.db
        .prepare(
          "SELECT 1 FROM catalog_grants WHERE shop=? AND brand_id=? AND status='approved' AND valid_from<=? AND valid_until>=?",
        )
        .get(config.shop, run.source.brandId, current, current)
    )
      throw Error("品牌当前没有有效授权类目，停止商品发现");
    for (let i = 0; i < limit; i++) {
      traffic.assertRunning();
      await health(page);
      const work = discovery.next(args.runId);
      if (!work) return discovery.finish(args.runId);
      const url =
        work.kind === "page"
          ? work.url
          : `https://item.jd.com/${work.sku}.html`;
      if ((await page.url()).split("#")[0] !== url) {
        await new JdTraffic(store, config.shop).navigate(url, () =>
          page.goto(url),
        );
      }
      await page.waitForFunction(
        () => document.readyState === "complete",
        undefined,
        { timeout: 20000 },
      );
      await health(page);
      if (work.kind === "page") {
        await page.waitForSelector(".jPageCurrent", {
          state: "visible",
          timeout: 20000,
        });
        await health(page);
        discovery.savePage(
          args.runId,
          url,
          await page.evaluate(readShopListing),
        );
      } else {
        await page.waitForFunction(
          () => {
            const shop = document
              .querySelector(".top-name")
              ?.closest("[data-shopid]")
              ?.getAttribute("data-shopid");
            return (
              !!shop &&
              !!document.querySelector('a[href*="exbrand_"]') &&
              !!document.querySelector(".specification-item-sku")
            );
          },
          undefined,
          { timeout: 15000 },
        );
        await health(page);
        let data;
        try {
          data = await page.evaluate(readSkuVariants);
        } catch (e) {
          if (
            /user.*control|inactive|unassigned|permission|ended.*task|用户|接管/i.test(
              String(e),
            )
          )
            throw e;
          discovery.blockSku(args.runId, work.sku, String(e));
          continue;
        }
        // Database/receipt errors propagate; they are not mislabeled as missing page fields.
        discovery.saveSku(args.runId, work.sku, data);
        new JdCaptureStore(store).observePage(
          { shop: config.shop, sku: work.sku, source: "discovery" },
          `https://item.jd.com/${work.sku}.html`,
          data.sku,
          data.capturedAt,
        );
      }
    }
    store.db
      .prepare("UPDATE discovery_runs SET error=NULL WHERE id=?")
      .run(args.runId);
    return discovery.progress(args.runId);
  } catch (error) {
    if (owned)
      store.db
        .prepare("UPDATE discovery_runs SET error=?,updated_at=? WHERE id=?")
        .run(
          error instanceof Error ? error.message : String(error),
          new Date().toISOString(),
          args.runId,
        );
    throw error;
  } finally {
    release?.();
    store.close();
  }
}
