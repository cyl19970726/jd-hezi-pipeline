import type { BrowserConfig } from "./runtime.js";
/** The same Hezi tab serves the public market and supplier console; restore the console only when needed. */
export async function ensureSupplierWorkspace(
  page: any,
  config: BrowserConfig,
  shop: string,
  health: (page: any, shop?: string) => Promise<unknown>,
) {
  const url = new URL(await page.url());
  if (
    url.origin === "https://b.csgmall.com.cn" &&
    url.pathname.startsWith("/mall-view/")
  ) {
    await health(page);
    await page.goto(config.listUrl);
    await page.waitForFunction(
      (name: string) => document.body.innerText.includes(name),
      shop,
      { timeout: 20000 },
    );
  }
  await health(page, shop);
}

const BRAND_REGULATE_URL =
  "https://b.csgmall.com.cn/shop-view/#/shop-view/brand/regulate";

/** Enter a clean new-product page only from known read-only pages or that target itself. */
export async function prepareNewTemplateWorkspace(
  page: any,
  config: BrowserConfig,
  shop: string,
  health: (page: any, shop?: string) => Promise<unknown>,
) {
  const current = new URL(await page.url());
  const publicMarket =
    current.origin === "https://b.csgmall.com.cn" &&
    current.pathname.startsWith("/mall-view/");
  const knownSupplierPage =
    current.href === config.listUrl ||
    current.href === BRAND_REGULATE_URL ||
    current.href === config.newUrl;
  if (!publicMarket && !knownSupplierPage)
    throw Object.assign(
      new Error("当前页面可能正在编辑商品，拒绝为模板读取离开页面"),
      { code: "NEEDS_INPUT" },
    );

  await health(page);
  if (current.href !== config.newUrl) await page.goto(config.newUrl);
  await page.reload();
  await page.waitForSelector("#form_item_categoryName", {
    state: "visible",
    timeout: 15000,
  });
  await health(page, shop);
}
