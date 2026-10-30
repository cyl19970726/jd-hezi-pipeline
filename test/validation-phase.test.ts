import { test } from "node:test";
import assert from "node:assert/strict";
import { example } from "../src/demo.js";
import { validate } from "../src/model.js";

test("facts validation allows assets that still need download", () => {
  const { product, plan } = example();
  plan.mediaReviewed = false;
  product.assets = product.assets.map(({ role, order, url }) => ({
    role,
    order,
    url,
  }));

  const facts = validate(product, plan, { phase: "facts" });
  assert.ok(!facts.some((message) => message.includes("图片尚未下载")));

  const final = validate(product, plan);
  assert.ok(final.some((message) => message.includes("main 图片尚未下载")));
  assert.ok(final.some((message) => message.includes("detail 图片尚未下载")));
});

test("facts validation retains non-repairable media and product failures", () => {
  const { product, plan } = example();
  product.url = "https://item.jd.com/100000000002.html";
  product.assets = product.assets.filter((asset) => asset.role === "detail");

  const errors = validate(product, plan, { phase: "facts" });
  assert.ok(errors.includes("来源 URL 与 SKU 不一致"));
  assert.ok(errors.includes("main 有效图片不足"));
});

test("final validation accepts repeated source bytes but rejects invalid source order", () => {
  const { product, plan } = example();
  product.assets[1].sha256 = product.assets[0].sha256;

  assert.ok(!validate(product, plan).includes("main 图片重复，不能复制凑数"));
  product.assets[1].order = 2;
  assert.ok(validate(product, plan).includes("main 图片来源顺序无效"));
});
