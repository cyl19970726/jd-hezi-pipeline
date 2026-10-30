import test from "node:test";
import assert from "node:assert/strict";
import {
  PACKING_DISPLAY_RULES_VERSION,
  clockPackingDisplayFact,
  listingPackingDisplayFact,
  projectPackingDisplay,
} from "../src/packing-display.js";

test("projects complete clock component sequences without losing order or counts", () => {
  assert.equal(
    projectPackingDisplay("挂钟*1、说明书*1、适配电池*3"),
    "挂钟1、说明书1、适配电池3",
  );
  assert.equal(projectPackingDisplay("闹钟*1说明书*1"), "闹钟1、说明书1");
  assert.equal(
    projectPackingDisplay(
      "挂钟×1、南孚电池（机芯使用）×1、碳性电池（显示模块使用）×2、说明书×1",
    ),
    "挂钟1、南孚电池1、碳性电池2、说明书1",
  );
  assert.equal(
    projectPackingDisplay("电波挂钟×1,说明书×1，碳性电池（液显模块使用）×2"),
    "电波挂钟1、说明书1、碳性电池2",
  );
  assert.equal(
    projectPackingDisplay("挂钟×1、南孚电池×1（机芯使用）、说明书×1"),
    "挂钟1、南孚电池1、说明书1",
  );
});

test("preserves non-purpose parentheses", () => {
  assert.equal(
    projectPackingDisplay("电池（南孚）*1、说明书*1"),
    "电池（南孚）1、说明书1",
  );
});

test("rejects ambiguity, incomplete syntax, zero counts and overlong output", () => {
  for (const value of [
    "挂钟*1、赠电池*1",
    "挂钟*1、随机说明书*1",
    "挂钟*1、颜色任选*1",
    "挂钟*1、说明书",
    "挂钟*0、说明书*1",
    "挂钟*1、",
    "挂钟*1+说明书*1",
    "挂钟*1/说明书*1",
    "挂钟*1、、说明书*1",
    "挂钟*1.5说明书*1",
    "挂钟*12说明书*1",
    "挂钟*12号电池*1",
    "挂钟*-1、说明书*1",
    "挂钟*01、说明书*1",
    "挂钟*1\n说明书*1",
    "挂钟1、说明书1",
  ])
    assert.equal(projectPackingDisplay(value), null, value);
  assert.equal(
    projectPackingDisplay(
      "超长名称挂钟组件*1、超长名称电池组件*2、超长名称说明书组件*1",
    ),
    null,
  );
});

test("plain single names stay unchanged and rules apply only to two clock leaves", () => {
  assert.equal(projectPackingDisplay("挂钟"), null);
  const fact = {
    value: "闹钟*1说明书*1",
    sourceUrl: "https://item.jd.com/4433083.html",
    capturedAt: "2026-09-16T00:00:00.000Z",
    evidence: "京东当前SKU包装清单",
  };
  assert.strictEqual(clockPackingDisplayFact("1068010002", fact), fact);
  assert.strictEqual(clockPackingDisplayFact("1068010", fact), fact);

  const projected = clockPackingDisplayFact("1068010003", fact);
  assert.equal(projected.value, "闹钟1、说明书1");
  assert.equal(projected.sourceUrl, fact.sourceUrl);
  assert.equal(projected.capturedAt, fact.capturedAt);
  assert.match(projected.evidence, /完整包装名称“闹钟\*1说明书\*1”/);
  assert.match(projected.evidence, new RegExp(PACKING_DISPLAY_RULES_VERSION));
  assert.equal(fact.value, "闹钟*1说明书*1");
});

test("clip display preserves every pack dimension and refuses extras or unproven prefixes", () => {
  const fact = {
    value: "示例牌X54彩色长尾票夹25mm筒装(混)(48只/筒)",
    sourceUrl: "https://item.jd.com/123456.html",
    capturedAt: "2026-09-21T00:00:00.000Z",
    evidence: "selected SKU packing",
  };
  const product = {
    url: fact.sourceUrl,
    specs: {
      品牌: { ...fact, value: "示例牌" },
      货号: { ...fact, value: "X54" },
    },
  } as any;
  const out = listingPackingDisplayFact("10049005", fact, product);
  assert.equal(out.value, "彩色长尾票夹25mm(48只/筒)");
  assert.ok(out.value.length <= 20);
  assert.equal(out.sourceUrl, fact.sourceUrl);
  assert.ok(out.evidence.includes(fact.value));
  for (const value of [
    fact.value + "+赠品",
    fact.value + "、附件1",
    fact.value.replace("48只", "0只"),
    fact.value.replace("示例牌", "另一个品牌"),
  ]) {
    const f = { ...fact, value };
    assert.strictEqual(listingPackingDisplayFact("10049005", f, product), f);
  }
  assert.strictEqual(
    listingPackingDisplayFact("10049006", fact, product),
    fact,
  );
  assert.strictEqual(
    listingPackingDisplayFact("10049005", fact, {
      ...product,
      specs: {
        ...product.specs,
        货号: {
          ...product.specs.货号,
          sourceUrl: "https://item.jd.com/999.html",
        },
      },
    }),
    fact,
  );
});

test("copy paper display retains box quantities and original evidence within field limit", () => {
  const fact = {
    value: "PZ9876测试系列双面复印纸 80g/包 5包/箱 总计2500张",
    sourceUrl: "https://item.jd.com/123456.html",
    capturedAt: "2026-09-21T00:00:00.000Z",
    evidence: "selected SKU packing",
  };
  const product = {
    url: fact.sourceUrl,
    specs: Object.fromEntries(
      Object.entries({
        型号: "PZ9876",
        克重: "80G",
        包数: "5包装",
        张数: "2500张",
      }).map(([k, v]) => [k, { ...fact, value: v }]),
    ),
  } as any;
  const out = listingPackingDisplayFact("10015007", fact, product);
  assert.equal(out.value, "复印纸80g5包/箱2500张");
  assert.ok(out.value.length <= 20);
  assert.ok(out.evidence.includes(fact.value));
  assert.equal(out.capturedAt, fact.capturedAt);
  assert.strictEqual(listingPackingDisplayFact("10015", fact, product), fact);
  for (const value of [
    fact.value + "赠品",
    fact.value.replace("5包/箱", "6包/箱"),
    fact.value.replace("80g", "90g"),
    fact.value.replace("PZ9876", "PZ9999"),
  ]) {
    const input = { ...fact, value };
    assert.strictEqual(
      listingPackingDisplayFact("10015007", input, product),
      input,
    );
  }
  const foreign = { ...fact, sourceUrl: "https://item.jd.com/999999.html" };
  assert.strictEqual(
    listingPackingDisplayFact("10015007", foreign, product),
    foreign,
  );
});
