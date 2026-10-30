import { test } from "node:test";
import assert from "node:assert/strict";
import { parseHTML } from "linkedom";
import { runInNewContext } from "node:vm";
import {
  readShopListing,
  readSkuVariants,
} from "../src/browser/discovery-readers.js";
function evaluate(fn: Function, document: any, url: string) {
  const u = new URL(url);
  return runInNewContext(`(${fn.toString()})()`, {
    document,
    location: { href: url, pathname: u.pathname },
    URL,
    Date,
    __name: (f: any) => f,
  });
}
test("store discovery excludes sales-ranking sidebar and banner links and requires an explicit disabled last page", () => {
  const { document } = parseHTML(
    '<html><body><input id="shop_id" value="store"><a href="https://item.jd.com/999.html">横幅</a><div class="jItem"><div class="jDesc"><a href="https://item.jd.com/888.html">销售排行推荐</a></div></div><p>共1件商品 1/1</p><div class="jSubObject"><div class="jDesc"><a href="https://item.jd.com/1.html" title="商品">商品</a></div></div><div class="jPage"><a class="jPageCurrent">1</a><span class="jPageDisable">下一页</span></div></body></html>',
  );
  const d = evaluate(
    readShopListing,
    document,
    "https://mall.jd.com/view_search-1-2-99-1-20-1.html",
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(d.rows)).map((r: any) => r.sku),
    ["1"],
  );
  assert.equal(d.lastPageConfirmed, true);
  document.querySelector(".jPageDisable")!.remove();
  assert.equal(
    evaluate(
      readShopListing,
      document,
      "https://mall.jd.com/view_search-1-2-99-1-20-1.html",
    ).lastPageConfirmed,
    false,
  );
});
test("visible specification text must agree with bound SKU props", () => {
  const { document } = parseHTML(
    '<html><body><div data-shopid="store"><div class="top-name">官方店</div></div><div class="top-self-support-new"></div><a href="https://list.jd.com/list.html?ev=exbrand_42">品牌</a><div class="specification-item-sku">2盒</div></body></html>',
  );
  const e: any = document.querySelector(".specification-item-sku");
  e.__reactFiberTest = {
    return: {
      memoizedProps: { data: { skuId: "2", skuList: ["2", "3"], text: "2盒" } },
    },
  };
  const d = evaluate(readSkuVariants, document, "https://item.jd.com/2.html");
  assert.deepEqual(
    Array.from(d.variants, (v: any) => v.sku),
    ["2", "3"],
  );
  e.__reactFiberTest.return.memoizedProps.data.text = "1盒";
  assert.throws(
    () => evaluate(readSkuVariants, document, "https://item.jd.com/2.html"),
    /可见文本不符/,
  );
});
