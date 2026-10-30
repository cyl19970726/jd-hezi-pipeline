import test from "node:test";
import assert from "node:assert/strict";
import { example } from "../src/demo.js";
import { validate } from "../src/model.js";
import {
  MOSQUITO_FORM_CATEGORY_IDS,
  validateProductCategorySemantics,
} from "../src/product-category-semantics.js";

function subject(
  title: string,
  categoryId: string,
  selectedSpec = "",
  packingName = "",
) {
  const { product, plan } = example();
  product.title.value = title;
  product.variant = "";
  if (selectedSpec)
    product.specs["京东销售规格"] = {
      ...product.title,
      value: selectedSpec,
    };
  if (packingName)
    product.specs["包装名称"] = { ...product.title, value: packingName };
  plan.catalogBinding = { brandId: "brand", categoryId };
  return { product, plan };
}

test("matching explicit mosquito forms pass their exact category", () => {
  for (const [title, categoryId] of [
    ["示例甲品牌 电热蚊香片 无香型", MOSQUITO_FORM_CATEGORY_IDS.tablet],
    ["示例甲品牌 电热蚊香液 2瓶", MOSQUITO_FORM_CATEGORY_IDS.liquid],
    ["示例甲品牌 盘式蚊香 10盘", MOSQUITO_FORM_CATEGORY_IDS.coil],
    ["示例甲品牌 驱蚊喷雾 100mL", MOSQUITO_FORM_CATEGORY_IDS.spray],
  ]) {
    const { product, plan } = subject(title, categoryId);
    assert.deepEqual(validateProductCategorySemantics(product, plan), []);
  }
});

test("explicit tablet cannot use liquid category", () => {
  const { product, plan } = subject(
    "示例甲品牌 电热蚊香片 30片",
    MOSQUITO_FORM_CATEGORY_IDS.liquid,
  );
  const message = "商品明确为电热蚊香片，与所选类目蚊香液不一致";
  assert.deepEqual(validateProductCategorySemantics(product, plan), [message]);
  assert.ok(validate(product, plan).includes(message));
});

test("explicit selected spray specification cannot use coil category", () => {
  const { product, plan } = subject(
    "示例甲品牌 夏季驱蚊用品",
    MOSQUITO_FORM_CATEGORY_IDS.coil,
    "驱蚊喷雾 100mL 单瓶",
  );
  assert.deepEqual(validateProductCategorySemantics(product, plan), [
    "商品明确为驱蚊喷雾，与所选类目盘式蚊香不一致",
  ]);
});

test("ambiguous mixed products do not guess a single semantic category", () => {
  const { product, plan } = subject(
    "电热蚊香片+蚊香液组合套装",
    MOSQUITO_FORM_CATEGORY_IDS.tablet,
    "片液组合",
  );
  assert.deepEqual(validateProductCategorySemantics(product, plan), []);
});

test("shared detail keywords outside bound fields cannot change classification", () => {
  const { product, plan } = subject(
    "示例甲品牌 电热蚊香片 30片",
    MOSQUITO_FORM_CATEGORY_IDS.tablet,
  );
  product.specs["商品详情"] = { ...product.title, value: "驱蚊喷雾 蚊香盘" };
  assert.deepEqual(validateProductCategorySemantics(product, plan), []);
});

test("generic or unknown wording stays unclassified", () => {
  const { product, plan } = subject(
    "示例甲品牌 夏季驱蚊套装",
    MOSQUITO_FORM_CATEGORY_IDS.liquid,
    "家庭装",
    "驱蚊产品组合",
  );
  assert.deepEqual(validateProductCategorySemantics(product, plan), []);
});
