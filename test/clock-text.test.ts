import test from "node:test";
import assert from "node:assert/strict";
import {
  CLOCK_TEXT_RULES_VERSION,
  deriveClockTitleField,
} from "../src/clock-text.js";
import { example } from "../src/demo.js";
import { normalizeProduct } from "../src/normalization.js";

test("derives the one explicit clock kind and contextual model tokens", () => {
  const examples = [
    ["示例丙品牌挂钟时钟 c2855 黑色26cm直径", "c2855", "挂钟"],
    ["示例丙品牌时钟日历挂钟 C3219-2", "C3219-2", "挂钟"],
    ["示例丙品牌挂钟时钟 7026", "7026", "挂钟"],
    ["示例丙品牌挂钟钟表挂墙D6205-2", "D6205-2", "挂钟"],
    ["示例丙品牌挂钟挂墙 C6219B", "C6219B", "挂钟"],
    ["示例丙品牌挂钟时钟1540J-2", "1540J-2", "挂钟"],
    ["示例丙品牌挂钟时钟 3128Y", "3128Y", "挂钟"],
    ["示例丙品牌挂钟挂墙C2985", "C2985", "挂钟"],
    ["示例丙品牌挂钟挂墙 1540-2", "1540-2", "挂钟"],
    ["示例丙品牌闹钟 型号：A7026B", "A7026B", "闹钟"],
  ] as const;

  for (const [title, model, kind] of examples) {
    assert.equal(
      deriveClockTitleField(title, "999999999", "类型")?.value,
      kind,
    );
    assert.equal(
      deriveClockTitleField(title, "999999999", "类别")?.value,
      kind,
    );
    assert.equal(
      deriveClockTitleField(title, "999999999", "型号")?.value,
      model,
    );
  }
});

test("leaves ambiguous, dimensional, yearly, SKU and marketing numbers unresolved", () => {
  const cases = [
    ["示例丙品牌挂钟闹钟时钟 C2855", "999999999"],
    ["示例丙品牌挂钟 35cm 2026款", "999999999"],
    ["示例丙品牌挂钟时钟 123456789012", "123456789012"],
    ["示例丙品牌挂钟热卖第618名", "999999999"],
    ["示例丙品牌挂钟时钟 C2855 挂墙 C2985", "999999999"],
  ] as const;
  for (const [title, sku] of cases)
    assert.equal(deriveClockTitleField(title, sku, "型号"), null, title);
});

test("normalization adds title-derived clock facts before targeted collection", () => {
  const { product } = example();
  product.sku = "1194228";
  product.url = "https://item.jd.com/1194228.html";
  product.title = {
    value: "示例丙品牌挂钟时钟 c2855 黑色26cm直径",
    sourceUrl: product.url,
    capturedAt: product.capturedAt,
    evidence: "京东当前SKU标题",
  };
  product.specs = {};

  const result = normalizeProduct(product, ["类型", "型号"]);
  assert.deepEqual(result.blockingReasons, []);
  assert.equal(result.product.specs["类型"].value, "挂钟");
  assert.equal(result.product.specs["型号"].value, "c2855");
  assert.match(result.product.specs["型号"].evidence, /商品标题“.*c2855/);
  assert.match(
    result.product.specs["型号"].evidence,
    new RegExp(CLOCK_TEXT_RULES_VERSION),
  );
});

test("normalization preserves explicit specs and rejects a foreign title fact", () => {
  const { product } = example();
  product.title.value = "示例丙品牌挂钟时钟 C2855";
  product.specs["型号"] = {
    ...product.title,
    value: "SOURCE-MODEL",
    evidence: "京东规格参数：型号",
  };
  let result = normalizeProduct(product, ["型号"]);
  assert.equal(result.product.specs["型号"].value, "SOURCE-MODEL");
  assert.equal(result.resolutions["型号"].status, "resolved");

  delete product.specs["型号"];
  product.title.sourceUrl = "https://item.jd.com/999999.html";
  result = normalizeProduct(product, ["型号"]);
  assert.equal(result.product.specs["型号"], undefined);
  assert.equal(result.resolutions["型号"].status, "not_observed");
});
