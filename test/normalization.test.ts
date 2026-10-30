import test from "node:test";
import assert from "node:assert/strict";
import { example } from "../src/demo.js";
import {
  NORMALIZATION_RULES_VERSION,
  normalizeProduct,
} from "../src/normalization.js";
import { prepareSaleText } from "../src/sale-text.js";

function subject() {
  const { product } = example();
  product.specs = {};
  const fact = (value: string, evidence = "京东当前SKU页面") => ({
    ...product.title,
    value,
    evidence,
  });
  return { product, fact };
}

function archiveBoxSubject() {
  const { product, fact } = subject();
  product.title = fact("齐心5622档案盒 A4", "京东当前SKU标题");
  product.specs["规格"] = fact("A4", "京东规格参数：规格");
  product.specs["包装清单"] = fact("5622档案盒 × １个", "京东当前SKU包装清单");
  product.specs["京东销售规格"] = fact(
    "【35mm侧宽】蓝色-纯PP材质",
    "京东当前SKU销售规格",
  );
  product.specs["货号"] = fact("5622", "京东当前SKU货号");
  product.specs["材质"] = fact("pp", "京东规格参数：材质");
  return { product, fact };
}

function penSubject() {
  const { product, fact } = subject();
  product.title = fact("示例K35黑色中性笔12支装/盒", "京东当前SKU标题");
  product.specs["数量"] = fact("12支", "京东规格参数：数量");
  product.specs["包装形式"] = fact("盒装", "京东规格参数：包装形式");
  product.specs["包装清单"] = fact("12支装/盒", "京东当前SKU包装清单");
  product.specs["笔芯颜色"] = fact("黑色", "京东规格参数：笔芯颜色");
  product.specs["书写粗细"] = fact("0.5mm", "京东规格参数：书写粗细");
  product.specs["型号"] = fact("K35A", "京东规格参数：型号");
  product.specs["闭合方式"] = fact("按动", "京东规格参数：闭合方式");
  return { product, fact };
}

function copyPaperSubject() {
  const { product, fact } = subject();
  product.title = fact(
    "示例牌测试系列80g双面复印纸PZ9876 500张/包 5包/箱 1箱 总计2500张",
    "京东当前SKU标题",
  );
  product.specs["克重"] = fact("80G", "京东规格参数：克重");
  product.specs["颜色"] = fact("白色", "京东规格参数：颜色");
  product.specs["规格"] = fact("A4", "京东规格参数：规格");
  product.specs["张数"] = fact("2500张", "京东规格参数：张数");
  product.specs["包数"] = fact("5包装", "京东规格参数：包数");
  product.specs["包装清单"] = fact(
    "PZ9876测试系列双面复印纸 80g/包 5包/箱 总计2500张",
    "京东当前SKU包装清单",
  );
  return { product, fact };
}

test("normalizes copy-paper required template fields from explicit current-SKU facts", () => {
  const { product } = copyPaperSubject();
  const result = normalizeProduct(
    product,
    ["规格", "克重", "颜色", "纸张尺寸", "型号"],
    { categoryId: "10015007" },
  );
  assert.deepEqual(result.blockingReasons, []);
  assert.equal(result.product.specs["规格"].value, "5包装");
  assert.equal(result.product.specs["纸张尺寸"].value, "A4");
  assert.equal(result.product.specs["克重"].value, "80G");
  assert.equal(result.product.specs["颜色"].value, "白色");
  assert.equal(result.product.specs["型号"].value, "PZ9876");
  assert.equal(result.resolutions["规格"].evidence[0].sourceField, "包数");
  assert.equal(
    result.resolutions["纸张尺寸"].evidence[0].sourceField,
    "京东原始规格",
  );
});

test("copy-paper normalization stays category bounded and rejects conflicting pack counts", () => {
  const outside = copyPaperSubject();
  assert.equal(
    normalizeProduct(outside.product, ["纸张尺寸"]).resolutions["纸张尺寸"]
      .status,
    "not_observed",
  );

  const conflicting = copyPaperSubject();
  conflicting.product.specs["包数"] = conflicting.fact("4包装");
  const result = normalizeProduct(conflicting.product, ["规格"], {
    categoryId: "10015007",
  });
  assert.equal(result.resolutions["规格"].status, "conflicting");

  const staleBackup = copyPaperSubject();
  staleBackup.product.specs["京东原始规格"] = staleBackup.fact("A3");
  const backupResult = normalizeProduct(staleBackup.product, ["纸张尺寸"], {
    categoryId: "10015007",
  });
  assert.equal(backupResult.resolutions["纸张尺寸"].status, "conflicting");
});

