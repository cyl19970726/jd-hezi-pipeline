import test from "node:test";
import assert from "node:assert/strict";
import { example } from "../src/demo.js";
import { prepareSaleText } from "../src/sale-text.js";
function product(label: string) {
  const { product: p } = example();
  p.specs = { 京东销售规格: { ...p.title, value: label } };
  return p;
}
test("selected text yields mixed set without invented bottle capacity", () => {
  const p = product("【1居推荐】贝贝健无香 3瓶 1器");
  const r = prepareSaleText(p);
  assert.equal(r.specs["规格"].value, "贝贝健无香 3瓶 1器");
  assert.equal(r.specs["加热器数量"].value, "1");
  assert.equal(r.specs["包装数量"].value, "1");
  assert.equal(r.specs["净含量"], undefined);
  assert.equal(p.specs["规格"], undefined);
});
test("refill selected label states bottle count and no heater", () => {
  const r = prepareSaleText(product("【超市同款】艾草补充液 2瓶"));
  assert.equal(r.specs["包装数量"].value, "2");
  assert.equal(r.specs["加热器数量"].value, "0");
});
test("does not infer counts from ambiguous random packages", () => {
  const r = prepareSaleText(product("随机2瓶或3瓶"));
  assert.equal(r.specs["包装数量"], undefined);
});

test("clock specification becomes 一个装 only from a current checklist proving one clock", () => {
  const p = product("经典款黑色 30cm");
  p.title.value = "示例丙品牌挂钟 3443A 黑色 30cm";
  p.specs["包装清单"] = {
    ...p.title,
    value: "挂钟×1、说明书×1、碳性电池×2",
    evidence: "京东当前SKU包装清单",
  };
  const r = prepareSaleText(p);
  assert.equal(r.specs["规格"].value, "一个装");
  assert.equal(r.specs["规格"].sourceUrl, p.url);
  assert.doesNotMatch(r.specs["规格"].value, /黑色|30cm/);
  assert.equal(r.specs["京东销售规格"].value, "经典款黑色 30cm");
});

test("clock colors and dimensions never become spec, and multipacks stay unresolved", () => {
  for (const packing of ["挂钟*2、说明书*1", "挂钟、说明书×1"]) {
    const p = product("经典款黑色 30cm");
    p.title.value = "示例丙品牌挂钟 3443A 黑色 30cm";
    p.specs["包装清单"] = { ...p.title, value: packing };
    const r = prepareSaleText(p);
    assert.equal(r.specs["规格"], undefined, packing);
  }
});
test("retains explicit net amount and original provenance", () => {
  const p = product("【驱蚊8.5h】15%派卡瑞丁|60ml");
  const r = prepareSaleText(p);
  assert.equal(r.specs["净含量"].value, "60ml");
  assert.equal(r.specs["净含量"].sourceUrl, p.url);
});

test("multiplies one explicit unit amount by its fixed count", () => {
  const p = product("【回购推荐】针管饵剂10g*3支");
  const r = prepareSaleText(p);
  assert.equal(r.specs["净含量"].value, "30g");
  assert.equal(r.specs["总净含量"].value, "30g");
  assert.equal(r.specs["净含量"].sourceUrl, p.url);
  assert.match(r.specs["净含量"].evidence, /销售文字规则/);
  assert.equal(r.specs["包装名称"].value, "针管饵剂");
  assert.equal(r.specs["包装数量"].value, "3");
});

test("derives total net amount only from an explicit single-bottle selected label", () => {
  for (const [label, expected] of [
    ["【升级大瓶】700ml/瓶（无香型）", "700ml"],
    ["500mL 1瓶 水基无香", "500mL"],
  ]) {
    const p = product(label);
    const r = prepareSaleText(p);
    assert.equal(r.specs["总净含量"].value, expected);
    assert.equal(r.specs["总净含量"].sourceUrl, p.url);
    assert.match(r.specs["总净含量"].evidence, /销售文字规则/);
  }
});

