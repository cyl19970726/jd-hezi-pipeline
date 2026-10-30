import { test } from "node:test";
import assert from "node:assert/strict";
import { replacementReason } from "../src/replacement.js";

test("category mismatch is an explicit replacement repair with old and new values", () => {
  assert.equal(
    replacementReason(
      { category: "日用百货>驱蚊用品>蚊香液" },
      "日用百货>驱蚊用品>蚊香片",
    ),
    "修复平台类目：日用百货>驱蚊用品>蚊香液 → 日用百货>驱蚊用品>蚊香片",
  );
});

test("category repair requires observed nonempty old category and a real mismatch", () => {
  assert.equal(replacementReason({}, "日用百货>驱蚊用品>蚊香片"), null);
  assert.equal(
    replacementReason(
      { category: "日用百货>驱蚊用品>蚊香片" },
      "日用百货>驱蚊用品>蚊香片",
    ),
    null,
  );
  assert.equal(replacementReason({ category: "  " }, "新类目"), null);
  assert.equal(
    replacementReason({ category: "日用百货 > 蚊香片" }, "日用百货>蚊香片"),
    null,
  );
});

test("real dirty clear fields and category repair evidence are both retained", () => {
  assert.equal(
    replacementReason(
      { category: "旧类目", origin: "继承产地", model: "" },
      "新类目",
      ["origin", "model"],
    ),
    "平台不能清除旧值：origin；修复平台类目：旧类目 → 新类目",
  );
});