test("copy-paper numeric model ignores years, dimensions, and sheet counts", () => {
  const { product, fact } = copyPaperSubject();
  product.title = fact("示例牌2026新款复印纸 A4 80g 1000张 1200mm");
  delete product.specs["包装清单"];
  const result = normalizeProduct(product, ["型号"], {
    categoryId: "10015007",
  });
  assert.equal(result.resolutions["型号"].status, "not_observed");
});

test("copy-paper normalization preserves an explicit current-SKU box name across sale-text replay", () => {
  const { product, fact } = copyPaperSubject();
  product.specs["包装清单"] = fact(
    "80gA4复印纸 ×1箱（5包）",
    "京东当前SKU包装清单",
  );
  const requirements = [
    "包装名称",
    "包装数量",
    "规格",
    "克重",
    "颜色",
    "纸张尺寸",
  ];
  const first = normalizeProduct(prepareSaleText(product), requirements, {
    categoryId: "10015007",
  });
  assert.deepEqual(first.blockingReasons, []);
  assert.equal(
    first.product.specs["包装名称"].value,
    "80gA4复印纸 ×1箱（5包）",
  );
  assert.equal(first.product.specs["包装数量"].value, "1");

  const again = normalizeProduct(prepareSaleText(first.product), requirements, {
    categoryId: "10015007",
  });
  assert.deepEqual(again.blockingReasons, []);
  assert.equal(
    again.product.specs["包装名称"].value,
    "80gA4复印纸 ×1箱（5包）",
  );
  assert.equal(again.product.specs["包装数量"].value, "1");
});

test("normalizes a gross-weight alias on a copy and retains its provenance", () => {
  const { product, fact } = subject();
  product.specs["含包装重量"] = fact("900克", "京东规格参数：含包装重量");
  const before = structuredClone(product);
  const result = normalizeProduct(product, [
    { name: "商品毛重", required: true },
  ]);

  assert.deepEqual(product, before);
  assert.equal(result.product.specs["商品毛重"].value, "0.9kg");
  assert.equal(result.resolutions["商品毛重"].status, "resolved");
  assert.equal(
    result.resolutions["商品毛重"].evidence[0].sourceField,
    "含包装重量",
  );
  assert.equal(result.rulesVersion, NORMALIZATION_RULES_VERSION);
  assert.deepEqual(result.blockingReasons, []);
});

test("does not infer gross weight from net content or capacity", () => {
  const { product, fact } = subject();
  product.specs["总净含量"] = fact("1000mL");
  product.specs["净含量"] = fact("1kg");
  const result = normalizeProduct(product, [
    { name: "商品毛重", required: true },
  ]);

  assert.equal(result.resolutions["商品毛重"].status, "not_observed");
  assert.equal(result.product.specs["商品毛重"], undefined);
  assert.match(result.blockingReasons[0], /尚未采集/);
});

test("resolves heaters but leaves mixed liquid packaging unparsed", () => {
  const { product, fact } = subject();
  product.title.value = "示例甲品牌电热蚊香液家庭装";
  product.specs["京东销售规格"] = fact("40mL×4瓶+加热器2个");
  product.specs["包装清单"] = fact("电蚊香液4瓶、加热器2个");
  const result = normalizeProduct(product, {
    fields: [
      { name: "包装数量", required: true },
      { name: "加热器数量", required: true },
    ],
  });

  assert.equal(result.product.specs["包装数量"], undefined);
  assert.equal(result.product.specs["加热器数量"].value, "2");
  assert.equal(result.resolutions["包装数量"].status, "unparsed");
  assert.equal(result.blockingReasons.length, 1);
});

test("does not add unlike components into a total package count", () => {
  const { product, fact } = subject();
  product.title.value = "家庭清洁组合套装";
  product.specs["包装清单"] = fact("喷雾2瓶、补充液3袋、清洁布1片");
  const result = normalizeProduct(product, [
    { name: "包装数量", required: true },
  ]);

  assert.equal(result.resolutions["包装数量"].status, "unparsed");
  assert.equal(result.product.specs["包装数量"], undefined);
  assert.match(result.blockingReasons[0], /无法可靠解析/);
});

