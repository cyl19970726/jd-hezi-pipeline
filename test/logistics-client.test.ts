import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveLogisticsModule } from "../src/browser/logistics-client.js";

const current = `function y(e,r="message"){return api.get({url:"/item/shop/area/config/queryAreaConfigAndBrandById",params:e})}
function b(e,r="message"){return api.get({url:"/item/seller/deliveryAddress/queryConfigByItemId",params:e})}
function A(e,r="message"){return api.get({url:"/item/seller/shops/freight/queryTemplateSkuList",params:e})}
function L(e,r="message"){return api.post({url:"/item/shop/itemTmplPublish/queryItemInfo",params:e})}
export{L as b,y as c,b as d,A as e};`;

test("resolves current logistics exports from exact endpoint semantics", async () => {
  const result = await resolveLogisticsModule(
    [
      "https://b.csgmall.com.cn/shop-view/assets/index-b3685015.js",
      "https://b.csgmall.com.cn/shop-view/assets/manage-3bcf1dfa.js",
    ],
    async (path) => (path.includes("3bcf1dfa") ? current : ""),
  );
  assert.deepEqual(result, {
    path: "https://b.csgmall.com.cn/shop-view/assets/manage-3bcf1dfa.js",
    exports: { item: "b", area: "c", templates: "e", addresses: "d" },
  });
});

test("fails closed for incomplete, ambiguous or unexported endpoint clients", async () => {
  await assert.rejects(
    resolveLogisticsModule(["/shop-view/assets/manage-one1.js"], async () =>
      current.replace("queryConfigByItemId", "otherEndpoint"),
    ),
    /not found/,
  );
  await assert.rejects(
    resolveLogisticsModule(
      ["/shop-view/assets/manage-one1.js", "/shop-view/assets/manage-two2.js"],
      async () => current,
    ),
    /Multiple logistics modules/,
  );
  await assert.rejects(
    resolveLogisticsModule(["/shop-view/assets/manage-one1.js"], async () =>
      current.replace(",A as e", ""),
    ),
    /export missing/,
  );
});

test("skips stale HTML fallback and unreadable loaded candidates", async () => {
  const result = await resolveLogisticsModule(
    [
      "/shop-view/assets/manage-old00000.js",
      "/shop-view/assets/manage-broken000.js",
      "/shop-view/assets/manage-3bcf1dfa.js",
    ],
    async (path) => {
      if (path.includes("old00000")) return "<!doctype html><html></html>";
      if (path.includes("broken000")) throw Error("gone");
      return current;
    },
  );
  assert.equal(result.path, "/shop-view/assets/manage-3bcf1dfa.js");
});
