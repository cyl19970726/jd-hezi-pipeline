import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveBrandModule } from "../src/browser/brand-client.js";

const current = `function q(e,t="message"){return api.get({url:"/platform/seller/supplier/brand/querySupplierBrandById",params:e})}
function d(e,t="message"){return api.get({url:"/platform-service/seller/supplier/brand/querySupplierBrandPageListByParam",params:e})}
export{d,q};`;

test("resolves current brand exports from the two exact GET endpoints", async () => {
  const result = await resolveBrandModule(
    [
      "https://b.csgmall.com.cn/shop-view/assets/brandRegulate-343286bd.js",
      "https://b.csgmall.com.cn/shop-view/assets/brand-815cced2.js",
    ],
    async (path) => (path.includes("815cced2") ? current : ""),
  );
  assert.deepEqual(result, {
    path: "https://b.csgmall.com.cn/shop-view/assets/brand-815cced2.js",
    exports: { detail: "q", list: "d" },
  });
});

test("rejects missing, conflicting and incomplete brand modules", async () => {
  await assert.rejects(
    resolveBrandModule(
      ["/shop-view/assets/brandRegulate-343286bd.js"],
      async () => current,
    ),
    /not found/,
  );
  await assert.rejects(
    resolveBrandModule(
      [
        "/shop-view/assets/brand-815cced2.js",
        "/shop-view/assets/brand-aabbccdd.js",
      ],
      async () => current,
    ),
    /Multiple brand modules/,
  );
  await assert.rejects(
    resolveBrandModule(["/shop-view/assets/brand-815cced2.js"], async () =>
      current.replace("querySupplierBrandById", "otherEndpoint"),
    ),
    /not found/,
  );
});

test("rejects a write method or missing public endpoint export", async () => {
  await assert.rejects(
    resolveBrandModule(["/shop-view/assets/brand-815cced2.js"], async () =>
      current.replace("api.get", "api.post"),
    ),
    /GET export missing/,
  );
  await assert.rejects(
    resolveBrandModule(["/shop-view/assets/brand-815cced2.js"], async () =>
      current.replace("export{d,q}", "export{d}"),
    ),
    /GET export missing/,
  );
});

test("skips unreadable and stale loaded brand chunks", async () => {
  const result = await resolveBrandModule(
    [
      "/shop-view/assets/brand-deadbeef.js",
      "/shop-view/assets/brand-815cced2.js",
    ],
    async (path) => {
      if (path.includes("deadbeef")) throw Error("gone");
      return current;
    },
  );
  assert.equal(result.path, "/shop-view/assets/brand-815cced2.js");
});

test("never reads a lookalike brand chunk from another origin", async () => {
  let reads = 0;
  await assert.rejects(
    resolveBrandModule(
      ["https://attacker.invalid/shop-view/assets/brand-815cced2.js"],
      async () => {
        reads++;
        return current;
      },
    ),
    /not found/,
  );
  assert.equal(reads, 0);
});

test("resolver is self-contained for browser evaluation", async () => {
  const revived = eval(
    `(${resolveBrandModule.toString()})`,
  ) as typeof resolveBrandModule;
  assert.deepEqual(
    await revived(["/shop-view/assets/brand-815cced2.js"], async () => current),
    {
      path: "/shop-view/assets/brand-815cced2.js",
      exports: { detail: "q", list: "d" },
    },
  );
});
