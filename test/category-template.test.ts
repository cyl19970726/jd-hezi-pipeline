import test from "node:test";
import assert from "node:assert/strict";
import { parseHTML } from "linkedom";
import { readCategoryTemplate } from "../src/browser/category-template.js";
function dom(rows: string) {
  const { document } = parseHTML(
    `<div class='ant-tabs-tabpane-active'><table>${rows}</table></div>`,
  );
  Object.assign(globalThis, {
    document,
    location: {
      href: "https://b.csgmall.com.cn/shop-view/#/shop-view/goods/publish?itemId=123",
    },
  });
}
const field = (id: string, name: string, required = "1", cid = "cat") =>
  `<tr attrid='${id}' attrname='${name}' optiontype='${required}' selecttype='3' cid='${cid}'><input value='另一个商品的具体值'></tr>`;
test("template reads required names and optional schema without inheriting product values", () => {
  dom(field("1", "规格") + field("2", "总净含量") + field("3", "型号", "2"));
  const r = readCategoryTemplate("cat");
  assert.deepEqual(r.specs, ["规格", "总净含量"]);
  assert.equal(r.fields.length, 3);
  assert.ok(!JSON.stringify(r).includes("另一个商品"));
});
test("mixed category or missing required metadata cannot become a template", () => {
  dom(field("1", "规格") + field("2", "型号", "2", "other"));
  assert.throws(() => readCategoryTemplate("cat"), /类目/);
  dom(field("1", "规格", ""));
  assert.throws(() => readCategoryTemplate("cat"), /必填/);
});
test("duplicate field names refuse ambiguous binding", () => {
  dom(field("1", "规格") + field("2", "规格"));
  assert.throws(() => readCategoryTemplate("cat"), /重复/);
});
