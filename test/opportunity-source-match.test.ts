import test from "node:test";
import assert from "node:assert/strict";
import type { Product } from "../src/model.js";
import {
  compareMarketSource,
  planSourceCandidateSearch,
} from "../src/opportunity-source-match.js";
import { normalizeProduct } from "../src/normalization.js";
import { prepareSaleText } from "../src/sale-text.js";

const at = "2026-09-20T04:00:00.000Z";
const now = Date.parse(at);
const sku = "100012345678";
const jdUrl = `https://item.jd.com/${sku}.html`;

function fact(value: string, overrides: Partial<Product["title"]> = {}) {
  return {
    value,
    sourceUrl: jdUrl,
    capturedAt: at,
    evidence: "fabricated JD product specification",
    ...overrides,
  };
}

function product(): Product {
  return {
    sku,
    variant: "",
    url: jdUrl,
    title: fact("测试商品"),
    price: null,
    specs: {
      品牌: fact("清风"),
      型号: fact("QF-A1"),
      京东销售规格: fact("单支装"),
      净含量: fact("10g"),
      香型: fact("无香"),
    },
    assets: [],
    capturedAt: at,
  };
}

function payload() {
  return {
    code: 0,
    data: {
      itemId: "market-item-9",
      itemPublishVo: {
        id: "market-item-9",
        shopId: "market-shop-7",
        brandName: "清风",
        brandId: "brand-1",
        cid: "category-1",
        categoryFullName: "测试/类目",
        packingList: null,
        skuSpecMap: {
          "market-sku-3": [
            { attrName: "型号", attrValue: "QF-A1" },
            { attrName: "规格", attrValue: "单支装" },
            { attrName: "净含量", attrValue: "10g" },
            { attrName: "香型", attrValue: "无香" },
          ],
          "other-sku": [
            { attrName: "型号", attrValue: "OTHER" },
            { attrName: "规格", attrValue: "十支装" },
          ],
        },
      },
      itemSkuInfoList: [
        {
          id: "market-sku-3",
          itemId: "market-item-9",
          shopId: "market-shop-7",
          skuName: "标题不得用于推断规格",
          skuUnit: "支",
          specAttributes: "规格:单支装;净含量:10g;香型:无香;",
          specAttributesList: [
            {
              skuId: "market-sku-3",
              itemId: "market-item-9",
              attributeName: "规格",
              attributeValue: "单支装",
            },
          ],
          modelCode: "QF-A1",
          skuPicUrls: [{ url: jdUrl }],
        },
        {
          id: "other-sku",
          itemId: "market-item-9",
          shopId: "market-shop-7",
          specAttributes: "规格:十支装;",
          modelCode: "OTHER",
          skuPicUrls: [{ url: "https://item.jd.com/999999.html" }],
        },
      ],
    },
  };
}

function compare(
  marketPayload: unknown = payload(),
  source: Product = product(),
  marketCheckedAt = at,
) {
  return compareMarketSource(
    {
      marketPayload,
      marketItemId: "market-item-9",
      marketSkuId: "market-sku-3",
      marketShopId: "market-shop-7",
      source,
      detailReceiptId: "fabricated-detail-receipt",
      marketCheckedAt,
    },
    now,
  );
}

test("matches only explicit fresh selected-SKU facts and emits the strict core fields", () => {
  const result = compare();
  assert.equal(result.matched, true);
  assert.deepEqual(
    result.fields.map((field) => field.field),
    ["brand", "model", "packaging"],
  );
  assert.equal(result.sourceSku, sku);
  assert.equal(result.detailReceiptId, "fabricated-detail-receipt");
  assert.equal(result.checkedAt, at);
  assert.deepEqual(result.blockers, []);
});

function copyPaperFixture() {
  const raw = payload();
  raw.data.itemPublishVo.brandName = "示例牌";
  raw.data.itemPublishVo.cid = "10015007";
  raw.data.itemPublishVo.categoryFullName = "办公用品>办公耗材>办公用纸>复印纸";
  raw.data.itemPublishVo.skuSpecMap["market-sku-3"] = [
    { attrName: "规格", attrValue: "5包装" },
    { attrName: "克重", attrValue: "80g" },
    { attrName: "颜色", attrValue: "白色" },
    { attrName: "纸张尺寸", attrValue: "A4" },
    { attrName: "张数", attrValue: "2500张" },
  ];
  Object.assign(raw.data.itemSkuInfoList[0], {
    skuName: "示例牌测试系列80g双面复印纸PZ9876 500张/包 5包/箱 1箱 总计2500张",
    skuUnit: "箱",
    modelCode: null,
    specAttributes: "规格:5包装;克重:80g;颜色:白色;纸张尺寸:A4;张数:2500张;",
    specAttributesList: [],
  });
  const source = product();
  source.title = fact(
    "示例牌测试系列80g双面复印纸PZ9876 500张/包 5包/箱 1箱 总计2500张",
  );
  source.specs = {
    品牌: fact("示例牌"),
    克重: fact("80G"),
    颜色: fact("白色"),
    规格: fact("A4"),
    张数: fact("2500张"),
    包数: fact("5包装"),
    包装清单: fact("PZ9876测试系列双面复印纸 80g/包 5包/箱 总计2500张"),
  };
  return { raw, source };
}

