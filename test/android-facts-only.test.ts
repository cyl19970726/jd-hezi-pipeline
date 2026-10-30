import assert from "node:assert/strict";
import test from "node:test";
import { completeAndroid } from "../src/android-complete.js";
import type { Product } from "../src/model.js";
import { Store } from "../src/store.js";

const title = "超长且唯一的京东商品标题用于补参数流程前后身份核验测试";
const at = "2026-09-16T01:00:00.000Z";
const fact = (value: string) => ({
  value,
  sourceUrl: "https://item.jd.com/123.html",
  capturedAt: at,
  evidence: "test evidence",
});
const product = (): Product => ({
  sku: "123",
  variant: "",
  url: "https://item.jd.com/123.html",
  title: fact(title),
  price: { ...fact("29.90"), basis: "jd-price" },
  specs: {
    京东销售规格: fact("500mL 2瓶"),
    包装清单: fact("蚊香液×2"),
  },
  assets: [],
  capturedAt: at,
});

const node = (attributes: Record<string, string>) =>
  `<node ${Object.entries(attributes)
    .map(([key, value]) => `${key}="${value}"`)
    .join(" ")} />`;
const hierarchy = (...nodes: string[]) =>
  `<hierarchy>${nodes.join("")}</hierarchy>`;
const mainXml = hierarchy(
  node({ "content-desc": "已选中款式 500mL 2瓶" }),
  node({ text: title, "content-desc": title, clickable: "true" }),
);
const detailXml = hierarchy(
  node({ text: "商品编号" }),
  node({ text: "123" }),
  node({ text: "包装清单" }),
  node({ text: "蚊香液×2" }),
  node({ "content-desc": "目录", bounds: "[0,100][100,200]" }),
  node({ "content-desc": "返回顶部", bounds: "[900,1800][1000,1900]" }),
);
const menuXml = hierarchy(
  node({
    text: "规格参数",
    "resource-id": "com.jd.lib.productdetail.feature:id/nd",
    bounds: "[0,200][200,300]",
  }),
);
const collapsedSpecXml = hierarchy(
  node({ text: "商品编号" }),
  node({ text: "123" }),
  node({
    text: "展开",
    "resource-id": "btn-showFullSpecification",
    bounds: "[0,300][200,400]",
  }),
);
const expandedSpecXml = hierarchy(
  node({ text: "品牌" }),
  node({ text: "测试品牌" }),
  node({ text: "商品编号" }),
  node({ text: "123" }),
  node({ text: "香型" }),
  node({ text: "清新茉莉香" }),
  node({ text: "保质期" }),
  node({ text: "三年" }),
  node({ text: "店内优选" }),
);

function factsSession(overrides: Record<string, unknown> = {}) {
  const calls: string[] = [];
  const session = {
    dir: "/unused",
    async tap() {
      calls.push("tap");
    },
    async run(args: string[]) {
      calls.push("run:" + args.join(" "));
      return "";
    },
    async wait(name: string, predicate: (xml: string) => boolean) {
      calls.push("wait:" + name);
      const xml = name === "directory" ? menuXml : mainXml;
      assert.equal(predicate(xml), true, `predicate failed for ${name}`);
      return xml;
    },
    async dump(name: string) {
      calls.push("dump:" + name);
      if (name === "specification") return collapsedSpecXml;
      if (name === "specification-expanded") return expandedSpecXml;
      if (name === "before-top") return detailXml;
      return detailXml;
    },
    async screenshot() {
      throw new Error("facts-only must not take screenshots");
    },
    async saveViewer() {
      throw new Error("facts-only must not save viewer images");
    },
    async album() {
      throw new Error("facts-only must not inspect the album");
    },
    ...overrides,
  };
  return { session, calls };
}

test("facts-only reads expanded parameters and package facts without price or media work", async () => {
  const store = new Store(":memory:");
  try {
    store.setMeta("android-capture:ours:123", { preserved: true });
    const { session, calls } = factsSession();
    const result = await completeAndroid(
      store,
      "ours",
      "/unused",
      session as any,
      product(),
      mainXml,
      { factsOnly: true },
      detailXml,
    );
    assert.equal(result.price, null);
    assert.deepEqual(result.assets, []);
    assert.equal(result.specs["香型"].value, "清新茉莉香");
    assert.equal(result.specs["保质期"].value, "三年");
    assert.equal(result.specs["包装名称"].value, "蚊香液");
    assert.equal(result.specs["包装数量"].value, "2");
    assert.equal(result.specs["规格"].value, "2瓶装");
    assert.equal(result.specs["总净含量"].value, "1000mL");
    assert.deepEqual(store.meta("android-capture:ours:123"), {
      preserved: true,
    });
    assert.equal(
      calls.some((call) => call.includes("screenshot")),
      false,
    );
  } finally {
    store.close();
  }
});

test("facts-only fails closed on a foreign detail SKU before interacting", async () => {
  const store = new Store(":memory:");
  try {
    const { session, calls } = factsSession();
    await assert.rejects(
      completeAndroid(
        store,
        "ours",
        "/unused",
        session as any,
        product(),
        mainXml,
        { factsOnly: true },
        detailXml.replace('text="123"', 'text="999"'),
      ),
      /详情商品编号.*SKU/,
    );
    assert.deepEqual(calls, []);
  } finally {
    store.close();
  }
});

test("facts-only fails closed when the selected variant changed", async () => {
  const store = new Store(":memory:");
  try {
    const { session, calls } = factsSession();
    await assert.rejects(
      completeAndroid(
        store,
        "ours",
        "/unused",
        session as any,
        product(),
        mainXml.replace("500mL 2瓶", "300mL 1瓶"),
        { factsOnly: true },
        detailXml,
      ),
      /所选规格已改变/,
    );
    assert.deepEqual(calls, []);
  } finally {
    store.close();
  }
});

test("price-only and facts-only are mutually exclusive", async () => {
  const store = new Store(":memory:");
  try {
    const { session, calls } = factsSession();
    await assert.rejects(
      completeAndroid(
        store,
        "ours",
        "/unused",
        session as any,
        product(),
        mainXml,
        { priceOnly: true, factsOnly: true },
        detailXml,
      ),
      /不能同时请求/,
    );
    assert.deepEqual(calls, []);
  } finally {
    store.close();
  }
});
