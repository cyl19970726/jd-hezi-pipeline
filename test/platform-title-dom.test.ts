import test from "node:test";
import assert from "node:assert/strict";
import { parseHTML } from "linkedom";
import {
  readTitleControl,
  readPlatformTitleRule,
} from "../src/browser/platform-title.js";

function dom(html: string) {
  const { window } = parseHTML(html);
  Object.assign(globalThis, { document: window.document });
  window.HTMLElement.prototype.getBoundingClientRect = () =>
    ({ width: 100 }) as DOMRect;
  for (const input of window.document.querySelectorAll("input")) {
    Object.defineProperty(input, "disabled", {
      value: input.hasAttribute("disabled"),
    });
    Object.defineProperty(input, "checked", {
      value: input.hasAttribute("checked"),
    });
  }
}
const notice =
  "该类目下的商品将根据选择的品牌、类目、属性、商品单位组成商品名字";
test("a disabled title is accepted only with an explicit platform naming notice", () => {
  dom(
    `<div class="ant-form-item"><input id="form_item_itemName" disabled value="示例标题"><span>${notice}</span></div>`,
  );
  assert.deepEqual(readTitleControl(), {
    mode: "platform-generated",
    value: "示例标题",
  });
  dom(
    '<div class="ant-form-item"><input id="form_item_itemName" disabled></div>',
  );
  assert.throws(readTitleControl, /缺少明确/);
  dom(
    `<div class="ant-form-item"><input id="form_item_itemName"><span>${notice}</span></div>`,
  );
  assert.throws(readTitleControl, /不一致/);
  dom(
    '<div class="ant-form-item"><input id="form_item_itemName" value="手写标题"></div>',
  );
  assert.equal(readTitleControl().mode, "source");
});
const row = (name: string, selected: boolean) =>
  `<tr><td><input type="radio" value="1" ${selected ? "checked" : ""}><input type="radio" value="0" ${selected ? "" : "checked"}></td><td>${name}</td><td><input value="不应继承的商品值"></td></tr>`;
test("naming template preserves checked field order without copying values or changing choices", () => {
  dom(
    `<div class="ant-modal">选择组成商品名称的属性<table>${row("品牌", true)}${row("类目名称", true)}${row("尺寸规格", true)}${row("规格", true)}${row("计价单位", true)}${row("型号", false)}</table></div>`,
  );
  assert.deepEqual(readPlatformTitleRule(), {
    mode: "platform-generated",
    parts: ["品牌", "类目名称", "尺寸规格", "规格", "计价单位"],
    separator: " ",
  });
  dom(
    `<div class="ant-modal">选择组成商品名称的属性<table>${row("品牌", true)}${row("类目名称", true)}</table></div>`,
  );
  assert.throws(readPlatformTitleRule, /缺少固定/);
});