test("matches copy paper from bounded per-side model and complete quantity hierarchy", () => {
  const { raw, source } = copyPaperFixture();
  const result = compare(raw, source);
  assert.equal(result.matched, true, JSON.stringify(result.blockers));
  assert.deepEqual(
    result.fields.map(({ field }) => field),
    ["brand", "model", "packaging"],
  );
  assert.match(
    result.fields[2].marketValue,
    /A4\|80g\|白色\|500张\/包\|5包\/箱\|总2500张\|箱/u,
  );
});

test("copy-paper comparison survives sale-text preparation and template normalization", () => {
  const { raw, source } = copyPaperFixture();
  source.specs["商品毛重"] = fact("1.2kg");
  const normalized = normalizeProduct(
    prepareSaleText(source),
    ["商品毛重", "包装名称", "包装数量", "规格", "克重", "颜色", "纸张尺寸"],
    { categoryId: "10015007" },
  );
  assert.deepEqual(normalized.blockingReasons, []);
  const result = compare(raw, normalized.product);
  assert.equal(result.matched, true, JSON.stringify(result.blockers));
});

test("maps a proven legacy copy-paper parent category to the publish leaf", () => {
  const { raw, source } = copyPaperFixture();
  raw.data.itemPublishVo.cid = "10015";
  raw.data.itemPublishVo.categoryFullName = "办公用品>办公耗材>办公用纸";
  raw.data.itemPublishVo.skuSpecMap["market-sku-3"] = [
    { attrName: "商品条形码", attrValue: "6900000000123" },
    { attrName: "包装", attrValue: "500张/包" },
    { attrName: "复印纸规格", attrValue: "A4" },
    { attrName: "克重", attrValue: "80" },
    { attrName: "颜色", attrValue: "白色" },
  ];
  Object.assign(raw.data.itemSkuInfoList[0], {
    skuName: "示例牌 7419 复印纸 A4/80g 500张/包 5包/箱 单位：箱",
    specAttributes:
      "商品条形码:6900000000123;包装:500张/包;复印纸规格:A4;克重:80;颜色:白色;",
  });
  source.title = fact("示例牌A4打印纸 80g500张*5包一箱 复印纸 整箱2500张 7419");
  source.specs["包装清单"] = fact("80gA4复印纸 ×1箱（5包）");
  source.specs["商品条码"] = fact("6900000000123");
  const result = compare(raw, source);
  assert.equal(result.matched, true, JSON.stringify(result.blockers));
  assert.equal(result.categoryMapping?.marketCategoryId, "10015");
  assert.equal(result.categoryMapping?.publishCategoryId, "10015007");
  assert.equal(result.categoryMapping?.barcode, "6900000000123");
  assert.match(
    result.categoryMapping?.marketEvidencePath ?? "",
    /specAttributes/u,
  );
  assert.equal(result.categoryMapping?.sourceEvidenceSpec, "商品条码");

  delete source.specs["商品条码"];
  assert.equal(compare(raw, source).matched, false);
});

test("copy-paper matching is leaf-category bounded and blocks every explicit conflict", () => {
  const base = copyPaperFixture();
  base.raw.data.itemPublishVo.cid = "10015";
  assert.equal(compare(base.raw, base.source).matched, false);

  for (const [field, value] of [
    ["克重", "70g"],
    ["颜色", "彩色"],
    ["纸张尺寸", "A3"],
    ["张数", "2000张"],
    ["规格", "4包装"],
  ] as const) {
    const { raw, source } = copyPaperFixture();
    raw.data.itemPublishVo.skuSpecMap["market-sku-3"].find(
      ({ attrName }) => attrName === field,
    )!.attrValue = value;
    raw.data.itemSkuInfoList[0].specAttributes =
      raw.data.itemSkuInfoList[0].specAttributes.replace(
        new RegExp(`${field}:[^;]+`),
        `${field}:${value}`,
      );
    assert.equal(compare(raw, source).matched, false, field);
  }

  const explicitModel = copyPaperFixture();
  explicitModel.raw.data.itemPublishVo.skuSpecMap["market-sku-3"].push({
    attrName: "型号",
    attrValue: "1234",
  });
  explicitModel.raw.data.itemSkuInfoList[0].specAttributes += "型号:1234;";
  assert.equal(compare(explicitModel.raw, explicitModel.source).matched, false);

  for (const [field, value] of [
    ["颜色", "米黄"],
    ["颜色", "灰白色"],
    ["纸张尺寸", "B5"],
    ["克重", "90"],
    ["规格", "6"],
  ] as const) {
    const { raw, source } = copyPaperFixture();
    raw.data.itemPublishVo.skuSpecMap["market-sku-3"].find(
      ({ attrName }) => attrName === field,
    )!.attrValue = value;
    raw.data.itemSkuInfoList[0].specAttributes =
      raw.data.itemSkuInfoList[0].specAttributes.replace(
        new RegExp(`${field}:[^;]+`),
        `${field}:${value}`,
      );
    assert.equal(compare(raw, source).matched, false, `${field}:${value}`);
  }
});

test("does not use another SKU's attributes or title to fill a missing selected fact", () => {
  const raw = payload();
  raw.data.itemPublishVo.skuSpecMap["market-sku-3"] = [
    { attrName: "规格", attrValue: "单支装" },
    { attrName: "净含量", attrValue: "10g" },
    { attrName: "香型", attrValue: "无香" },
  ];
  raw.data.itemSkuInfoList[0].modelCode = null as any;
  const result = compare(raw);
  assert.equal(result.matched, false);
  assert.ok(result.blockers.some((message) => message.includes("型号缺少")));
  assert.equal(
    result.fields.some((field) => field.field === "model"),
    false,
  );
});