test("explicit per-bottle SKU text derives one package, sourced name, and flavor", () => {
  const p = product("【升级大瓶】700ml/瓶（无香型）");
  p.specs["包装清单"] = {
    ...p.title,
    value: "示例乙品牌金霸旋风气雾剂无香无味700毫升",
    evidence: "当前SKU包装清单",
  };
  for (const [field, value] of [
    ["包装名称", "旧包装"],
    ["包装数量", "9"],
    ["香型", "旧香型"],
  ])
    p.specs[field] = {
      ...p.title,
      value,
      evidence: "销售文字规则 sale-text/3；标准化规则 normalization-v6",
    };
  const r = prepareSaleText(p);
  assert.equal(r.specs["包装数量"].value, "1");
  assert.equal(r.specs["包装数量"].sourceUrl, p.url);
  assert.equal(r.specs["包装名称"].value, "示例乙品牌金霸旋风气雾剂无香无味");
  assert.match(r.specs["包装名称"].evidence, /当前SKU包装清单/);
  assert.equal(r.specs["香型"].value, "无香型");
  assert.equal(r.specs["香型"].sourceUrl, p.url);

  const small = prepareSaleText(product("【小瓶尝新】300ml/瓶（玫瑰香）"));
  assert.equal(small.specs["包装数量"].value, "1");
  assert.equal(small.specs["香型"].value, "玫瑰香");
  assert.equal(small.specs["包装名称"], undefined);
});

test("conflicting current packing capacity blocks new single-bottle facts", () => {
  const p = product("【升级大瓶】700ml/瓶（无香型）");
  p.specs["包装清单"] = {
    ...p.title,
    value: "气雾剂500毫升",
    evidence: "当前SKU冲突包装清单",
  };
  const r = prepareSaleText(p);
  assert.equal(r.specs["包装数量"], undefined);
  assert.equal(r.specs["包装名称"], undefined);
  assert.equal(r.specs["香型"].value, "无香型");
});

test("explicit selected flavor is independent of single-bottle parsing", () => {
  for (const [label, flavor] of [
    ["600ml*2瓶 玉兰香", "玉兰香"],
    ["600ml*2瓶 无香型", "无香型"],
    ["杀虫气雾剂300mL 有香型", "有香型"],
  ]) {
    const p = product(label);
    const r = prepareSaleText(p);
    assert.equal(r.specs["香型"].value, flavor);
    assert.equal(r.specs["香型"].sourceUrl, p.url);
  }
  assert.equal(
    prepareSaleText(product("杀虫喷雾剂2瓶")).specs["香型"],
    undefined,
  );

  const conflict = product("600ml*2瓶 无香型");
  conflict.specs["香型"] = {
    ...conflict.title,
    value: "有香型",
    evidence: "人工核验香型",
  };
  const retained = prepareSaleText(conflict);
  assert.equal(retained.specs["香型"].value, "有香型");
  assert.equal(retained.specs["香型"].evidence, "人工核验香型");
});

test("per-bottle multipacks never collapse to one bottle", () => {
  for (const label of ["600ml/瓶*2瓶", "600ml/瓶 2瓶装"]) {
    const r = prepareSaleText(product(label));
    assert.equal(r.specs["包装数量"].value, "2", label);
    assert.equal(r.specs["净含量"].value, "1200ml", label);
    assert.equal(r.specs["总净含量"].value, "1200ml", label);
  }
});

test("eleven and twenty-one bottles cannot match the one-bottle branch", () => {
  for (const count of [11, 21]) {
    const r = prepareSaleText(product(`600ml ${count}瓶`));
    assert.equal(r.specs["包装数量"].value, String(count));
    assert.equal(r.specs["总净含量"], undefined);
  }
});

test("does not derive total net amount from a bare capacity or gross weight", () => {
  const bare = product("水基无香 700ml");
  bare.specs["商品毛重"] = {
    ...bare.title,
    value: "0.9kg",
    evidence: "当前SKU商品毛重",
  };
  const r = prepareSaleText(bare);
  assert.equal(r.specs["净含量"].value, "700ml");
  assert.equal(r.specs["总净含量"], undefined);

  const weightOnly = product("水基无香喷雾");
  weightOnly.specs["商品毛重"] = {
    ...weightOnly.title,
    value: "0.9kg",
  };
  assert.equal(prepareSaleText(weightOnly).specs["总净含量"], undefined);
});

test("migrates only current-SKU sale-text/1 facts before recalculation", () => {
  const p = product("【回购推荐】针管饵剂10g*3支");
  p.specs["净含量"] = {
    ...p.title,
    value: "10g",
    evidence: "所选规格文字规则 sale-text/1；标准化规则 normalization-v1",
  };
  p.specs["包装名称"] = {
    ...p.title,
    value: "针管饵剂10g*",
    evidence: "所选规格文字规则 sale-text/1",
  };
  p.specs["包装数量"] = {
    ...p.title,
    value: "3",
    evidence: "所选规格文字规则 sale-text/1",
  };
  const r = prepareSaleText(p);
  assert.equal(r.specs["净含量"].value, "30g");
  assert.equal(r.specs["包装名称"].value, "针管饵剂");
  assert.equal(r.specs["包装数量"].value, "3");
  assert.match(r.specs["净含量"].evidence, /sale-text\/5/);
});

