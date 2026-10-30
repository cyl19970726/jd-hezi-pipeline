import { test } from "node:test";
import assert from "node:assert/strict";
import {
  comparePreflightTemplate,
  preflightControls,
  preflightPackingName,
} from "../src/browser/preflight-schema.js";
import { parseHTML } from "linkedom";
const field = { id: "1", name: "产地", required: true, selectType: "1" };
test("preflight detects required and control type drift before any write", () => {
  assert.deepEqual(
    comparePreflightTemplate({ fields: [field] }, { fields: [field] }),
    [],
  );
  assert.match(
    comparePreflightTemplate(
      { fields: [field] },
      { fields: [{ ...field, selectType: "2" }] },
    ).join(),
    /结构已变化.*尚未支持/,
  );
  assert.match(
    comparePreflightTemplate({ fields: [field] }, { fields: [] }).join(),
    /缺少原规格/,
  );
  assert.match(
    comparePreflightTemplate({ specs: ["产地"] }, { fields: [field] }).join(),
    /缺少字段类型/,
  );
});

test("packaging-name preflight reads a positive maxlength without mutating the input", () => {
  const { document } = parseHTML(
    '<html><body><input placeholder="附件名称" maxlength="20" value="旧代表商品包装"></body></html>',
  );
  Object.assign(globalThis, { document });
  assert.deepEqual(preflightPackingName("说明书"), {
    maxLength: 20,
    issues: [],
    valueIssues: [],
  });
  assert.equal(
    (
      document.querySelector(
        'input[placeholder="附件名称"]',
      ) as HTMLInputElement
    ).value,
    "旧代表商品包装",
  );
  assert.match(
    preflightPackingName("超".repeat(21)).valueIssues.join(),
    /超过页面长度限制/,
  );
  document.querySelector("input")!.removeAttribute("maxlength");
  assert.match(preflightPackingName("说明书").issues.join(), /有效长度限制/);
});

test("template-only preflight validates maxlength without requiring a packing name", () => {
  const { document } = parseHTML(
    '<html><body><input placeholder="附件名称" maxlength="20" value="旧代表商品包装"></body></html>',
  );
  Object.assign(globalThis, { document });
  assert.deepEqual(preflightPackingName(), {
    maxLength: 20,
    issues: [],
    valueIssues: [],
  });
  assert.equal(
    (
      document.querySelector(
        'input[placeholder="附件名称"]',
      ) as HTMLInputElement
    ).value,
    "旧代表商品包装",
  );
});
test("unused optional unsupported controls do not block supported required fields", () => {
  const optional = { ...field, required: false, selectType: "2" };
  assert.deepEqual(
    comparePreflightTemplate({ fields: [optional] }, { fields: [optional] }),
    [],
  );
  assert.match(
    comparePreflightTemplate(
      { fields: [optional], usedSpecs: ["产地"] },
      { fields: [optional] },
    ).join(),
    /尚未支持/,
  );
});
test("preflight requires unique tabs and real control type, not just attribute labels", () => {
  const tabs = [
    "基本信息",
    "上传图片",
    "商品详情",
    "规格参数",
    "包装清单",
    "销售价格",
    "售后服务",
    "物流规则",
  ];
  const { document } = parseHTML(
    "<html><body>" +
      tabs.map((t) => `<div class="ant-tabs-tab-btn">${t}</div>`).join("") +
      '<div class="ant-tabs-tabpane-active"><table><tr attrname="产地" cid="1" selecttype="1"><td>产地</td><td><input></td></tr></table></div></body></html>',
  );
  Object.assign(globalThis, { document });
  assert.match(preflightControls().issues.join(), /控件与模板类型不符/);
  document.querySelector("td:last-child")!.innerHTML =
    '<div class="ant-select"><input></div>';
  assert.deepEqual(preflightControls().issues, []);
  document.body.appendChild(
    document.querySelector(".ant-tabs-tab-btn")!.cloneNode(true),
  );
  assert.match(preflightControls().issues.join(), /标签不能唯一定位/);
});