test("blocks exact core mismatches without substring or inferred brand matching", () => {
  const raw = payload();
  raw.data.itemPublishVo.brandName = "清风旗舰店";
  raw.data.itemPublishVo.skuSpecMap["market-sku-3"][0].attrValue = "QF-A2";
  const result = compare(raw);
  assert.equal(result.matched, false);
  assert.ok(result.blockers.some((message) => message.includes("品牌缺失")));
  assert.ok(result.blockers.some((message) => message.startsWith("型号")));
});

test("accepts an explicit English brand alias but not an invented alias", () => {
  const raw = payload();
  raw.data.itemPublishVo.brandName = "清风官方店";
  (raw.data.itemPublishVo as any).brandNameEn = "Breeze";
  const source = product();
  source.specs.品牌 = fact(" breeze ");
  const syntaxMatch = compare(raw, source);
  assert.equal(syntaxMatch.matched, true, JSON.stringify(syntaxMatch.blockers));
  delete (raw.data.itemPublishVo as any).brandNameEn;
  assert.equal(compare(raw, source).matched, false);
});

test("matches a bounded gel pen pack across explicit count, unit, color, and nib width facts", () => {
  const raw = payload();
  raw.data.itemPublishVo.brandName = "示例MG";
  raw.data.itemPublishVo.categoryFullName = "办公用品>笔类>中性笔";
  raw.data.itemPublishVo.itemName =
    "示例MG 中性笔 GP7A 0.5mm 黑色 12支装 (单位:盒)";
  raw.data.itemPublishVo.skuSpecMap["market-sku-3"] = [
    { attrName: "型号", attrValue: "GP7A" },
    { attrName: "规格", attrValue: "12支装" },
    { attrName: "笔芯颜色", attrValue: "黑色" },
    { attrName: "书写粗细", attrValue: "0.5mm" },
  ];
  Object.assign(raw.data.itemSkuInfoList[0], {
    skuName: "示例MG 中性笔 GP7A 0.5mm 黑色 12支装 (单位:盒)",
    skuUnit: "盒",
    modelCode: "GP7A",
    specAttributes: "笔芯颜色:黑色;书写粗细:0.5mm;规格:12支装;型号:GP7A;",
    specAttributesList: [],
  });
  const source = product();
  source.title = fact("示例（MG）文具GP7A 0.5mm黑色中性笔 12支装/盒");
  source.specs = {
    品牌: fact("示例"),
    型号: fact("GP7A"),
    笔芯颜色: fact("黑色"),
    书写粗细: fact("0.5mm"),
    数量: fact("12支"),
    包装形式: fact("盒装"),
    京东销售规格: fact("GP7/黑色/12支装"),
    包装清单: fact("12支装/盒"),
  };
  const result = compare(raw, source);
  assert.equal(result.matched, true, JSON.stringify(result.blockers));
  assert.equal(
    result.fields.find((field) => field.field === "brand")?.marketValue,
    "示例",
  );
  assert.match(
    result.fields.find((field) => field.field === "packaging")?.marketValue ??
      "",
    /0\.5mm\|黑色\|12支\/盒/u,
  );
});

test("gel pen structured matching rejects explicit color, width, or count conflicts", () => {
  for (const [name, value] of [
    ["笔芯颜色", "蓝色"],
    ["书写粗细", "0.7mm"],
    ["数量", "10支"],
  ] as const) {
    const raw = payload();
    raw.data.itemPublishVo.brandName = "示例MG";
    raw.data.itemPublishVo.categoryFullName = "办公用品>笔类>中性笔";
    raw.data.itemPublishVo.itemName =
      "示例MG 中性笔 GP7A 0.5mm 黑色 12支装 (单位:盒)";
    raw.data.itemPublishVo.skuSpecMap["market-sku-3"] = [
      { attrName: "型号", attrValue: "GP7A" },
      { attrName: "规格", attrValue: "12支装" },
      { attrName: "笔芯颜色", attrValue: "黑色" },
      { attrName: "书写粗细", attrValue: "0.5mm" },
    ];
    Object.assign(raw.data.itemSkuInfoList[0], {
      skuName: "示例MG 中性笔 GP7A 0.5mm 黑色 12支装 (单位:盒)",
      skuUnit: "盒",
      modelCode: "GP7A",
      specAttributes: "笔芯颜色:黑色;书写粗细:0.5mm;规格:12支装;型号:GP7A;",
      specAttributesList: [],
    });
    const source = product();
    source.title = fact("示例文具GP7A 0.5mm黑色中性笔 12支装/盒");
    source.specs = {
      品牌: fact("示例"),
      型号: fact("GP7A"),
      笔芯颜色: fact(name === "笔芯颜色" ? value : "黑色"),
      书写粗细: fact(name === "书写粗细" ? value : "0.5mm"),
      数量: fact(name === "数量" ? value : "12支"),
      包装形式: fact("盒装"),
      京东销售规格: fact("GP7/黑色/12支装"),
      包装清单: fact("12支装/盒"),
    };
    assert.equal(compare(raw, source).matched, false, name);
  }
});