test("migrates the persisted sale-text/2 needle-bait facts from the real dry run", () => {
  const p = product("【回购推荐】针管饵剂10g*3支");
  const oldEvidence = "京东商品业务响应 color；销售文字规则 sale-text/2";
  p.specs["净含量"] = {
    ...p.title,
    value: "10g",
    evidence: oldEvidence,
  };
  p.specs["包装名称"] = {
    ...p.title,
    value: "针管饵剂10g*",
    evidence: oldEvidence,
  };
  p.specs["包装数量"] = {
    ...p.title,
    value: "3",
    evidence: oldEvidence,
  };
  const r = prepareSaleText(p);
  assert.equal(r.specs["净含量"].value, "30g");
  assert.equal(r.specs["总净含量"].value, "30g");
  assert.equal(r.specs["包装名称"].value, "针管饵剂");
  assert.equal(r.specs["包装数量"].value, "3");
  assert.match(r.specs["净含量"].evidence, /sale-text\/5/);
  assert.doesNotMatch(r.specs["净含量"].evidence, /sale-text\/2/);
});

test("never replaces an unmarked manual net amount", () => {
  const p = product("针管饵剂10g*3支");
  p.specs["净含量"] = {
    ...p.title,
    value: "人工核验30g",
    evidence: "人工逐项核对当前销售规格",
  };
  const r = prepareSaleText(p);
  assert.equal(r.specs["净含量"].value, "人工核验30g");
  assert.equal(r.specs["净含量"].evidence, "人工逐项核对当前销售规格");
});

test("does not calculate random, gifted, or mixed amount expressions", () => {
  for (const label of [
    "针管饵剂10g*随机3支",
    "针管饵剂10g*3支赠5g",
    "胶饵10g*3支+补充液20mL*1瓶",
  ]) {
    const r = prepareSaleText(product(label));
    assert.equal(r.specs["净含量"], undefined, label);
  }
});

test("derives exact cockroach-bait category and individual count from current text", () => {
  const selected = product("家用杀蟑饵剂16个");
  let r = prepareSaleText(selected);
  assert.equal(r.specs["类别"].value, "杀蟑饵剂");
  assert.equal(r.specs["类别"].sourceUrl, selected.url);
  assert.equal(r.specs["包装数量"].value, "16");

  const packing = product("针管装10g*3支");
  packing.specs["包装清单"] = {
    ...packing.title,
    value: "杀蟑胶饵10g×3",
    evidence: "当前SKU包装清单",
  };
  r = prepareSaleText(packing);
  assert.equal(r.specs["类别"].value, "杀蟑胶饵");
  assert.equal(r.specs["类别"].sourceUrl, packing.url);
  assert.match(r.specs["类别"].evidence, /当前SKU包装清单/);
  assert.equal(r.specs["净含量"].value, "30g");
  assert.equal(r.specs["包装名称"].value, "杀蟑胶饵10g");
  assert.equal(r.specs["包装数量"].value, "3");
});

test("category derivation does not overwrite or use a foreign-SKU checklist", () => {
  const p = product("针管装");
  p.specs["类别"] = { ...p.title, value: "已核验类别" };
  p.specs["包装清单"] = {
    ...p.title,
    value: "杀蟑胶饵10g×3",
    sourceUrl: "https://item.jd.com/999999.html",
  };
  const r = prepareSaleText(p);
  assert.equal(r.specs["类别"].value, "已核验类别");
  assert.equal(r.specs["净含量"], undefined);
});

test("retains an explicitly stated coating-bait category without guessing neighbors", () => {
  const explicit = product("【涂膜灭蟑】呋虫胺涂刷饵剂12g");
  let r = prepareSaleText(explicit);
  assert.equal(r.specs["类别"].value, "涂刷饵剂");
  assert.equal(r.specs["类别"].sourceUrl, explicit.url);

  r = prepareSaleText(product("【回购推荐】针管饵剂10g*3支"));
  assert.equal(r.specs["类别"], undefined);
});

