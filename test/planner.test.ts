import { test } from "node:test";
import assert from "node:assert/strict";
import { Catalog } from "../src/catalog.js";
import { example } from "../src/demo.js";
import { kilograms, optionalTemplateSpecs, Planner } from "../src/planner.js";
import { Store } from "../src/store.js";
import { expectedFields, planSchema } from "../src/model.js";

function buildWithBrands(
  sourceBrand: string,
  catalogBrand: string,
  titleRule?: {
    mode: "platform-generated";
    parts: string[];
    separator: " ";
  },
  categoryPath = "类目",
) {
  const store = new Store(":memory:");
  const planner = new Planner(store);
  const now = new Date().toISOString();
  new Catalog(store).import({
    shop: "ours",
    categories: [
      {
        id: "leaf",
        parentId: null,
        name: categoryPath,
        path: categoryPath,
        selectable: true,
        sourceUrl: "https://b.csgmall.com.cn/",
        checkedAt: now,
      },
    ],
    brands: [
      {
        id: "brand",
        name: catalogBrand,
        sourceUrl: "https://b.csgmall.com.cn/",
        checkedAt: now,
      },
    ],
    grants: [
      {
        id: "grant",
        brandId: "brand",
        status: "approved",
        validFrom: new Date(Date.now() - 60_000).toISOString(),
        validUntil: new Date(Date.now() + 86_400_000).toISOString(),
        scopes: [{ categoryId: "leaf", descendants: false }],
        sourceUrl: "https://b.csgmall.com.cn/",
        checkedAt: now,
      },
    ],
  });
  planner.importTemplate("ours", "leaf", {
    categoryId: "leaf",
    specs: titleRule ? ["尺寸规格", "规格"] : ["规格"],
    ...(titleRule
      ? {
          fields: [
            { id: "size", name: "尺寸规格", required: true, selectType: "3" },
            { id: "spec", name: "规格", required: true, selectType: "3" },
          ],
          titleRule,
        }
      : {}),
    sourceUrl: "https://b.csgmall.com.cn/shop-view/",
    checkedAt: now,
  });
  planner.importPolicy("ours", "policy", {
    inventory: "1",
    logistics: {
      sourceItemId: "1",
      checkedAt: now,
      templateId: "1",
      templateName: "默认模板",
      addressIds: ["1"],
      areas: [{ areaId: "1", areaName: "全国" }],
    },
    sourceUrl: "https://b.csgmall.com.cn/",
    checkedAt: now,
  });
  const { product } = example();
  const fact = (value: string) => ({ ...product.title, value });
  product.specs = {
    品牌: fact(sourceBrand),
    尺寸规格: fact("35mm"),
    规格: fact("单件装"),
    商品毛重: fact("1kg"),
    包装名称: fact("盒"),
    包装数量: fact("1"),
  };
  try {
    return planner.build("ours", product, "brand", "leaf", "policy", "件");
  } finally {
    store.close();
  }
}
test("JD weight units normalize without inventing a unit for bare numbers", () => {
  assert.equal(kilograms("0.106kg"), "0.106");
  assert.equal(kilograms("106克"), "0.106");
  assert.equal(kilograms("1.2 kg"), "1.2");
  assert.throws(() => kilograms("106"));
  assert.throws(() => kilograms("0kg"));
});