test("requires exact sole JD links for both the market SKU and every used source fact", () => {
  const market = payload();
  market.data.itemSkuInfoList[0].skuPicUrls.push({
    url: "https://item.jd.com/999999.html",
  });
  assert.ok(
    compare(market).blockers.some((message) => message.includes("有且仅有")),
  );

  const source = product();
  source.specs.型号 = fact("QF-A1", {
    sourceUrl: `https://foreign.example/${sku}.html`,
  });
  const result = compare(payload(), source);
  assert.equal(result.matched, false);
  assert.ok(result.blockers.some((message) => message.includes("证据链接")));
});

test("blocks stale market or source facts and never treats missing packaging as one", () => {
  assert.equal(
    compare(payload(), product(), "2026-09-20T02:59:59.999Z").matched,
    false,
  );
  const source = product();
  source.specs.型号 = fact("QF-A1", {
    capturedAt: "2026-09-20T02:59:59.999Z",
  });
  assert.equal(compare(payload(), source).matched, false);

  const noPack = payload();
  noPack.data.itemPublishVo.skuSpecMap["market-sku-3"] =
    noPack.data.itemPublishVo.skuSpecMap["market-sku-3"].filter(
      (entry) => entry.attrName !== "规格",
    );
  noPack.data.itemSkuInfoList[0].specAttributes = "净含量:10g;香型:无香;";
  noPack.data.itemSkuInfoList[0].specAttributesList = [];
  const result = compare(noPack);
  assert.equal(result.matched, false);
  assert.ok(
    result.blockers.some((message) => message.includes("销售包装缺少")),
  );
});

test("blocks missing material source facts and conflicting duplicate selected attributes", () => {
  const source = product();
  delete source.specs.香型;
  assert.ok(
    compare(payload(), source).blockers.some((message) =>
      message.includes("物料属性“香型”"),
    ),
  );

  const conflicting = payload();
  conflicting.data.itemPublishVo.skuSpecMap["market-sku-3"].push({
    attrName: "净含量",
    attrValue: "20g",
  });
  const result = compare(conflicting);
  assert.equal(result.matched, false);
  assert.ok(result.blockers.some((message) => message.includes("冲突值")));
});

test("keeps different unit expressions for manual review instead of converting them", () => {
  const raw = payload();
  raw.data.itemPublishVo.skuSpecMap["market-sku-3"].find(
    (entry) => entry.attrName === "净含量",
  )!.attrValue = "5kg";
  raw.data.itemSkuInfoList[0].specAttributes =
    "规格:单支装;净含量:5kg;香型:无香;";
  const source = product();
  source.specs.净含量 = fact("5000g");
  const result = compare(raw, source);
  assert.equal(result.matched, false);
  assert.ok(result.blockers.some((message) => message.includes("净含量")));
});

test("emits normalized core values while retaining raw evidence and uses the oldest evidence time", () => {
  const raw = payload();
  raw.data.itemPublishVo.skuSpecMap["market-sku-3"][0].attrValue = "M １";
  raw.data.itemSkuInfoList[0].modelCode = "M １";
  const source = product();
  source.specs.型号 = fact("m1", {
    capturedAt: "2026-09-20T03:30:00.000Z",
  });
  const result = compare(raw, source);
  const model = result.fields.find((field) => field.field === "model")!;
  assert.equal(result.matched, true);
  assert.equal(model.marketValue, "m1");
  assert.equal(model.sourceValue, "m1");
  assert.equal(model.marketEvidence?.value, "M １");
  assert.equal(model.sourceEvidence?.value, "m1");
  assert.equal(result.checkedAt, "2026-09-20T03:30:00.000Z");
});

test("ignores unscoped publish-level attributes and blocks placeholder core values", () => {
  const raw = payload();
  raw.data.itemPublishVo.specAttributes = [
    { attributeName: "型号", attributeValue: "QF-A1" },
    {
      skuId: "other-sku",
      attributeName: "规格",
      attributeValue: "单支装",
    },
  ] as any;
  raw.data.itemPublishVo.skuSpecMap["market-sku-3"] =
    raw.data.itemPublishVo.skuSpecMap["market-sku-3"].filter(
      (entry) => entry.attrName !== "型号",
    );
  raw.data.itemSkuInfoList[0].modelCode = null as any;
  assert.equal(
    compare(raw).fields.some((field) => field.field === "model"),
    false,
  );

  const placeholder = payload();
  placeholder.data.itemPublishVo.skuSpecMap["market-sku-3"][0].attrValue =
    "N/A";
  placeholder.data.itemSkuInfoList[0].modelCode = "N/A";
  const source = product();
  source.specs.型号 = fact("n/a");
  const result = compare(placeholder, source);
  assert.equal(result.matched, false);
  assert.ok(result.blockers.some((message) => message.includes("占位值")));
});

test("treats additional quantity and electrical attributes as material", () => {
  const raw = payload();
  raw.data.itemPublishVo.skuSpecMap["market-sku-3"].push(
    { attrName: "抽数", attrValue: "100抽" },
    { attrName: "功率", attrValue: "20W" },
  );
  const result = compare(raw);
  assert.equal(result.matched, false);
  assert.ok(result.blockers.some((message) => message.includes("抽数")));
  assert.ok(result.blockers.some((message) => message.includes("功率")));
});

