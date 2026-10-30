import { test } from "node:test";
import assert from "node:assert/strict";
import { parseHTML } from "linkedom";
import {
  readRows,
  readPage,
  readFields,
  readJd,
  openJdPriceDetails,
} from "../src/browser/extractors.js";
function dom(html: string, host = "b.csgmall.com.cn") {
  const { document } = parseHTML(
    `<html><head><title>测试</title></head><body>${html}</body></html>`,
  );
  Object.assign(globalThis, {
    document,
    location: { hostname: host, href: `https://${host}/`, pathname: "/" },
  });
  return document;
}
test("table parser uses headers, primary status and link identity, not row position", () => {
  dom(
    `<div class="ant-table-wrapper"><table><thead><tr><th>商品信息</th><th>状态</th><th>商品编码</th><th>所属类目</th></tr></thead><tbody><tr><td>预览<a href="/detail?itemId=123">商品 A</a></td><td><span class="ant-tag">待审核</span><span class="ant-tag">品牌审核通过</span></td><td>456</td><td>测试</td></tr></tbody></table></div><li class="ant-pagination-next ant-pagination-disabled"></li>`,
  );
  const r = readRows();
  assert.equal(r.records[0].itemId, "123");
  assert.equal(r.records[0].code, "456");
  assert.equal(r.records[0].status, "待审核");
  assert.equal(r.records[0].title, "商品 A");
  assert.equal(r.nextAvailable, false);
});
test("missing remote identity remains empty instead of inventing itemId from code", () => {
  dom(
    "<table><thead><tr><th>商品信息</th><th>状态</th><th>商品编码</th></tr></thead><tbody><tr><td>商品 A</td><td>草稿</td><td>456</td></tr><tr><td>预览</td><td>草稿</td><td>标题误作编码</td></tr></tbody></table>",
  );
  assert.equal(readRows().records.length, 1);
  assert.equal(readRows().records[0].itemId, "");
});
test("JD positive account evidence wins over incidental login text", () => {
  dom('<div class="nickname">测试账号</div><a>请登录</a>', "www.jd.com");
  assert.equal(readPage().auth, "authenticated");
  assert.equal(readPage().login, false);
});
test("JD frequency redirect is risk even with a visible signed-in account", () => {
  dom(
    '<div class="nickname">测试账号</div>暂时无法展示该商品的信息，请稍后重试',
    "pc-frequent-pro.pf.jd.com",
  );
  assert.equal(readPage().auth, "authenticated");
  assert.equal(readPage().risk, true);
});
test("homepage without account evidence is unknown, passport is login required", () => {
  dom("<a>请登录</a>", "www.jd.com");
  assert.equal(readPage().auth, "unknown");
  dom("扫码登录", "passport.jd.com");
  assert.equal(readPage().auth, "login_required");
});
test("account change dialog invalidates a previously visible shop identity", () => {
  dom(
    '<div class="ant-select-selection-item">国内店 | 店铺（启用）</div><div role="dialog">登录账号发生变更</div>',
  );
  assert.equal(readPage().accountChanged, true);
});
test("draft identity is extracted from a span href without inventing from its code", () => {
  dom(
    '<table><thead><tr><th>商品信息</th><th>状态</th><th>商品编码</th></tr></thead><tbody><tr><td><span href="/detail?itemId=123">商品</span></td><td>草稿</td><td>456</td></tr></tbody></table>',
  );
  assert.equal(readRows().records[0].itemId, "123");
});
test("specification labels can be readonly inputs with separate required stars", () => {
  dom(
    '<div class="ant-tabs-tabpane">规格名称<table><tr><td><span>*</span><input value="加热器数量" readonly></td><td><input value=""></td></tr></table></div>',
  );
  assert.deepEqual(readFields().requiredMissing, ["加热器数量"]);
  assert.equal(readFields().specs["加热器数量"], "");
});
test("specification Ant Select reads its selected label and required state", () => {
  dom(
    '<div class="ant-tabs-tabpane">规格名称<table><tr><td><span>*</span><input value="国产/进口" readonly></td><td><div class="ant-select-selection-item">国产</div><input value=""></td></tr><tr><td><span>*</span><input value="适用场景" readonly></td><td><input value=""></td></tr></table></div>',
  );
  const result = readFields();
  assert.equal(result.specs["国产/进口"], "国产");
  assert.deepEqual(result.requiredMissing, ["适用场景"]);
});