test("planner fills required stationery customization from approved shop policy without changing source facts", () => {
  const store = new Store(":memory:");
  try {
    const now = new Date().toISOString();
    const planner = new Planner(store);
    new Catalog(store).import({
      shop: "ours",
      categories: [
        {
          id: "stationery",
          parentId: null,
          name: "中性笔",
          path: "办公用品 > 办公文具 > 书写工具 > 中性笔",
          selectable: true,
          sourceUrl: "https://b.csgmall.com.cn/",
          checkedAt: now,
        },
      ],
      brands: [
        {
          id: "brand",
          name: "示例品牌",
          sourceUrl: "https://b.csgmall.com.cn/",
          checkedAt: now,
        },
      ],
      grants: [
        {
          id: "grant",
          brandId: "brand",
          status: "approved",
          validFrom: new Date(Date.now() - 60_000).toISOString(),
          validUntil: new Date(Date.now() + 86_400_000).toISOString(),
          scopes: [{ categoryId: "stationery", descendants: false }],
          sourceUrl: "https://b.csgmall.com.cn/",
          checkedAt: now,
        },
      ],
    });
    planner.importTemplate("ours", "stationery", {
      categoryId: "stationery",
      specs: ["规格", "是否可定制"],
      fields: [
        { id: "spec", name: "规格", required: true, selectType: "3" },
        { id: "custom", name: "是否可定制", required: true, selectType: "1" },
      ],
      sourceUrl: "https://b.csgmall.com.cn/shop-view/",
      checkedAt: now,
    });
    planner.importPolicy("ours", "policy", {
      inventory: "1",
      logistics: {
        sourceItemId: "1",
        checkedAt: now,
        templateId: "1",
        templateName: "默认模板",
        addressIds: ["1"],
        areas: [{ areaId: "1", areaName: "全国" }],
      },
      sourceUrl: "https://b.csgmall.com.cn/",
      checkedAt: now,
    });
    store.setMeta("listing-customization-policy:ours", {
      version: 1,
      scope: "office-stationery",
      value: "不可定制",
      approvedAt: now,
      approval: "用户明确授权：普通文具统一不提供定制服务",
    });
    const { product } = example();
    const fact = (value: string) => ({ ...product.title, value });
    product.specs = {
      品牌: fact("示例品牌"),
      规格: fact("12支装"),
      商品毛重: fact("1kg"),
      包装名称: fact("中性笔"),
      包装数量: fact("12"),
    };
    const before = structuredClone(product);
    const plan = planner.build(
      "ours",
      product,
      "brand",
      "stationery",
      "policy",
      "盒",
    );
    assert.equal(plan.specs["是否可定制"].value, "不可定制");
    assert.equal(
      plan.specs["是否可定制"].sourceUrl,
      "http://127.0.0.1:4317/opportunity-execution",
    );
    assert.match(plan.specs["是否可定制"].evidence, /本店用户授权销售政策/);
    assert.deepEqual(product, before);
    assert.equal(product.specs["是否可定制"], undefined);
  } finally {
    store.close();
  }
});

test("planner mirrors a verified platform-generated title rule without appending a unit", () => {
  const plan = buildWithBrands("示例戊品牌", "示例戊品牌（Deli）", {
    mode: "platform-generated",
    parts: ["品牌", "类目名称", "尺寸规格", "规格", "计价单位"],
    separator: " ",
  });
  const { product } = example();
  assert.equal(plan.titleMode, "platform-generated");
  assert.equal(
    plan.displayTitle?.value,
    "示例戊品牌（Deli） 类目 35mm 单件装 件",
  );
  assert.equal(
    expectedFields(product, plan).title,
    "示例戊品牌（Deli） 类目 35mm 单件装 件",
  );
  assert.match(plan.displayTitle?.evidence ?? "", /模板来源/);
});

test("platform title preserves a slash inside the verified category leaf", () => {
  const plan = buildWithBrands(
    "示例牌",
    "示例牌",
    {
      mode: "platform-generated",
      parts: ["品牌", "类目名称", "尺寸规格", "规格", "计价单位"],
      separator: " ",
    },
    "办公文具 > 档案盒/资料盒",
  );
  const { product } = example();
  assert.equal(
    expectedFields(product, plan).title,
    "示例牌 档案盒/资料盒 35mm 单件装 件",
  );
});

test("legacy plans retain an absent title mode when parsed", () => {
  const { plan } = example();
  delete (plan as { titleMode?: string }).titleMode;
  const parsed = planSchema.parse(plan);
  assert.equal("titleMode" in parsed, false);
});