test("plans exact candidate search only from explicit selected-SKU model evidence", () => {
  const raw = payload();
  raw.data.itemPublishVo.skuSpecMap["market-sku-3"][0] = {
    attrName: "商品型号",
    attrValue: "VS2056",
  };
  raw.data.itemSkuInfoList[0].modelCode = null as any;
  const plan = planSourceCandidateSearch({
    lane: "exact",
    marketPayload: raw,
    marketSkuId: "market-sku-3",
  });
  assert.deepEqual(plan.queries, ["清风 VS2056 单支装"]);
  assert.deepEqual(plan.blockers, []);

  const source = product();
  delete source.specs.型号;
  source.specs.商品型号 = fact("VS2056");
  assert.equal(
    compare(raw, source).fields.some((field) => field.field === "model"),
    true,
  );
});

test("keeps substitute searches explicitly separate and blocks inferred terms", () => {
  assert.deepEqual(
    planSourceCandidateSearch({
      lane: "substitute",
      marketPayload: payload(),
      marketSkuId: "market-sku-3",
    }).queries,
    [],
  );
  const plan = planSourceCandidateSearch({
    lane: "substitute",
    marketPayload: payload(),
    marketSkuId: "market-sku-3",
    explicitSubstituteTerms: ["抽纸 1层 200抽 20包"],
  });
  assert.equal(plan.lane, "substitute");
  assert.deepEqual(plan.queries, ["抽纸 1层 200抽 20包"]);
});

test("plans a bounded no-model search while exact comparison remains blocked", () => {
  const raw = payload();
  raw.data.itemSkuInfoList[0].skuName = "饮用水 380ml 24瓶";
  raw.data.itemPublishVo.skuSpecMap["market-sku-3"] =
    raw.data.itemPublishVo.skuSpecMap["market-sku-3"].filter(
      (entry) => entry.attrName !== "型号",
    );
  raw.data.itemSkuInfoList[0].modelCode = null as any;
  const plan = planSourceCandidateSearch({
    lane: "exact",
    marketPayload: raw,
    marketSkuId: "market-sku-3",
  });
  assert.deepEqual(plan.queries, ["清风 饮用水 380ml 24瓶 单支装"]);
  assert.deepEqual(plan.blockers, []);

  const source = product();
  delete source.specs.型号;
  const comparison = compare(raw, source);
  assert.equal(comparison.matched, false);
  assert.ok(
    comparison.blockers.some((message) => message.includes("型号缺少")),
  );
});

test("does not loosen incompatible carton and JD pack descriptions", () => {
  const raw = payload();
  raw.data.itemPublishVo.skuSpecMap["market-sku-3"].find(
    (entry) => entry.attrName === "规格",
  )!.attrValue = "200张 (单位:箱)";
  raw.data.itemSkuInfoList[0].specAttributes =
    "规格:200张 (单位:箱);净含量:10g;香型:无香;";
  raw.data.itemSkuInfoList[0].specAttributesList[0].attributeValue =
    "200张 (单位:箱)";
  const source = product();
  source.specs.京东销售规格 = fact("222*226mm【2056】1层200抽20包");
  const result = compare(raw, source);
  assert.equal(result.matched, false);
  assert.ok(result.blockers.includes("销售包装不一致"));
});

test("independent search receipt replaces only a missing link, not strict product facts", () => {
  const raw = payload();
  raw.data.itemSkuInfoList[0].skuPicUrls = [];
  const withoutReceipt = compare(raw);
  assert.equal(withoutReceipt.matched, false);
  const withReceipt = compareMarketSource(
    {
      marketPayload: raw,
      marketItemId: "market-item-9",
      marketSkuId: "market-sku-3",
      marketShopId: "market-shop-7",
      source: product(),
      detailReceiptId: "fabricated-detail-receipt",
      marketCheckedAt: at,
      candidateDiscovery: {
        receiptId: "fabricated-search-receipt",
        query: "清风 QF-A1 单支装",
      },
    },
    now,
  );
  assert.equal(withReceipt.matched, true);
});

test("normalizes multiplication glyph syntax without dropping package counts", () => {
  const raw = payload();
  raw.data.itemPublishVo.skuSpecMap["market-sku-3"].find(
    (entry) => entry.attrName === "规格",
  )!.attrValue = "2包×200抽";
  raw.data.itemSkuInfoList[0].specAttributes =
    "规格:2包*200抽;净含量:10g;香型:无香;";
  raw.data.itemSkuInfoList[0].specAttributesList[0].attributeValue =
    "2包*200抽";
  const source = product();
  source.specs.京东销售规格 = fact("2包*200抽");
  source.specs.包装清单 = fact("2包×200抽");
  const syntaxMatch = compare(raw, source);
  assert.equal(syntaxMatch.matched, true, JSON.stringify(syntaxMatch.blockers));

  source.specs.包装清单 = fact("200抽");
  const missingCount = compare(raw, source);
  assert.equal(missingCount.matched, false);
  assert.ok(
    missingCount.blockers.some((message) => message.includes("冲突的重复事实")),
  );
});