test("JD detail order preserves equal URLs at distinct source positions", async () => {
  const { readJd } = await import("../src/browser/extractors.js");
  dom(
    `<div id="detail-main"><div class="ssd-module" data-bg='url("https://img.360buyimg.com/a.jpg")'></div><img src="https://img.360buyimg.com/b.jpg"><div class="ssd-module" data-bg='url("https://img.360buyimg.com/c.jpg")'></div><img src="https://img.360buyimg.com/a.jpg"></div>`,
    "item.jd.com",
  );
  Object.assign(globalThis, {
    location: { href: "https://item.jd.com/123.html", pathname: "/123.html" },
    getComputedStyle: (e: Element) => ({
      backgroundImage: e.getAttribute("data-bg") ?? "none",
    }),
  });
  assert.deepEqual(
    readJd()
      .assets.filter((a) => a.role === "detail")
      .map((a) => a.url),
    [
      "https://img.360buyimg.com/a.jpg",
      "https://img.360buyimg.com/b.jpg",
      "https://img.360buyimg.com/c.jpg",
      "https://img.360buyimg.com/a.jpg",
    ],
  );
});

test("JD detail records a source node only once when selector branches overlap", () => {
  dom(
    `<div id="detail-main"><img class="ssd-module" src="https://img.360buyimg.com/one.jpg"></div>`,
    "item.jd.com",
  );
  assert.deepEqual(
    readJd()
      .assets.filter((asset) => asset.role === "detail")
      .map((asset) => asset.url),
    ["https://img.360buyimg.com/one.jpg"],
  );
});