test("planner uses the same conservative Chinese and Latin brand identity", () => {
  assert.equal(
    buildWithBrands("示例戊品牌", "示例戊品牌（Deli）").brand,
    "示例戊品牌（Deli）",
  );
  assert.equal(
    buildWithBrands("示例戊品牌（Deli）", "示例戊品牌").brand,
    "示例戊品牌",
  );
  assert.throws(
    () => buildWithBrands("示例丁品牌", "示例戊品牌（Deli）"),
    /来源品牌与所选授权品牌不一致/u,
  );
  assert.throws(
    () => buildWithBrands("示例戊品牌（APP）", "示例戊品牌"),
    /来源品牌与所选授权品牌不一致/u,
  );
  assert.throws(
    () => buildWithBrands("示例戊品牌（M&G）", "示例戊品牌（Deli）"),
    /来源品牌与所选授权品牌不一致/u,
  );
});

test("template import rejects mismatched or malformed evidence without replacing the previous schema", () => {
  const s = new Store(":memory:"),
    p = new Planner(s);
  try {
    const template = {
      categoryId: "123",
      specs: ["规格"],
      fields: [{ id: "1", name: "规格", required: true, selectType: "3" }],
      sourceUrl: "https://b.csgmall.com.cn/shop-view/",
      checkedAt: new Date().toISOString(),
    };
    p.importTemplate("ours", "123", template);
    for (const bad of [
      { ...template, categoryId: "456" },
      { ...template, specs: ["规格", "规格"] },
      { ...template, specs: ["净含量"] },
      { ...template, fields: [...template.fields, ...template.fields] },
      { ...template, checkedAt: "invalid" },
      { ...template, checkedAt: "2100-01-01T00:00:00Z" },
      { ...template, sourceUrl: "https://example.com/" },
      {
        ...template,
        titleRule: {
          mode: "platform-generated",
          parts: ["品牌", "型号"],
          separator: " ",
        },
      },
      {
        ...template,
        fields: [
          ...template.fields,
          { id: "2", name: "尺寸规格", required: false, selectType: "3" },
        ],
        titleRule: {
          mode: "platform-generated",
          parts: ["品牌", "类目名称", "尺寸规格", "规格"],
          separator: " ",
        },
      },
    ])
      assert.throws(() => p.importTemplate("ours", "123", bad));
    assert.deepEqual(
      JSON.parse(
        String(
          s.db.prepare("SELECT template FROM category_templates").get()
            ?.template,
        ),
      ),
      template,
    );
  } finally {
    s.close();
  }
});

test("legacy required-name templates remain readable without fabricated field metadata", () => {
  const s = new Store(":memory:"),
    p = new Planner(s);
  try {
    const template = {
      specs: ["规格"],
      sourceUrl: "https://b.csgmall.com.cn/shop-view/",
      checkedAt: new Date().toISOString(),
    };
    p.importTemplate("ours", "123", template);
    assert.deepEqual(
      JSON.parse(
        String(
          s.db.prepare("SELECT template FROM category_templates").get()
            ?.template,
        ),
      ),
      template,
    );
  } finally {
    s.close();
  }
});

test("optional template fields retain only sourced non-placeholder facts", () => {
  const fact = (value: string) => ({
    value,
    sourceUrl: "https://item.jd.com/1001.html",
    capturedAt: new Date().toISOString(),
    evidence: "京东规格参数",
  });
  const specs = {
    保质期: fact("3年"),
    "国产/进口": fact("国产"),
    农药登记证号: fact("WP20080230"),
    型号: fact("暂无"),
    香型: fact("无香型"),
  };
  const fields = [
    { name: "规格", required: true },
    { name: "保质期", required: false },
    { name: "国产/进口", required: false },
    { name: "农药登记证号", required: false },
    { name: "型号", required: false },
    { name: "香型", required: false },
    { name: "适用对象", required: false },
  ];
  assert.deepEqual(optionalTemplateSpecs(specs, fields), {
    保质期: specs.保质期,
    "国产/进口": specs["国产/进口"],
    农药登记证号: specs.农药登记证号,
    香型: specs.香型,
  });
  assert.deepEqual(optionalTemplateSpecs(specs), {});
});