test("pack normalization preserves numeric multiplication and metric unit distinctions", () => {
  const raw = payload();
  const setMarketPack = (value: string) => {
    raw.data.itemPublishVo.skuSpecMap["market-sku-3"].find(
      (entry) => entry.attrName === "规格",
    )!.attrValue = value;
    raw.data.itemSkuInfoList[0].specAttributes = `规格:${value};净含量:10g;香型:无香;`;
    raw.data.itemSkuInfoList[0].specAttributesList[0].attributeValue = value;
  };
  const source = product();

  setMarketPack("22卷");
  source.specs.京东销售规格 = fact("2*2卷");
  assert.equal(compare(raw, source).matched, false);

  setMarketPack("240mm 12卷");
  source.specs.京东销售规格 = fact("240m*12卷");
  assert.equal(compare(raw, source).matched, false);

  setMarketPack("2层240米12卷");
  source.specs.京东销售规格 = fact("2层 240m*12卷");
  assert.equal(compare(raw, source).matched, true);
});

test("uses explicit item number as a model alias and normalizes complete pack syntax", () => {
  const raw = payload();
  raw.data.itemPublishVo.skuSpecMap["market-sku-3"] = [
    { attrName: "型号", attrValue: "AB07Q" },
  ];
  raw.data.itemSkuInfoList[0].modelCode = null as any;
  raw.data.itemSkuInfoList[0].attributesName = "型号:AB07Q;规格:2层240米12卷;";
  raw.data.itemSkuInfoList[0].specAttributes =
    "规格:2层240米12卷;净含量:10g;香型:无香;";
  raw.data.itemSkuInfoList[0].specAttributesList[0].attributeValue =
    "2层240米12卷";
  const source = product();
  delete source.specs.型号;
  source.specs.货号 = fact("AB07Q");
  source.specs.京东销售规格 = fact("2层 240m*12卷");
  const result = compare(raw, source);
  assert.equal(result.matched, true, JSON.stringify(result.blockers));
  assert.equal(
    result.fields.find((field) => field.field === "model")?.sourceEvidence
      ?.spec,
    "货号",
  );
});

test("does not equate a bare case count with a richer JD pack description", () => {
  const raw = payload();
  raw.data.itemPublishVo.skuSpecMap["market-sku-3"] = [
    { attrName: "型号", attrValue: "PX4491" },
  ];
  raw.data.itemSkuInfoList[0].modelCode = null as any;
  raw.data.itemSkuInfoList[0].attributesName = "型号:PX4491;规格:12卷装;";
  raw.data.itemSkuInfoList[0].specAttributes = "净含量:10g;香型:无香;";
  raw.data.itemSkuInfoList[0].specAttributesList = [];
  const source = product();
  delete source.specs.型号;
  source.specs.货号 = fact("PX4491");
  source.specs.京东销售规格 = fact("3层 805g*12卷 【商务装】");
  const result = compare(raw, source);
  assert.equal(result.matched, false);
  assert.ok(result.blockers.includes("销售包装不一致"));
});

test("an independently selected candidate must belong to any explicit market JD link set", () => {
  const raw = payload();
  raw.data.itemSkuInfoList[0].skuPicUrls = [
    { url: "https://item.jd.com/999991.html" },
    { url: jdUrl },
    { url: jdUrl },
  ];
  const input = {
    marketPayload: raw,
    marketItemId: "market-item-9",
    marketSkuId: "market-sku-3",
    marketShopId: "market-shop-7",
    source: product(),
    detailReceiptId: "fabricated-detail-receipt",
    marketCheckedAt: at,
    candidateDiscovery: {
      receiptId: "fabricated-search-receipt",
      query: "清风 QF-A1 单支装",
    },
  };
  assert.equal(compareMarketSource(input, now).matched, true);

  const outside = product();
  outside.sku = "888888";
  outside.url = "https://item.jd.com/888888.html";
  for (const factValue of [outside.title, ...Object.values(outside.specs)])
    factValue.sourceUrl = outside.url;
  const rejected = compareMarketSource({ ...input, source: outside }, now);
  assert.equal(rejected.matched, false);
  assert.ok(
    rejected.blockers.some((message) => message.includes("已有京东来源链接")),
  );

  raw.data.itemSkuInfoList[0].skuPicUrls.push({
    url: "https://evil.example/1",
  });
  assert.equal(compareMarketSource(input, now).matched, false);
});

test("matches a Chinese brand to its trailing Latin parenthetical name only", () => {
  const raw = payload();
  raw.data.itemPublishVo.brandName = "示例牌（Example）";
  const source = product();
  source.specs.品牌 = fact("示例牌");
  assert.equal(compare(raw, source).matched, true);

  raw.data.itemPublishVo.brandName = "示例牌（APP）";
  assert.equal(compare(raw, source).matched, false);

  raw.data.itemPublishVo.brandName = "示例牌（Example）";
  source.specs.品牌 = fact("示例牌（Different）");
  assert.equal(compare(raw, source).matched, false);
});