test("equivalent weight units agree but different aliases are an explicit conflict", () => {
  const equivalent = subject();
  equivalent.product.specs["商品毛重"] = equivalent.fact("0.9kg");
  equivalent.product.specs["包装毛重"] = equivalent.fact("900克");
  assert.equal(
    normalizeProduct(equivalent.product).resolutions["商品毛重"].status,
    "resolved",
  );

  const conflict = subject();
  conflict.product.specs["商品毛重"] = conflict.fact("0.9kg");
  conflict.product.specs["包装毛重"] = conflict.fact("1kg");
  const original = conflict.product.specs["商品毛重"];
  const result = normalizeProduct(conflict.product, [
    { name: "商品毛重", required: true },
  ]);
  assert.equal(result.resolutions["商品毛重"].status, "conflicting");
  assert.deepEqual(result.product.specs["商品毛重"], original);
  assert.match(result.blockingReasons[0], /0.9kg、1kg/);
});

test("optional empty fields do not block and observed placeholders stay unparsed", () => {
  const { product, fact } = subject();
  product.specs["型号"] = fact("暂无");
  const result = normalizeProduct(product, {
    fields: [
      { name: "型号", required: false },
      { name: "产地", required: false },
    ],
  });
  assert.deepEqual(result.blockingReasons, []);
  assert.equal(result.resolutions["型号"].status, "unparsed");
  assert.equal(result.resolutions["产地"].status, "not_observed");
});

test("not-applicable is available only for an explicitly optional field", () => {
  const { product } = subject();
  product.title.value = "示例甲品牌驱蚊喷雾100mL";
  const required = normalizeProduct(product, ["加热器数量"]);
  assert.equal(required.resolutions["加热器数量"].status, "not_observed");
  assert.equal(required.issues.length, 1);

  const optional = normalizeProduct(product, [
    { name: "加热器数量", required: false },
  ]);
  assert.equal(optional.resolutions["加热器数量"].status, "not_applicable");
  assert.deepEqual(optional.blockingReasons, []);
});

test("rejects foreign-SKU facts and accepts exact current-product asset evidence", () => {
  const { product, fact } = subject();
  product.specs["包装毛重"] = {
    ...fact("900克"),
    sourceUrl: "https://item.jd.com/999999.html",
  };
  let result = normalizeProduct(product, ["商品毛重"]);
  assert.equal(result.resolutions["商品毛重"].status, "unparsed");
  assert.equal(result.product.specs["商品毛重"], undefined);

  product.assets.push({
    role: "detail",
    origin: "android-album",
    url: "https://img.example/current-sku.jpg",
    order: 0,
  });
  product.specs["包装毛重"] = {
    ...fact("900克"),
    sourceUrl: product.assets[0].url,
  };
  result = normalizeProduct(product, ["商品毛重"]);
  assert.equal(result.resolutions["商品毛重"].status, "resolved");
});

test("rejects ambiguous package arithmetic, nesting, ranges, gifts and random packs", () => {
  for (const value of [
    "2盒每盒3瓶",
    "2×3瓶",
    "2-3瓶",
    "2瓶+赠品1袋",
    "随机2瓶装",
    "电蚊香液4瓶2器",
  ]) {
    const { product, fact } = subject();
    product.specs["京东销售规格"] = fact(value);
    const result = normalizeProduct(product, ["包装数量"]);
    assert.equal(result.resolutions["包装数量"].status, "unparsed", value);
    assert.equal(result.product.specs["包装数量"], undefined, value);
  }
});

test("an invalid canonical value cannot be hidden by a valid alias", () => {
  const { product, fact } = subject();
  product.specs["商品毛重"] = fact("900");
  product.specs["包装毛重"] = fact("900克");
  const result = normalizeProduct(product, ["商品毛重"]);
  assert.equal(result.resolutions["商品毛重"].status, "conflicting");
  assert.equal(result.product.specs["商品毛重"].value, "900");
  assert.match(result.issues[0], /已有值无效/);
});

test("an explicit heater count is not overwritten by identity classification", () => {
  const { product, fact } = subject();
  product.title.value = "示例甲品牌驱蚊喷雾套装";
  product.specs["加热器数量"] = fact("1个");
  const result = normalizeProduct(product, [
    { name: "加热器数量", required: false },
  ]);
  assert.equal(result.resolutions["加热器数量"].status, "resolved");
  assert.equal(result.product.specs["加热器数量"].value, "1个");
});

