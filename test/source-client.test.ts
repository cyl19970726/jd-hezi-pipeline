import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveSourceModule } from "../src/browser/source-client.js";

const current = `function pg(e,t="message"){return api.post({params:e,url:"/item/shop/shopItem/queryShopItemListOnlyItemInfo"})}
function _g(e,t="message"){return api.get({params:e,url:"/item/shop/shopItem/querySaleItemListOnlyPageSkuInfo"})}
export{_g as d2,pg as d3};`;

test("resolves current inventory readers from exact endpoint semantics", async () => {
  const result = await resolveSourceModule(
    [
      "https://b.csgmall.com.cn/shop-view/assets/vandor-7623e3a0.js",
      "https://b.csgmall.com.cn/shop-view/assets/index-b3685015.js",
    ],
    async (path) => (path.includes("b3685015") ? current : ""),
  );
  assert.deepEqual(result, {
    path: "https://b.csgmall.com.cn/shop-view/assets/index-b3685015.js",
    exports: { list: "d3", links: "d2" },
  });
});

test("source resolver fails closed on incomplete, ambiguous and missing exports", async () => {
  await assert.rejects(
    resolveSourceModule(["/shop-view/assets/index-one1.js"], async () =>
      current.replace("querySaleItemListOnlyPageSkuInfo", "other"),
    ),
    /not found/,
  );
  await assert.rejects(
    resolveSourceModule(
      ["/shop-view/assets/index-one1.js", "/shop-view/assets/index-two2.js"],
      async () => current,
    ),
    /Multiple source modules/,
  );
  await assert.rejects(
    resolveSourceModule(["/shop-view/assets/index-one1.js"], async () =>
      current.replace(",pg as d3", ""),
    ),
    /export missing/,
  );
});