test("a nonempty current packing list falls back to one complete sales package", () => {
  const p = product("【涂膜灭蟑】呋虫胺涂刷饵剂12g");
  p.specs["包装清单"] = {
    ...p.title,
    value: "呋虫胺涂刷式杀蟑饵剂12g",
    evidence: "当前SKU包装清单",
  };
  const r = prepareSaleText(p);
  assert.equal(r.specs["类别"].value, "涂刷饵剂");
  assert.equal(r.specs["净含量"].value, "12g");
  assert.equal(r.specs["包装数量"].value, "1");
  assert.equal(r.specs["包装名称"].value, "呋虫胺涂刷式杀蟑饵剂12g");
  assert.equal(r.specs["包装数量"].sourceUrl, p.url);
  assert.match(r.specs["包装数量"].evidence, /完整销售包装1份/);
  assert.match(r.specs["包装数量"].evidence, /1份不代表1支/);
  assert.match(r.specs["包装数量"].evidence, /sale-text\/5/);
});

test("whole-package fallback does not overwrite explicit or manual packing facts", () => {
  const explicit = product("杀虫喷雾剂2瓶");
  explicit.specs["包装清单"] = {
    ...explicit.title,
    value: "杀虫喷雾剂完整销售包装",
  };
  let r = prepareSaleText(explicit);
  assert.equal(r.specs["包装数量"].value, "2");

  const manual = product("涂刷饵剂12g");
  manual.specs["包装清单"] = {
    ...manual.title,
    value: "呋虫胺涂刷式杀蟑饵剂12g",
  };
  manual.specs["包装名称"] = {
    ...manual.title,
    value: "人工包装名称",
    evidence: "人工核验",
  };
  manual.specs["包装数量"] = {
    ...manual.title,
    value: "7",
    evidence: "人工核验数量",
  };
  r = prepareSaleText(manual);
  assert.equal(r.specs["包装名称"].value, "人工包装名称");
  assert.equal(r.specs["包装数量"].value, "7");
  assert.equal(r.specs["包装数量"].evidence, "人工核验数量");
});
test("counts explicitly listed same-kind bottles by fixed arithmetic", () => {
  const p = product("15%派卡瑞丁|60ml");
  p.specs["包装清单"] = {
    ...p.title,
    value: "示例甲品牌驱蚊液（10ml×2瓶正装+10ml×4瓶补充装）",
  };
  const r = prepareSaleText(p);
  assert.equal(r.specs["包装数量"].value, "6");
  assert.equal(r.specs["包装名称"].value, "示例甲品牌驱蚊液");
});

test("explicit single packing checklist wins over selected-label packing text", () => {
  const p = product("清香型 10圈 5盒 户外驱蚊常备");
  p.specs["包装清单"] = {
    ...p.title,
    value: "10圈*5",
    evidence: "京东当前SKU包装清单",
  };
  const r = prepareSaleText(p);
  assert.equal(r.specs["包装名称"].value, "10圈");
  assert.equal(r.specs["包装数量"].value, "5");
  assert.match(r.specs["包装名称"].evidence, /当前SKU包装清单/);
});

test("mixed bottle-heater selected label remains a one-row set without checklist", () => {
  const r = prepareSaleText(product("贝贝健无香 4瓶 2器"));
  assert.equal(r.specs["包装名称"].value, "贝贝健无香 4瓶 2器套装");
  assert.equal(r.specs["包装数量"].value, "1");
  assert.equal(r.specs["加热器数量"].value, "2");
});

test("existing packing fields and foreign-SKU checklists are never overwritten", () => {
  const existing = product("清香型 10圈 5盒 户外驱蚊常备");
  existing.specs["包装名称"] = { ...existing.title, value: "已核验包装" };
  existing.specs["包装数量"] = { ...existing.title, value: "9" };
  existing.specs["包装清单"] = { ...existing.title, value: "10圈*5" };
  let r = prepareSaleText(existing);
  assert.equal(r.specs["包装名称"].value, "已核验包装");
  assert.equal(r.specs["包装数量"].value, "9");

  const foreign = product("清香型 10圈 5盒 户外驱蚊常备");
  foreign.specs["包装清单"] = {
    ...foreign.title,
    value: "随机10圈*9",
    sourceUrl: "https://item.jd.com/999999.html",
  };
  r = prepareSaleText(foreign);
  assert.notEqual(r.specs["包装名称"].value, "10圈");
  assert.equal(r.specs["包装数量"].value, "5");
  assert.equal(r.specs["包装名称"].sourceUrl, foreign.url);
});