test("resolves one explicit packing-list item into name and count", () => {
  for (const value of ["蚊香液套装×1", "蚊香液套装x1", "蚊香液套装*1"]) {
    const { product, fact } = subject();
    product.specs["包装清单"] = fact(value, "京东当前SKU包装清单");
    const result = normalizeProduct(product, ["包装名称", "包装数量"]);
    assert.equal(result.resolutions["包装名称"].status, "resolved", value);
    assert.equal(result.resolutions["包装数量"].status, "resolved", value);
    assert.equal(result.product.specs["包装名称"].value, "蚊香液套装");
    assert.equal(result.product.specs["包装数量"].value, "1");
    assert.equal(
      result.resolutions["包装名称"].evidence[0].sourceField,
      "包装清单",
    );
  }
});

test("single-item packing syntax rejects ambiguous or capacity-only names", () => {
  for (const value of [
    "500mL×2",
    "2盒每盒3瓶×1",
    "蚊香液×1+加热器×1",
    "赠蚊香液套装×1",
    "随机套装×1",
    "蚊香液套装×1-2",
    "4瓶2器",
  ]) {
    const { product, fact } = subject();
    product.specs["包装清单"] = fact(value);
    const result = normalizeProduct(product, ["包装名称", "包装数量"]);
    assert.equal(result.resolutions["包装名称"].status, "unparsed", value);
    assert.equal(result.product.specs["包装名称"], undefined, value);
  }
});

test("derived packing facts cannot replace a conflicting canonical value", () => {
  const { product, fact } = subject();
  product.specs["包装名称"] = fact("补充装");
  product.specs["包装数量"] = fact("2");
  product.specs["包装清单"] = fact("蚊香液套装×1");
  const result = normalizeProduct(product, ["包装名称", "包装数量"]);
  assert.equal(result.resolutions["包装名称"].status, "conflicting");
  assert.equal(result.resolutions["包装数量"].status, "conflicting");
  assert.equal(result.product.specs["包装名称"].value, "补充装");
  assert.equal(result.product.specs["包装数量"].value, "2");
});

test("single-item packing derivation rejects a foreign-SKU checklist", () => {
  const { product, fact } = subject();
  product.specs["包装清单"] = {
    ...fact("蚊香液套装×1"),
    sourceUrl: "https://item.jd.com/999999.html",
  };
  const result = normalizeProduct(product, ["包装名称", "包装数量"]);
  assert.equal(result.resolutions["包装名称"].status, "unparsed");
  assert.equal(result.resolutions["包装数量"].status, "unparsed");
  assert.equal(result.product.specs["包装名称"], undefined);
  assert.equal(result.product.specs["包装数量"], undefined);
});

test("derives long-tail clip model and missing spec only from current-SKU explicit facts", () => {
  const { product, fact } = subject();
  product.title = fact("示例牌彩色长尾夹 25mm 48只/筒 A54");
  product.specs["货号"] = fact("A54", "京东当前SKU货号");
  product.specs["类型"] = fact("金属夹");
  product.specs["京东销售规格"] = fact("48只25mm小号票夹");
  product.specs["包装清单"] = fact(
    "示例牌A54彩色长尾票夹25mm筒装(48只/筒)",
    "京东当前SKU包装清单",
  );

  const result = normalizeProduct(product, ["类型", "规格", "型号"]);

  assert.deepEqual(result.blockingReasons, []);
  assert.equal(result.product.specs["类型"].value, "金属夹");
  assert.equal(result.product.specs["型号"].value, "A54");
  assert.equal(result.product.specs["规格"].value, "48只装");
  assert.equal(result.resolutions["型号"].evidence[0].sourceField, "货号");
  assert.equal(
    result.resolutions["型号"].evidence[0].rule,
    "long-tail-clip-model-from-current-sku-item-number",
  );
  assert.equal(result.resolutions["规格"].evidence[0].sourceField, "包装清单");
  assert.equal(
    result.resolutions["规格"].evidence[0].rule,
    "long-tail-clip-spec-from-explicit-pack-list",
  );
});