function jdPrice(html: string) {
  const document = dom(html, "item.jd.com");
  Object.assign(globalThis, {
    location: { href: "https://item.jd.com/123.html", pathname: "/123.html" },
  });
  for (const e of document.querySelectorAll("*"))
    Object.assign(e, {
      getBoundingClientRect: () => ({
        width: e.hasAttribute("hidden") ? 0 : 100,
      }),
    });
  return readJd().price;
}
function jdResult(html: string) {
  const document = dom(html, "item.jd.com");
  Object.assign(globalThis, {
    location: { href: "https://item.jd.com/123.html", pathname: "/123.html" },
  });
  for (const e of document.querySelectorAll("*"))
    Object.assign(e, {
      getBoundingClientRect: () => ({
        width: e.hasAttribute("hidden") ? 0 : 100,
      }),
    });
  return readJd() as ReturnType<typeof readJd> & {
    priceEvidence: {
      visibleRegularPrice: boolean;
      regularPriceAmbiguous: boolean;
    };
  };
}
test("subsidy-only evidence is selected when no regular price is available", () => {
  const p = jdPrice(
    '<div class="product-price-panel"><span class="product-price--main">¥25.02</span><span class="product-price--activity-item--tag">到手价</span><div class="product-price--gray"><span>¥27.8</span><span>补贴价</span></div></div>',
  );
  assert.equal(p?.value, "27.80");
  assert.equal(p?.basis, "subsidy");
});
test("explicit main subsidy alone is selected", () => {
  assert.equal(
    jdPrice(
      '<div class="product-price-panel"><span class="product-price--main">¥28.9</span><span class="product-price--activity-item--tag">补贴价</span></div>',
    )?.value,
    "28.90",
  );
});
test("explicit regular price wins over subsidy in the same visible panel", () => {
  const html =
    '<div class="product-price-panel"><div><span>¥55.8</span><span>补贴价</span></div><div><span>¥59</span><span>日常价</span></div></div>';
  const p = jdPrice(html);
  assert.equal(p?.value, "59.00");
  assert.equal(p?.basis, "jd-price");
  assert.match(p?.evidence ?? "", /日常价/);
  const document = dom(html, "item.jd.com");
  Object.assign(globalThis, {
    location: { href: "https://item.jd.com/123.html", pathname: "/123.html" },
  });
  for (const e of document.querySelectorAll("*"))
    Object.assign(e, { getBoundingClientRect: () => ({ width: 100 }) });
  assert.ok(readJd().priceCandidates.some((x) => x.basis === "subsidy"));
});
test("visible panel accepts exact JD price and rejects hidden regular price", () => {
  assert.equal(
    jdPrice(
      '<div class="product-price-panel"><div><span>¥59</span><span>京东价</span></div></div>',
    )?.value,
    "59.00",
  );
  assert.equal(
    jdPrice(
      '<div class="product-price-panel"><div hidden><span>¥59</span><span>日常价</span></div></div>',
    ),
    null,
  );
});
test("main price requires visible tag and amount while visible regular label blocks subsidy fallback", () => {
  assert.equal(
    jdPrice(
      '<div class="product-price-panel"><span class="product-price--main">¥59</span><span class="product-price--activity-item--tag" hidden>日常价</span><div><span>¥55</span><span>补贴价</span></div></div>',
    )?.value,
    "55.00",
  );
  assert.equal(
    jdPrice(
      '<div class="product-price-panel"><span class="product-price--main" hidden>¥59</span><span class="product-price--activity-item--tag">日常价</span><div><span>¥55</span><span>补贴价</span></div></div>',
    ),
    null,
  );
  assert.equal(
    jdPrice(
      '<div class="product-price-panel"><span class="product-price--activity-item--tag">京东价</span><div><span>¥55</span><span>补贴价</span></div></div>',
    ),
    null,
  );
});
test("equivalent regular price formats do not conflict", () => {
  assert.equal(
    jdPrice(
      '<div class="product-price-panel"><div><span>¥59</span><span>日常价</span></div><div><span>¥59.00</span><span>京东价</span></div></div>',
    )?.value,
    "59.00",
  );
});
test("regular conflicts, reference labels and multi-amount groups fail closed", () => {
  assert.equal(
    jdPrice(
      '<div class="product-price-panel"><div><span>¥59</span><span>日常价</span></div><div><span>¥60</span><span>京东价</span></div><div><span>¥55</span><span>补贴价</span></div></div>',
    ),
    null,
  );
  assert.equal(
    jdPrice(
      '<div class="product-price-panel"><div><span>¥59</span><span>参考价</span></div></div>',
    ),
    null,
  );
  assert.equal(
    jdPrice(
      '<div class="product-price-panel"><div><span>¥59</span><span>¥58</span><span>日常价</span></div><div><span>¥55</span><span>补贴价</span></div></div>',
    ),
    null,
  );
});
test("price extraction exports visible regular ambiguity for structured enrichment", () => {
  const result = jdResult(
    '<div class="product-price-panel"><div><span>¥59</span><span>¥58</span><span>日常价</span></div><div><span>¥55</span><span>补贴价</span></div></div>',
  );
  assert.equal(result.price, null);
  assert.deepEqual(result.priceEvidence, {
    visibleRegularPrice: true,
    regularPriceAmbiguous: true,
  });
});
test("final plus unlabelled crossed-out price is not subsidy evidence", () => {
  assert.equal(
    jdPrice(
      '<div class="product-price-panel"><span class="product-price--main">¥16.9</span><span class="product-price--activity-item--tag">到手价</span><div><s>¥17.9</s></div></div>',
    ),
    null,
  );
});
test("hidden and conflicting subsidy prices fail closed", () => {
  const panel = (p: string, hidden = "") =>
    `<div class="product-price-panel" ${hidden}><span class="product-price--main">¥${p}</span><span class="product-price--activity-item--tag">补贴价</span></div>`;
  assert.equal(jdPrice(panel("10", "hidden")), null);
  assert.equal(jdPrice(panel("10") + panel("11")), null);
});
test("visible promotion details accept exact JD price but ignore PLUS final price", () => {
  const p = jdPrice(
    '<div class="popover"><div>PLUS到手价<span>¥19.81</span></div><div class="formula-details"><div class="item"><span class="jd-price">¥21.9</span><span class="desc">京东价</span></div><div class="item"><span class="jd-price">¥19.81</span><span class="desc">PLUS到手价</span></div></div></div>',
  );
  assert.equal(p?.value, "21.90");
  assert.equal(p?.basis, "jd-price");
});
test("promotion details accept exact daily price with jd-price basis", () => {
  const p = jdPrice(
    '<div class="formula-details"><div class="item"><span class="jd-price">¥59</span><span class="desc">日常价</span></div></div>',
  );
  assert.equal(p?.value, "59.00");
  assert.equal(p?.basis, "jd-price");
  assert.match(p?.evidence ?? "", /优惠明细：日常价/);
});
test("visible formula regular label without a usable amount blocks subsidy fallback", () => {
  assert.equal(
    jdPrice(
      '<div class="product-price-panel"><div><span>¥55</span><span>补贴价</span></div></div><div class="formula-details"><div class="item"><span class="desc">京东价</span></div></div>',
    ),
    null,
  );
  assert.equal(
    jdPrice(
      '<div class="product-price-panel"><div><span>¥55</span><span>补贴价</span></div></div><div class="formula-details"><div class="item"><span class="jd-price" hidden>¥59</span><span class="desc">日常价</span></div></div>',
    ),
    null,
  );
});
test("promotion details reject hidden, ambiguous and inexact JD price rows", () => {
  assert.equal(
    jdPrice(
      '<div class="formula-details"><div class="item" hidden><span class="jd-price">¥21.9</span><span class="desc">京东价</span></div></div>',
    ),
    null,
  );
  assert.equal(
    jdPrice(
      '<div class="formula-details"><div class="item"><span class="jd-price" hidden>¥21.9</span><span class="desc">京东价</span></div></div>',
    ),
    null,
  );
  assert.equal(
    jdPrice(
      '<div class="formula-details"><div class="item"><span class="jd-price">¥21.9</span><span class="desc">京东价</span></div><div class="item"><span class="jd-price">¥22.9</span><span class="desc">京东价</span></div></div>',
    ),
    null,
  );
  assert.equal(
    jdPrice(
      '<div class="formula-details"><div class="item"><span class="jd-price">¥21.9</span><span class="desc">参考京东价</span></div></div>',
    ),
    null,
  );
});
test("PLUS detail opener clicks only a visible trigger on the expected SKU page", () => {
  const document = dom(
    '<div class="product-price-panel"><button>PLUS95折 立减1.09元</button></div>',
    "item.jd.com",
  );
  Object.assign(globalThis, {
    location: { href: "https://item.jd.com/123.html", pathname: "/123.html" },
  });
  const button = document.querySelector("button") as HTMLElement;
  let clicks = 0;
  Object.assign(button, {
    getBoundingClientRect: () => ({ width: 100 }),
    click: () => clicks++,
  });
  assert.equal(openJdPriceDetails("999"), false);
  assert.equal(openJdPriceDetails("123"), true);
  assert.equal(clicks, 1);
});
test("first-purchase detail opener clicks the exact leaf instead of its floor container", () => {
  const document = dom(
    '<div class="shareds"><div class="floor-list"><div><span>首购礼金可减1元</span></div></div></div>',
    "item.jd.com",
  );
  Object.assign(globalThis, {
    location: {
      href: "https://item.jd.com/5773954.html",
      pathname: "/5773954.html",
    },
  });
  const floor = document.querySelector(".floor-list") as HTMLElement;
  const leaf = document.querySelector("span") as HTMLElement;
  let floorClicks = 0,
    leafClicks = 0;
  Object.assign(floor, {
    getBoundingClientRect: () => ({ width: 100 }),
    click: () => floorClicks++,
  });
  for (const element of document.querySelectorAll(".floor-list *"))
    Object.assign(element, { getBoundingClientRect: () => ({ width: 100 }) });
  Object.assign(leaf, { click: () => leafClicks++ });
  assert.equal(openJdPriceDetails("5773954"), true);
  assert.equal(floorClicks, 0);
  assert.equal(leafClicks, 1);
});
test("sold-out reason remains separate from primary status and distinguishes missing columns", () => {
  const page = (header: string, cell: string) =>
    dom(
      `<table><thead><tr><th>商品信息</th><th>商品编码</th><th>状态</th>${header}</tr></thead><tbody><tr><td><a href='/detail?itemId=123'>商品</a></td><td>123</td><td>待审核</td>${cell}</tr></tbody></table>`,
    );
  page("<th>下架原因</th>", "<td>价格不符合市场公允价值锁定</td>");
  assert.equal(
    readRows().records[0].platformWarning,
    "价格不符合市场公允价值锁定",
  );
  assert.equal(readRows().records[0].status, "待审核");
  page("<th>下架原因</th>", "<td></td>");
  assert.equal(readRows().records[0].platformWarning, null);
  page("", "");
  assert.equal(readRows().records[0].platformWarning, undefined);
});

