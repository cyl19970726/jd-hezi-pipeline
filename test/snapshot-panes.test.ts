import { test } from "node:test";
import assert from "node:assert/strict";
import { parseHTML } from "linkedom";
import { readSnapshotPanes } from "../src/browser/snapshot-panes.js";

const names = [
  "基本信息",
  "上传图片",
  "商品详情",
  "规格参数",
  "销售价格",
  "包装清单",
  "售后服务",
  "物流规则",
];

function editor(
  options: { omit?: string; duplicate?: string; outerTabs?: boolean } = {},
) {
  const selected = names.filter((name) => name !== options.omit);
  const tabs = selected
    .flatMap((name) => (name === options.duplicate ? [name, name] : [name]))
    .map(
      (name) =>
        `<div class="ant-tabs-tab"><button class="ant-tabs-tab-btn">${name}</button></div>`,
    )
    .join("");
  const panes = selected
    .map((name) => {
      const body =
        name === "基本信息"
          ? '<div class="ant-form-item"><label>商品类目</label><input id="form_item_categoryName" value="工具"></div><div class="ant-form-item"><label>品牌</label><span class="ant-select-selection-item">品牌甲</span></div><div class="ant-form-item"><label>单位</label><input value="件"></div><input value="https://item.jd.com/123.html">'
          : name === "上传图片"
            ? '<input type="file"><div class="img-upload-box"><img src="https://img/main.jpg"></div>'
            : name === "商品详情"
              ? '<iframe class="tox-edit-area__iframe" id="tiny-editor"></iframe>'
              : name === "规格参数"
                ? "<table><tr><td>规格</td><td><input></td></tr></table>"
                : name === "包装清单"
                  ? '<input placeholder="附件名称" value="说明书"><input placeholder="附件数量，请输入1-999的整数" value="2">'
                  : name === "物流规则"
                    ? '<span class="ant-select-selection-item">默认模板</span>'
                    : "";
      return `<section class="ant-tabs-tabpane" data-name="${name}">${body}</section>`;
    })
    .join("");
  const inner = `<div class="ant-tabs" data-tabs="product"><div class="ant-tabs-nav">${tabs}</div><div class="ant-tabs-content">${panes}</div></div>`;
  const html = options.outerTabs
    ? `<div class="ant-tabs" data-tabs="workspace"><div class="ant-tabs-nav"><div class="ant-tabs-tab ant-tabs-tab-active"><button class="ant-tabs-tab-btn">商品信息编辑</button></div></div><div class="ant-tabs-content"><section class="ant-tabs-tabpane ant-tabs-tabpane-active" data-outer="editor">${inner}</section></div></div>`
    : inner;
  const { document, window } = parseHTML(`<body>${html}</body>`);
  Object.assign(globalThis, {
    document,
    HTMLElement: window.HTMLElement,
    HTMLInputElement: window.HTMLInputElement,
    HTMLTextAreaElement: window.HTMLTextAreaElement,
    Event: window.Event,
    FocusEvent: window.Event,
  });
  const order: string[] = [];
  for (const tab of document.querySelectorAll(".ant-tabs-tab-btn")) {
    if (tab.textContent === "商品信息编辑") continue;
    tab.addEventListener("click", () => {
      const name = tab.textContent!;
      order.push(name);
      const root = tab.closest('[data-tabs="product"]')!;
      for (const item of root.querySelectorAll(".ant-tabs-tab-btn"))
        item.parentElement?.classList.remove("ant-tabs-tab-active");
      tab.parentElement!.classList.add("ant-tabs-tab-active");
      for (const pane of root.querySelectorAll(".ant-tabs-tabpane"))
        pane.classList.toggle(
          "ant-tabs-tabpane-active",
          pane.getAttribute("data-name") === name,
        );
    });
  }
  const main = document.querySelector(".img-upload-box img");
  if (main) {
    Object.defineProperty(main, "complete", { value: true });
    Object.defineProperty(main, "naturalWidth", { value: 0 });
  }
  const frame = document.querySelector("iframe");
  if (frame) {
    const detail = parseHTML(
      '<body><img src="https://img/detail.jpg"></body>',
    ).document;
    const image = detail.querySelector("img")!;
    Object.defineProperty(image, "complete", { value: true });
    Object.defineProperty(image, "naturalWidth", { value: 40 });
    Object.defineProperty(frame, "contentDocument", { value: detail });
  }
  return { document, order };
}

