import { test } from "node:test";
import assert from "node:assert/strict";
import { observeNewSave, selectSiteApiClient } from "../src/browser/receipt.js";

test("selects the unique exported client with both read and write methods", () => {
  const client = { get() {}, post() {} };
  assert.equal(
    selectSiteApiClient({ d2: () => {}, am: client, other: { get() {} } }),
    client,
  );
  assert.equal(selectSiteApiClient({ am: client, alias: client }), client);
});

test("save observer client selection fails closed on missing or multiple clients", () => {
  assert.throws(
    () => selectSiteApiClient({ readOnly: { get() {} } }),
    /not unique/,
  );
  assert.throws(
    () =>
      selectSiteApiClient({
        first: { get() {}, post() {} },
        second: { get() {}, post() {} },
      }),
    /not unique/,
  );
});

function observerPage(sku: string) {
  const input = { value: `https://item.jd.com/${sku}.html` };
  Object.assign(globalThis, {
    window: {},
    location: {
      hash: "#/shop-view/goods/publish?new=1",
    },
    document: {
      querySelector(selector: string) {
        return selector === "#form_item_linkList_0_goodsLink" ? input : null;
      },
    },
  });
}

test("save observer preserves the numeric ID behavior and a safe response diagnostic", async () => {
  const sku = "100000000001";
  observerPage(sku);
  const client = {
    get() {},
    async post() {
      return 990916000001;
    },
  };
  await observeNewSave(
    sku,
    "/shop-view/assets/index-test.js",
    () => client,
    client,
  );
  assert.equal(
    await client.post({
      url: "/item/shop/itemTmplPublish/saveItemPublish",
      params: {},
    }),
    990916000001,
  );
  assert.deepEqual((globalThis as any).window.__heziSaveReceipt, {
    itemId: "990916000001",
    sku,
  });
  assert.deepEqual((globalThis as any).window.__heziSaveDiagnostic, {
    outcome: "resolved",
    responseType: "number",
    response: 990916000001,
    itemIdCaptured: true,
  });
});

test("save observer diagnoses a non-numeric success without guessing an ID", async () => {
  const sku = "100000000002";
  observerPage(sku);
  const client = {
    get() {},
    async post() {
      return { data: { id: "990916000002" }, token: "private" };
    },
  };
  await observeNewSave(
    sku,
    "/shop-view/assets/index-test.js",
    () => client,
    client,
  );
  await assert.rejects(
    client.post({
      url: "/item/shop/itemTmplPublish/saveItemPublish",
      params: {},
    }),
    /not an item ID/,
  );
  assert.equal((globalThis as any).window.__heziSaveReceipt, null);
  assert.deepEqual((globalThis as any).window.__heziSaveDiagnostic, {
    outcome: "resolved",
    responseType: "object",
    response: { data: { id: "990916000002" }, token: "[redacted]" },
    itemIdCaptured: false,
  });
});

test("save observer preserves a rejected business message without credentials", async () => {
  const sku = "100000000003";
  observerPage(sku);
  const rejection = Object.assign(new Error("包装清单不符合要求"), {
    code: "BUSINESS_REJECTED",
    data: { reason: "包装名称过长", authorization: "private" },
    token: "private",
  });
  const client = {
    get() {},
    async post() {
      throw rejection;
    },
  };
  await observeNewSave(
    sku,
    "/shop-view/assets/index-test.js",
    () => client,
    client,
  );
  await assert.rejects(
    client.post({
      url: "/item/shop/itemTmplPublish/saveItemPublish",
      params: {},
    }),
    /包装清单/,
  );
  assert.equal((globalThis as any).window.__heziSaveReceipt, null);
  assert.deepEqual((globalThis as any).window.__heziSaveDiagnostic, {
    outcome: "rejected",
    error: {
      name: "Error",
      message: "包装清单不符合要求",
      code: "BUSINESS_REJECTED",
      data: { reason: "包装名称过长", authorization: "[redacted]" },
    },
  });
});
