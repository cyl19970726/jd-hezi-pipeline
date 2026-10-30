import test from "node:test";
import assert from "node:assert/strict";
import { example } from "../src/demo.js";
import { expectedFields, planSchema, validate } from "../src/model.js";

test("a sourced display title replaces only the published title projection", () => {
  const { product, plan } = example();
  const originalTitle = structuredClone(product.title);
  plan.displayTitle = {
    value: "示例品牌 室内纸盘香*10盘",
    sourceUrl: product.assets[0].url,
    capturedAt: product.capturedAt,
    evidence: "当前SKU主图明确展示正式名称、规格和室内用途",
  };

  assert.equal(
    expectedFields(product, plan).title,
    "示例品牌 室内纸盘香×10盘/件",
  );
  assert.deepEqual(product.title, originalTitle);
  assert.ok(
    !validate(product, plan).some((message) => message.includes("显示标题")),
  );
});

test("the current SKU product URL is also valid display-title evidence", () => {
  const { product, plan } = example();
  plan.displayTitle = {
    ...product.title,
    value: "示例品牌 正式商品名称/件",
    sourceUrl: product.url,
  };
  assert.equal(expectedFields(product, plan).title, "示例品牌 正式商品名称/件");
  assert.ok(
    !validate(product, plan).some((message) => message.includes("显示标题")),
  );
});

test("a display title cannot borrow evidence from another SKU", () => {
  const { product, plan } = example();
  plan.displayTitle = {
    ...product.title,
    value: "另一商品标题",
    sourceUrl: "https://item.jd.com/100000000002.html",
  };
  assert.ok(
    validate(product, plan).includes(
      "显示标题来源必须是当前SKU商品页或已知原图",
    ),
  );
});

test("display title remains a nonempty sourced fact", () => {
  const { plan } = example();
  assert.equal(
    planSchema.safeParse({
      ...plan,
      displayTitle: {
        value: "正式标题",
        sourceUrl: "https://img10.360buyimg.com/current-sku.jpg",
        capturedAt: new Date().toISOString(),
        evidence: "",
      },
    }).success,
    false,
  );
});

test("plans without a display title retain the original title behavior", () => {
  const { product, plan } = example();
  product.title.value = "示例品牌*标准标题";
  assert.equal(expectedFields(product, plan).title, "示例品牌×标准标题/件");
});