test("JD detail images exclude surrounding cards while preserving repeated source positions", () => {
  dom(
    `<div class="ssd-module-wrap ssd-format-wrap"><div class="ssd-floor-shopPrior"><img src="https://img10.360buyimg.com/recommend.jpg"></div></div><div class="ssd-module-wrap ssd-format-wrap"><div class="ssd-floor-activity"><img src="https://img10.360buyimg.com/activity.jpg"></div></div><div id="detail-main"><img src="https://img10.360buyimg.com/detail-a.jpg"><img src="https://img10.360buyimg.com/detail-b.jpg"><img src="https://img10.360buyimg.com/detail-a.jpg"></div>`,
    "item.jd.com",
  );
  assert.deepEqual(
    readJd()
      .assets.filter((a) => a.role === "detail")
      .map((a) => a.url),
    [
      "https://img10.360buyimg.com/detail-a.jpg",
      "https://img10.360buyimg.com/detail-b.jpg",
      "https://img10.360buyimg.com/detail-a.jpg",
    ],
  );
});
test("JD failed detail content cannot fall back to unrelated shop images", () => {
  dom(
    `<div id="detail-main">网络出小差了</div><div class="ssd-module-wrap"><img src="https://img10.360buyimg.com/unrelated.jpg"></div>`,
    "item.jd.com",
  );
  assert.equal(readJd().assets.filter((a) => a.role === "detail").length, 0);
});
test("JD legacy content remains readable without accepting format activity wrappers", () => {
  dom(
    `<div class="ssd-module-wrap"><img src="https://img10.360buyimg.com/legacy.jpg"></div><div class="ssd-module-wrap ssd-format-wrap"><img src="https://img10.360buyimg.com/ad.jpg"></div>`,
    "item.jd.com",
  );
  assert.deepEqual(
    readJd()
      .assets.filter((a) => a.role === "detail")
      .map((a) => a.url),
    ["https://img10.360buyimg.com/legacy.jpg"],
  );
});

test("JD detail excludes nested format advertisements in either layout", () => {
  for (const wrapper of ['id="detail-main"', 'class="ssd-module-wrap"']) {
    dom(
      `<div ${wrapper}><img src="https://img10.360buyimg.com/product.jpg"><div class="ssd-format-wrap"><img src="https://img10.360buyimg.com/nested-ad.jpg"></div></div>`,
      "item.jd.com",
    );
    assert.deepEqual(
      readJd()
        .assets.filter((a) => a.role === "detail")
        .map((a) => a.url),
      ["https://img10.360buyimg.com/product.jpg"],
    );
  }
});

test("Hezi administrator-policy intercept is risk, including a 200 HTML page", () => {
  const doc = dom(
    "很抱歉！因系统检测到您的请求已被网站管理员策略阻断，给您带来困扰请求谅解。",
  );
  doc.title = "AccessDeny";
  assert.equal(readPage().risk, true);
  assert.equal(readPage().login, false);
  dom("");
  Object.assign(location, {
    href: "https://b.csgmall.com.cn/mall-view/intercept",
    pathname: "/mall-view/intercept",
  });
  assert.equal(readPage().risk, true);
  dom("商品详情");
  assert.equal(readPage().risk, false);
});