test("long-tail clip derivation preserves an explicit spec and blocks conflicting identity facts", () => {
  const existing = subject();
  existing.product.title = existing.fact("示例牌彩色长尾夹 15mm 60只/筒 B56");
  existing.product.specs["货号"] = existing.fact("B56");
  existing.product.specs["规格"] = existing.fact("60只15mm小号票夹");
  existing.product.specs["包装清单"] = existing.fact("长尾票夹15mm 60只/筒");
  let result = normalizeProduct(existing.product, ["规格", "型号"]);
  assert.deepEqual(result.blockingReasons, []);
  assert.equal(result.product.specs["规格"].value, "60只15mm小号票夹");
  assert.equal(result.product.specs["型号"].value, "B56");

  existing.product.specs["型号"] = existing.fact("DIFFERENT");
  result = normalizeProduct(existing.product, ["型号"]);
  assert.equal(result.resolutions["型号"].status, "conflicting");
  assert.match(result.blockingReasons[0], /DIFFERENT、B56|B56、DIFFERENT/u);
  assert.equal(result.product.specs["型号"].value, "DIFFERENT");
});

test("long-tail clip derivation rejects incomplete, conflicting, and foreign packaging facts", () => {
  const cases = [
    { pack: "长尾票夹25mm筒装", sales: "48只25mm小号票夹" },
    { pack: "长尾票夹25mm 48只/筒", sales: "60只25mm小号票夹" },
    { pack: "长尾票夹25mm 48只/筒", sales: "48只32mm小号票夹" },
    { pack: "长尾票夹25mm 48只/盒", sales: "48只25mm小号票夹" },
  ];
  for (const entry of cases) {
    const { product, fact } = subject();
    product.title = fact("示例牌彩色长尾夹25mm 48只/筒 C48");
    product.specs["货号"] = fact("C48");
    product.specs["京东销售规格"] = fact(entry.sales);
    product.specs["包装清单"] = fact(entry.pack);
    const result = normalizeProduct(product, ["规格", "型号"]);
    assert.notEqual(result.resolutions["规格"].status, "resolved", entry.pack);
    assert.notEqual(result.resolutions["型号"].status, "resolved", entry.pack);
  }

  const foreign = subject();
  foreign.product.title = foreign.fact("示例牌彩色长尾夹25mm 48只/筒 C48");
  foreign.product.specs["货号"] = foreign.fact("C48");
  foreign.product.specs["包装清单"] = {
    ...foreign.fact("长尾票夹25mm 48只/筒"),
    sourceUrl: "https://item.jd.com/999999.html",
  };
  const result = normalizeProduct(foreign.product, ["规格", "型号"]);
  assert.notEqual(result.resolutions["规格"].status, "resolved");
  assert.notEqual(result.resolutions["型号"].status, "resolved");
});

test("projects a verified archive box into its category semantics without losing raw paper size", () => {
  const { product } = archiveBoxSubject();
  const result = normalizeProduct(
    product,
    [
      { name: "规格", required: true },
      { name: "尺寸规格", required: true },
      { name: "材质", required: true },
      { name: "型号", required: false },
      { name: "颜色", required: false },
    ],
    { categoryId: "10048009" },
  );

  assert.deepEqual(result.blockingReasons, []);
  assert.equal(result.product.specs["规格"].value, "单个装");
  assert.equal(result.product.specs["尺寸规格"].value, "35mm");
  assert.equal(result.product.specs["材质"].value, "pp");
  assert.equal(result.product.specs["型号"].value, "5622");
  assert.equal(result.product.specs["颜色"].value, "蓝色");
  assert.equal(result.product.specs["京东原始规格"].value, "A4");
  assert.equal(result.product.specs["规格"].sourceUrl, product.url);
  assert.equal(result.resolutions["规格"].evidence[0].sourceField, "包装清单");
  assert.equal(
    result.resolutions["尺寸规格"].evidence[0].rule,
    "archive-box-side-width-from-current-sku-sale-spec",
  );
  assert.equal(product.specs["规格"].value, "A4");
});

