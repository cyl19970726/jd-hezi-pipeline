import test from "node:test";
import assert from "node:assert/strict";
import { example } from "../src/demo.js";
import { listingTitle } from "../src/listing-title.js";
test("template uses only current selected label, strips campaign badge, does not copy unrelated raw title claims", () => {
  const { product: p } = example();
  p.specs["京东销售规格"] = {
    ...p.title,
    value: "【1居推荐】贝贝健无香 3瓶1器",
  };
  const t = listingTitle(p, "示例甲品牌", "家居用品 > 蚊香液");
  assert.equal(t?.value, "示例甲品牌 蚊香液 贝贝健无香 3瓶1器");
  assert.equal(t?.sourceUrl, p.url);
});
test("foreign source or excessive copy requires text task", () => {
  const { product: p } = example();
  p.specs["京东销售规格"] = {
    ...p.title,
    sourceUrl: "https://item.jd.com/123.html",
    value: "2瓶",
  };
  assert.equal(listingTitle(p, "示例甲品牌", "蚊香液"), null);
});

test("clock titles retain the current-SKU model alongside category and selected variant", () => {
  const { product: p } = example();
  p.specs["京东销售规格"] = {
    ...p.title,
    value: "3443A 橡木色 52cm",
  };
  p.specs["型号"] = { ...p.title, value: "3443A" };
  const t = listingTitle(p, "示例丙品牌", "家居 > 挂钟");
  assert.equal(t?.value, "示例丙品牌 挂钟 3443A 橡木色 52cm");
  assert.match(t!.evidence, /当前SKU型号/);
});

test("clock title escapes regex punctuation when removing a duplicate leading model", () => {
  const { product: p } = example();
  p.specs["京东销售规格"] = {
    ...p.title,
    value: "C.1(plus)+ 黑色 30cm",
  };
  p.specs["型号"] = { ...p.title, value: "C.1(plus)+" };
  assert.equal(
    listingTitle(p, "示例丙品牌", "家居 > 挂钟")?.value,
    "示例丙品牌 挂钟 C.1(plus)+ 黑色 30cm",
  );
});

test("clock title is blocked when its model is not already sourced for this SKU", () => {
  const { product: p } = example();
  p.specs["京东销售规格"] = { ...p.title, value: "黑色 30cm" };
  p.specs["型号"] = {
    ...p.title,
    value: "3443A",
    sourceUrl: "https://item.jd.com/999999.html",
  };
  assert.equal(listingTitle(p, "示例丙品牌", "家居 > 挂钟"), null);
});
