import { Store } from "../store.js";
import { BrandInventory } from "../brand-inventory.js";
import type { BrowserConfig } from "./runtime.js";
import { resolveBrandModule } from "./brand-client.js";
import { Traffic } from "../traffic.js";

const brandUrl =
  "https://b.csgmall.com.cn/shop-view/#/shop-view/brand/regulate";

/** Read one already identified supplier-brand grant; caller owns publisher lock. */
export async function readBrandGrant(
  page: any,
  config: BrowserConfig,
  args: { grantId: string; supplierId: string; brandId: string },
) {
  if (
    !/^\d+$/.test(args.grantId) ||
    !/^\d+$/.test(args.supplierId) ||
    !/^\d+$/.test(args.brandId)
  )
    throw Error("品牌授权读取身份必须是明确数字 ID");
  if ((await page.url()) !== brandUrl) await page.goto(brandUrl);
  await page.waitForFunction(
    () =>
      performance
        .getEntriesByType("resource")
        .some((entry) =>
          /\/shop-view\/assets\/brand-[a-f\d]+\.js(?:[?#].*)?$/i.test(
            entry.name,
          ),
        ),
    undefined,
    { timeout: 20000 },
  );
  const moduleResponse = await page.cdp("Runtime.evaluate", {
    expression: `(async()=>{const resolve=${resolveBrandModule.toString()},candidates=[...document.scripts].map(x=>x.src).filter(Boolean).concat(performance.getEntriesByType('resource').map(x=>x.name)),read=async path=>{const response=await fetch(path);if(!response.ok)throw Error('Brand module source request failed');if(!/javascript|ecmascript/i.test(response.headers.get('content-type')||''))throw Error('Brand module source is not JavaScript');return response.text()};return resolve(candidates,read)})()`,
    awaitPromise: true,
    returnByValue: true,
  });
  if (moduleResponse.exceptionDetails)
    throw Error("品牌模块预检失败：" + moduleResponse.exceptionDetails.text);
  const client = moduleResponse.result?.value as
    | { path?: unknown; exports?: { detail?: unknown; list?: unknown } }
    | undefined;
  if (
    !client ||
    typeof client.path !== "string" ||
    new URL(client.path, brandUrl).origin !== "https://b.csgmall.com.cn" ||
    !/\/shop-view\/assets\/brand-[a-f\d]+\.js$/i.test(
      new URL(client.path, brandUrl).pathname,
    ) ||
    typeof client.exports?.detail !== "string" ||
    typeof client.exports.list !== "string" ||
    client.exports.detail === client.exports.list
  )
    throw Error("品牌模块预检未返回唯一可核验客户端");
  const response = await page.cdp("Runtime.evaluate", {
    expression: `(async()=>{const m=await import(${JSON.stringify(client.path)}),read=m[${JSON.stringify(client.exports.detail)}];if(typeof read!=='function')throw Error('Verified brand reader export missing');return JSON.stringify(await read({supplierBrandId:${Number(args.grantId)},isUpdate:1}))})()`,
    awaitPromise: true,
    returnByValue: true,
  });
  if (response.exceptionDetails)
    throw Error("品牌详情读取失败：" + response.exceptionDetails.text);
  const detail = JSON.parse(response.result?.value ?? "null");
  if (
    !detail ||
    String(detail.id) !== args.grantId ||
    String(detail.supplierId) !== args.supplierId ||
    detail.supplierName !== config.shop ||
    String(detail.brandId) !== args.brandId
  )
    throw Error("品牌详情身份与请求不一致");
  return {
    detail,
    checkedAt: new Date().toISOString(),
    sourceUrl: brandUrl,
    grantId: args.grantId,
    supplierId: args.supplierId,
    shop: config.shop,
    brandId: args.brandId,
  };
}

/** Resume at durable page/detail boundaries; one bounded round, no background loop. */
export async function syncBrandInventory(
  page: any,
  config: BrowserConfig,
  args: {
    database: string;
    supplierId: string;
    limit?: number;
    newSnapshot?: boolean;
  },
) {
  const store = new Store(args.database),
    inventory = new BrandInventory(store),
    traffic = new Traffic(store, config.shop);
  let release: (() => void) | undefined;
  let id: string | undefined;
  try {
    release = store.lock("publisher");
    store.assertRunning(config.shop);
    const limit = args.limit ?? 10;
    if (!Number.isInteger(limit) || limit < 1 || limit > 10)
      throw Error("每轮最多十个品牌请求");
    if ((await page.url()) !== brandUrl)
      await traffic.run("brand-page", () => page.goto(brandUrl));
    await page.waitForFunction(
      () =>
        performance
          .getEntriesByType("resource")
          .some((entry) =>
            /\/shop-view\/assets\/brand-[a-f\d]+\.js(?:[?#].*)?$/i.test(
              entry.name,
            ),
          ),
      undefined,
      { timeout: 20000 },
    );
    const moduleResponse = await traffic.run<any>("brand-module", () =>
      page.cdp("Runtime.evaluate", {
        expression: `(async()=>{const resolve=${resolveBrandModule.toString()},candidates=[...document.scripts].map(x=>x.src).filter(Boolean).concat(performance.getEntriesByType('resource').map(x=>x.name)),read=async path=>{const response=await fetch(path);if(!response.ok)throw Error('Brand module source request failed');if(!/javascript|ecmascript/i.test(response.headers.get('content-type')||''))throw Error('Brand module source is not JavaScript');return response.text()};return resolve(candidates,read)})()`,
        awaitPromise: true,
        returnByValue: true,
      }),
    );
    if (moduleResponse.exceptionDetails)
      throw Error("品牌模块预检失败：" + moduleResponse.exceptionDetails.text);
    const client = moduleResponse.result?.value as
      | { path?: unknown; exports?: { detail?: unknown; list?: unknown } }
      | undefined;
    if (
      !client ||
      typeof client.path !== "string" ||
      new URL(client.path, brandUrl).origin !== "https://b.csgmall.com.cn" ||
      !/\/shop-view\/assets\/brand-[a-f\d]+\.js$/i.test(
        new URL(client.path, brandUrl).pathname,
      ) ||
      typeof client.exports?.detail !== "string" ||
      typeof client.exports.list !== "string" ||
      client.exports.detail === client.exports.list
    )
      throw Error("品牌模块预检未返回唯一可核验客户端");
    const last = inventory.latest(config.shop);
    id =
      last && !args.newSnapshot
        ? last.id
        : inventory.start(config.shop, args.supplierId);
    for (let i = 0; i < limit; i++) {
      store.assertRunning(config.shop);
      const run = inventory.get(id!);
      if (run.supplier_id !== args.supplierId || run.shop !== config.shop)
        throw Error("品牌批次供应商身份不符");
      if (run.status === "complete") break;
      const next = run.status === "listing" ? null : inventory.pending(id!)[0];
      if (run.status === "details" && !next) {
        inventory.complete(id!);
        break;
      }
      const request =
        run.status === "listing"
          ? { pageNum: run.next_page, pageSize: 10 }
          : { supplierBrandId: Number(next.grant_id), isUpdate: 1 };
      const operation =
        run.status === "listing" ? client.exports.list : client.exports.detail;
      // The exact export was resolved from the current page module's read-only GET endpoint.
      const response = await traffic.run<any>("brand-read", () =>
        page.cdp("Runtime.evaluate", {
          expression: `(async()=>{const m=await import(${JSON.stringify(client.path)}),read=m[${JSON.stringify(operation)}];if(typeof read!=='function')throw Error('Verified brand reader export missing');return JSON.stringify(await read(${JSON.stringify(request)}))})()`,
          awaitPromise: true,
          returnByValue: true,
        }),
      );
      if (response.exceptionDetails)
        throw Error("品牌读取失败：" + response.exceptionDetails.text);
      const data = JSON.parse(response.result?.value ?? "null");
      if (!data) throw Error("品牌接口未返回可核验数据");
      if (run.status === "listing") inventory.savePage(id!, data);
      else inventory.saveDetail(id!, next.grant_id, data);
    }
    return inventory.progress(id!);
  } catch (e) {
    if (id) inventory.fail(id, String(e));
    throw e;
  } finally {
    release?.();
    store.close();
  }
}