test("reads all eight panes in order and covers persisted snapshot data", async () => {
  const { document, order } = editor();
  const seen: string[] = [];
  const result = await readSnapshotPanes(
    () => {
      const name = document
        .querySelector(".ant-tabs-tabpane-active")!
        .getAttribute("data-name")!;
      seen.push(name);
      return {
        values: {},
        specs: name === "规格参数" ? { 电压: "220V" } : {},
        requiredMissing: name === "规格参数" ? ["功率"] : [],
        fields: [],
        files: [],
      };
    },
    async ({ keys }) =>
      Object.fromEntries(keys.map((key) => [key, `value:${key}`])),
    () => ({ after_refund: "7", after_exchange: "8", after_warranty: "9" }),
  );
  assert.deepEqual(order, names);
  assert.deepEqual(seen, names);
  assert.equal(result.fields.title, "value:title");
  assert.equal(result.fields.inventory, "value:inventory");
  assert.equal(result.fields.category, "工具");
  assert.equal(result.fields.brand, "品牌甲");
  assert.equal(result.fields.unit, "件");
  assert.equal(result.fields.sourceUrl, "https://item.jd.com/123.html");
  assert.equal(result.fields.packingName, "说明书");
  assert.equal(result.fields.packingCount, "2");
  assert.equal(result.fields.after_warranty, "9");
  assert.equal(result.fields.shippingTemplate, "默认模板");
  assert.deepEqual(result.specs, { 电压: "220V" });
  assert.deepEqual(result.requiredMissing, ["功率"]);
  assert.deepEqual(result.mainImages, [
    { url: "https://img/main.jpg", loaded: false },
  ]);
  assert.deepEqual(result.detailImages, [
    { url: "https://img/detail.jpg", loaded: true },
  ]);
  assert.deepEqual(result.readbackMetrics?.paneOrder, names);
  assert.deepEqual(Object.keys(result.readbackMetrics!.paneDurationsMs), names);
});

test("reports missing and duplicate tabs before reading ambiguous DOM", async () => {
  for (const options of [{ omit: "规格参数" }, { duplicate: "销售价格" }]) {
    editor(options);
    await assert.rejects(
      readSnapshotPanes(
        () => ({
          values: {},
          specs: {},
          requiredMissing: [],
          fields: [],
          files: [],
        }),
        async () => ({}),
        () => ({}),
      ),
      /Snapshot DOM error: tab (规格参数|销售价格) expected once in product tabs, found (0|2)/,
    );
  }
});

test("bounds a pane that never becomes ready", async () => {
  const { document } = editor();
  document
    .querySelector('[data-name="规格参数"]')!
    .querySelector("input")!
    .remove();
  const realNow = Date.now;
  let now = 0;
  Date.now = () => (now += 10_001);
  try {
    await assert.rejects(
      readSnapshotPanes(
        () => ({
          values: {},
          specs: {},
          requiredMissing: [],
          fields: [],
          files: [],
        }),
        async () => ({}),
        () => ({}),
      ),
      /Snapshot timeout after 12000ms: tab 规格参数 did not become ready/,
    );
  } finally {
    Date.now = realNow;
  }
});

test("scopes active tabs and panes to the nested product editor", async () => {
  const { document, order } = editor({ outerTabs: true });
  const result = await readSnapshotPanes(
    () => ({
      values: {},
      specs: {},
      requiredMissing: [],
      fields: [],
      files: [],
    }),
    async ({ keys }) => Object.fromEntries(keys.map((key) => [key, key])),
    () => ({ after_refund: "7" }),
  );
  assert.deepEqual(order, names);
  assert.equal(
    document.querySelectorAll(".ant-tabs-tab-active").length,
    2,
    "outer and inner active tabs coexist",
  );
  assert.equal(
    document.querySelectorAll(".ant-tabs-tabpane-active").length,
    2,
    "outer and inner active panes coexist",
  );
  assert.equal(result.fields.shippingTemplate, "默认模板");
});

test("propagates helper failures", async () => {
  editor();
  await assert.rejects(
    readSnapshotPanes(
      () => {
        throw Error("reader broke");
      },
      async () => ({}),
      () => ({}),
    ),
    /reader broke/,
  );
});

test("is self-contained when serialized with its helper functions", () => {
  assert.doesNotThrow(
    () =>
      new Function(
        `return (${readSnapshotPanes.toString()})(function(){},async function(){},function(){})`,
      ),
  );
});