test("archive-box semantics reject conflicting count, side width, color, and raw backups", () => {
  const cases = [
    {
      field: "规格",
      change: (p: ReturnType<typeof archiveBoxSubject>["product"]) => {
        p.specs["京东销售规格"].value = "【35mm侧宽】蓝色 2个装";
      },
    },
    {
      field: "规格",
      change: (p: ReturnType<typeof archiveBoxSubject>["product"]) => {
        p.title.value = "齐心5622档案盒 2个";
      },
    },
    {
      field: "尺寸规格",
      change: (p: ReturnType<typeof archiveBoxSubject>["product"]) => {
        p.title.value = "齐心5622档案盒 55mm";
      },
    },
    {
      field: "颜色",
      change: (p: ReturnType<typeof archiveBoxSubject>["product"]) => {
        p.specs["京东销售规格"].value = "【35mm侧宽】蓝色 红色";
      },
    },
  ];
  for (const entry of cases) {
    const { product } = archiveBoxSubject();
    entry.change(product);
    const result = normalizeProduct(product, [entry.field], {
      categoryId: "10048009",
    });
    assert.equal(
      result.resolutions[entry.field].status,
      "conflicting",
      entry.field,
    );
    if (entry.field === "颜色") {
      assert.equal(result.product.specs["规格"].value, "单个装");
      assert.equal(result.product.specs["京东原始规格"].value, "A4");
    } else assert.equal(result.product.specs["规格"].value, "A4", entry.field);
  }

  const { product, fact } = archiveBoxSubject();
  product.specs["京东原始规格"] = fact("A3", "已有的京东规格备份");
  const result = normalizeProduct(product, ["规格"], {
    categoryId: "10048009",
  });
  assert.equal(result.resolutions["规格"].status, "conflicting");
  assert.equal(result.product.specs["京东原始规格"].value, "A3");
  assert.equal(result.product.specs["规格"], undefined);
});

test("archive-box paper size never passes as a sale pack without complete current-SKU proof", () => {
  for (const change of [
    (p: ReturnType<typeof archiveBoxSubject>["product"]) => {
      p.specs["包装清单"].value = "5622档案盒（包装以实物为准）";
    },
    (p: ReturnType<typeof archiveBoxSubject>["product"]) => {
      p.specs["包装清单"].sourceUrl = "https://item.jd.com/999999.html";
    },
  ]) {
    const { product } = archiveBoxSubject();
    change(product);
    const result = normalizeProduct(product, ["规格"], {
      categoryId: "10048009",
    });
    assert.equal(result.resolutions["规格"].status, "unparsed");
    assert.equal(result.product.specs["规格"].value, "A4");
    assert.match(result.blockingReasons[0], /规格/);
  }
});

test("derives a pen box specification only from current count and box facts", () => {
  const { product } = penSubject();
  const result = normalizeProduct(
    product,
    ["笔芯颜色", "书写粗细", "规格", "型号", "闭合方式", "是否可定制"],
    { categoryId: "10041013" },
  );
  assert.equal(result.product.specs["规格"].value, "12支装");
  assert.equal(
    result.resolutions["规格"].evidence[0].rule,
    "pen-spec-from-current-sku-count-and-box-packaging",
  );
  assert.equal(result.resolutions["是否可定制"].status, "not_observed");
  assert.deepEqual(result.blockingReasons, [
    "是否可定制尚未采集，不能视为来源明确缺失",
  ]);
});

test("pen box specification refuses foreign or contradictory packaging", () => {
  for (const change of [
    (p: ReturnType<typeof penSubject>["product"]) => {
      p.specs["包装清单"].value = "10支装/盒";
    },
    (p: ReturnType<typeof penSubject>["product"]) => {
      p.specs["包装形式"].sourceUrl = "https://item.jd.com/999999.html";
    },
    (p: ReturnType<typeof penSubject>["product"]) => {
      p.specs["包装清单"].sourceUrl = "https://item.jd.com/999999.html";
    },
  ]) {
    const { product } = penSubject();
    change(product);
    const result = normalizeProduct(product, ["规格"], {
      categoryId: "10041013",
    });
    assert.notEqual(result.resolutions["规格"].status, "resolved");
    assert.equal(result.product.specs["规格"], undefined);
  }
});

test("pen preparation preserves a complete selected-SKU specification and blocks count conflict", () => {
  const { product } = penSubject();
  product.specs["京东销售规格"] = {
    ...product.specs["数量"],
    value: "K35/黑色/12支装",
    evidence: "京东当前SKU销售规格",
  };
  const saleText = prepareSaleText(product);
  const result = normalizeProduct(saleText, ["规格"], {
    categoryId: "10041013",
  });
  assert.equal(result.resolutions["规格"].status, "resolved");
  assert.equal(result.product.specs["规格"].value, "K35/黑色/12支装");
  assert.deepEqual(result.blockingReasons, []);

  product.specs["数量"].value = "10支";
  const conflicting = normalizeProduct(prepareSaleText(product), ["规格"], {
    categoryId: "10041013",
  });
  assert.equal(conflicting.resolutions["规格"].status, "conflicting");
  assert.match(
    conflicting.blockingReasons[0],
    /数量与包装清单或当前销售规格不一致/,
  );
});