test("long-tail clip packs match only when type size color count and sale unit are explicit", () => {
  const make = (
    marketTitle: string,
    sourcePack: string,
    overrides: {
      marketSpec?: string;
      marketPackingList?: string;
      sourceSalesSpec?: string;
      sourceColor?: string;
      sourcePackFact?: Partial<Product["title"]>;
      sourceTitleFact?: Partial<Product["title"]>;
    } = {},
  ) => {
    const raw = payload();
    raw.data.itemPublishVo.itemName = marketTitle;
    raw.data.itemPublishVo.packingList = overrides.marketPackingList ?? null;
    raw.data.itemPublishVo.skuSpecMap["market-sku-3"] = [
      { attrName: "型号", attrValue: "X54" },
    ];
    raw.data.itemSkuInfoList[0].modelCode = null as any;
    raw.data.itemSkuInfoList[0].skuName = marketTitle;
    raw.data.itemSkuInfoList[0].skuUnit = "筒";
    raw.data.itemSkuInfoList[0].attributesName =
      overrides.marketSpec ?? "类型:长尾夹;规格:48只装;型号:X54;";
    raw.data.itemSkuInfoList[0].specAttributes = "净含量:10g;香型:无香;";
    raw.data.itemSkuInfoList[0].specAttributesList = [];
    const source = product();
    delete source.specs.型号;
    source.specs.货号 = fact("X54");
    source.title = fact(sourcePack, overrides.sourceTitleFact);
    source.specs.包装清单 = fact(sourcePack, overrides.sourcePackFact);
    source.specs.京东销售规格 = fact(overrides.sourceSalesSpec ?? sourcePack);
    if (overrides.sourceColor) source.specs.颜色 = fact(overrides.sourceColor);
    return compare(raw, source);
  };

  assert.equal(
    make(
      "示例牌 X54 彩色长尾夹 25MM 48只/筒 单位：筒",
      "示例牌X54彩色长尾票夹25mm筒装(混)(48只/筒)",
    ).matched,
    true,
  );
  for (const sourcePack of [
    "示例牌X54彩色长尾票夹32mm筒装(混)(48只/筒)",
    "示例牌X54黑色长尾票夹25mm筒装(48只/筒)",
    "示例牌X54彩色长尾票夹25mm筒装(混)(24只/筒)",
    "示例牌X54彩色长尾票夹25mm盒装(混)(48只/盒)",
    "示例牌X54彩色长尾票夹25mm筒装",
  ]) {
    const result = make(
      "示例牌 X54 彩色长尾夹 25MM 48只/筒 单位：筒",
      sourcePack,
    );
    assert.equal(result.matched, false, sourcePack);
    assert.ok(result.blockers.some((message) => message.includes("销售包装")));
  }

  for (const result of [
    make(
      "示例牌 X54 彩色长尾夹 25MM 60只/筒 单位：筒",
      "示例牌X54彩色长尾票夹25mm筒装(60只/筒)",
      { marketSpec: "类型:长尾夹;规格:48只装;型号:X54;" },
    ),
    make(
      "示例牌 X54 彩色长尾夹 25MM 48只/筒 单位：筒",
      "示例牌X54彩色长尾票夹25mm筒装(48只/筒)",
      {
        marketSpec: "类型:长尾夹;规格:48只装;尺寸:32mm;型号:X54;",
      },
    ),
    make(
      "示例牌 X54 彩色长尾夹 25MM 48只/筒 单位：筒",
      "示例牌X54彩色长尾票夹25mm筒装(48只/筒)",
      { sourceSalesSpec: "彩色长尾票夹25mm 60只装" },
    ),
    make(
      "示例牌 X54 彩色长尾夹 25MM 48只/筒 单位：筒",
      "示例牌X54彩色长尾票夹25mm筒装(48只/筒)",
      { sourceSalesSpec: "60只25mm小号彩色票夹" },
    ),
    make(
      "示例牌 X54 彩色长尾夹 25MM 48只/筒 单位：筒",
      "示例牌X54彩色长尾票夹25mm筒装(48只/筒)",
      { sourceSalesSpec: "彩色长尾票夹25mm 48只/盒" },
    ),
    make(
      "示例牌 X54 彩色长尾夹 25MM 48只/筒 单位：筒",
      "示例牌X54彩色长尾票夹25mm筒装(48只/筒)",
      { sourceColor: "黑色" },
    ),
    make(
      "示例牌 X54 彩色长尾夹 25MM 48只/筒 单位：筒",
      "示例牌X54彩色长尾票夹25mm筒装(48只/筒)",
      { marketPackingList: "彩色长尾夹32mm 48只/筒" },
    ),
    make(
      "示例牌 X54 彩色长尾夹 25MM 48只/筒 单位：筒",
      "示例牌X54彩色长尾票夹25mm筒装",
      { sourceSalesSpec: "彩色长尾票夹25mm 48只/筒" },
    ),
  ]) {
    assert.equal(result.matched, false);
    assert.ok(result.blockers.some((message) => message.includes("销售包装")));
  }

  const matched = make(
    "示例牌 X54 彩色长尾夹 25MM 60只/筒 单位：筒",
    "示例牌X54彩色长尾票夹25mm筒装(60只/筒)",
    { marketSpec: "类型:长尾夹;规格:60个装;型号:X54;" },
  );
  assert.equal(matched.matched, true);
  const evidence = matched.fields.find((field) => field.field === "packaging");
  assert.match(evidence?.marketEvidence?.path ?? "", /skuName/u);
  assert.match(evidence?.marketEvidence?.path ?? "", /attributesName/u);
  assert.equal(evidence?.sourceEvidence?.spec, "包装清单");
  assert.equal(
    evidence?.sourceEvidence?.value,
    "示例牌X54彩色长尾票夹25mm筒装(60只/筒)",
  );

  for (const result of [
    make(
      "示例牌 X54 彩色长尾夹 25MM 48只/筒 单位：筒",
      "示例牌X54彩色长尾票夹25mm筒装(48只/筒)",
      { sourcePackFact: { sourceUrl: "https://item.jd.com/999999.html" } },
    ),
    make(
      "示例牌 X54 彩色长尾夹 25MM 48只/筒 单位：筒",
      "示例牌X54彩色长尾票夹25mm筒装(48只/筒)",
      { sourcePackFact: { capturedAt: "2026-09-20T02:00:00.000Z" } },
    ),
    make(
      "示例牌 X54 彩色长尾夹 25MM 48只/筒 单位：筒",
      "示例牌X54彩色长尾票夹25mm筒装(48只/筒)",
      { sourceTitleFact: { capturedAt: "2026-09-20T02:00:00.000Z" } },
    ),
  ]) {
    assert.equal(result.matched, false);
    assert.ok(
      result.blockers.some((message) => /链接不匹配|超过1小时/u.test(message)),
    );
  }
});

test("archive boxes compare paper format, spine width, color, and item count as separate facts", () => {
  const make = (
    overrides: {
      marketWidth?: string;
      marketColor?: string;
      marketCount?: string;
      marketFormat?: string;
      marketMaterial?: string;
      sourceSales?: string;
      sourcePack?: string;
      sourceTitle?: string;
      sourceFormat?: string;
      sourceSalesFact?: Partial<Product["title"]>;
      sourceMaterial?: string;
      sourceColor?: string;
      sourceDimension?: string;
    } = {},
  ) => {
    const raw = payload();
    const width = overrides.marketWidth ?? "35mm";
    const color = overrides.marketColor ?? "蓝色";
    const count = overrides.marketCount ?? "单个装";
    const material = overrides.marketMaterial ?? "PP";
    raw.data.itemPublishVo.categoryFullName =
      "办公用品>办公文具>收纳管理用品>档案盒/资料盒";
    raw.data.itemPublishVo.brandName = "示例牌";
    raw.data.itemPublishVo.itemName = `示例牌 A22 档案盒/资料盒 ${overrides.marketFormat ?? ""} ${width} ${count} (单位:个)`;
    raw.data.itemPublishVo.skuSpecMap["market-sku-3"] = [
      { attrName: "颜色", attrValue: color },
    ];
    raw.data.itemSkuInfoList[0].skuName = raw.data.itemPublishVo.itemName;
    raw.data.itemSkuInfoList[0].skuUnit = "个";
    raw.data.itemSkuInfoList[0].modelCode = null as any;
    raw.data.itemSkuInfoList[0].attributesName = null as any;
    raw.data.itemSkuInfoList[0].specAttributes = `规格:${count};型号:A22;尺寸规格:${width};材质:${material};颜色:${color};`;
    raw.data.itemSkuInfoList[0].specAttributesList = [];

    const source = product();
    source.title = fact(
      overrides.sourceTitle ?? "示例牌35mmA4塑料文件盒资料盒 A22",
    );
    source.specs = {
      品牌: fact("示例牌"),
      货号: fact("A22"),
      材质: fact(overrides.sourceMaterial ?? "PP"),
      ...(overrides.sourceColor ? { 颜色: fact(overrides.sourceColor) } : {}),
      ...(overrides.sourceDimension
        ? { 尺寸规格: fact(overrides.sourceDimension) }
        : {}),
      规格: fact(overrides.sourceFormat ?? "A4"),
      包装清单: fact(overrides.sourcePack ?? "A22档案盒 × １个"),
      京东销售规格: fact(
        overrides.sourceSales ?? "【35mm侧宽】蓝色-纯PP材质",
        overrides.sourceSalesFact,
      ),
    };
    return compare(raw, source);
  };

  const exact = make();
  assert.equal(exact.matched, true, exact.blockers.join("；"));
  assert.equal(
    exact.fields.find((field) => field.field === "packaging")?.sourceEvidence
      ?.value,
    "A22档案盒 × １个",
  );
  assert.deepEqual(
    exact.fields
      .find((field) => field.field === "packaging")
      ?.sourceEvidence?.participants?.map((participant) => participant.spec),
    ["商品标题", "京东销售规格", "包装清单", "规格", "材质"],
  );

  for (const result of [
    make({ marketWidth: "55mm" }),
    make({ marketColor: "红色" }),
    make({ marketCount: "2个装" }),
    make({ marketFormat: "A3" }),
    make({ marketMaterial: "PVC" }),
    make({ sourceMaterial: "PVC" }),
    make({ sourceColor: "红色" }),
    make({ sourceDimension: "55mm" }),
    make({ sourceSales: "【55mm侧宽】蓝色-纯PP材质" }),
    make({ sourceSales: "【35mm侧宽】红色-纯PP材质" }),
    make({ sourceSales: "【35mm侧宽】-纯PP材质" }),
    make({ sourcePack: "A22档案盒 × 2个" }),
    make({ sourcePack: "A22档案盒" }),
    make({ sourceTitle: "示例牌35mmA4塑料文件盒资料盒2只装 A22" }),
    make({ sourceTitle: "示例牌35mmA3塑料文件盒资料盒 A22" }),
    make({ sourceFormat: "A3" }),
    make({
      sourceSalesFact: { sourceUrl: "https://item.jd.com/999999.html" },
    }),
    make({
      sourceSalesFact: { capturedAt: "2026-09-20T02:00:00.000Z" },
    }),
  ]) {
    assert.equal(result.matched, false);
    assert.ok(result.blockers.some((message) => message.includes("销售包装")));
  }
});
