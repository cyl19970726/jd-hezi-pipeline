import test from "node:test";
import assert from "node:assert/strict";
import {
  parseAndroidProduct,
  checkAndroid,
  androidNodes,
} from "../src/android.js";
import { Store } from "../src/store.js";
import { Jobs } from "../src/jobs.js";
import { JdTraffic } from "../src/jd-traffic.js";
const main =
  '<node text="某品牌清洁喷雾500mL两瓶装适用于家居清洁使用" resource-id="" clickable="true"/><node content-desc="已选中款式 500mL 2瓶"/><node text="31.16元"/><node text="PLUS到手价"/><node text="¥34.9"/>';
const details =
  '<node text="品牌"/><node text="某品牌"/><node text="商品编号"/><node text="123"/><node text="农药登记证号"/><node text="WP123"/><node text="店内优选"/><node text="商品编号"/><node text="456"/><node text="包装清单"/><node text="两瓶装"/>';
test("Android reads target SKU facts without turning unlabelled or personalized prices into subsidy", () => {
  const p = parseAndroidProduct("123", main, details);
  assert.equal(p.sku, "123");
  assert.equal(p.variant, "");
  assert.equal(p.specs["京东销售规格"].value, "500mL 2瓶");
  assert.equal(p.price, null);
  assert.deepEqual(p.assets, []);
  assert.equal(p.specs["包装清单"].value, "两瓶装");
  assert.throws(() => parseAndroidProduct("456", main, details), /SKU/);
});
test("Android blocks verification and ambiguous titles, and decodes literal XML text", () => {
  assert.throws(() => checkAndroid('<node text="京东验证"/>'), /验证/);
  assert.throws(
    () => parseAndroidProduct("123", main + main, details),
    /不唯一/,
  );
  assert.equal(androidNodes('<node text="A&amp;B&#32;C"/>')[0].text, "A&B C");
});

test("Android accepts only an explicitly labelled price within the selected product area", () => {
  const selected = '<node content-desc="已选中款式 500mL 2瓶"/>';
  const title =
    '<node text="某品牌清洁喷雾500mL两瓶装适用于家居清洁使用" resource-id="" clickable="true"/>';
  assert.equal(
    parseAndroidProduct(
      "123",
      selected + '<node text="补贴价 ¥27.80"/>' + title,
      details,
    ).price?.value,
    "27.80",
  );
  assert.equal(
    parseAndroidProduct(
      "123",
      selected + title + '<node text="补贴价 ¥27.80"/>',
      details,
    ).price,
    null,
  );
  const equivalent = parseAndroidProduct(
    "123",
    selected + '<node text="日常价 ¥59"/><node text="京东价 ¥59.00"/>' + title,
    details,
  ).price;
  assert.equal(equivalent?.value, "59");
  assert.match(equivalent?.evidence || "", /日常价/);
});
test("browser pause does not dispatch browser jobs but Android shares the same navigation spacing", async () => {
  const s = new Store(":memory:");
  let now = 100000;
  const clock = {
    now: () => now,
    sleep: async (ms: number) => {
      now += ms;
    },
  };
  try {
    const j = new Jobs(s, "ours");
    const a = j.enqueue(["123"], {
      brandId: "b",
      categoryId: "c",
      policyId: "p",
      unit: "件",
      through: "submit",
    });
    j.enqueue(["456"], {
      brandId: "b",
      categoryId: "c",
      policyId: "p",
      unit: "件",
      through: "submit",
      source: "android",
    });
    await new JdTraffic(s, "ours", clock).navigate(
      "https://item.jd.com/123.html",
      async () => {},
    );
    s.pause("jd:ours", "verification");
    await new JdTraffic(s, "ours", clock, "android").navigate(
      "https://item.jd.com/456.html",
      async () => {},
    );
    assert.equal(now, 115000);
    assert.equal(j.claim((x) => x.recipe.source === "android")?.sku, "456");
    assert.equal(j.get(a.items[0].id).attempt, 0);
    j.source(a.items[0].id, "android");
    assert.equal(j.get(a.items[0].id).recipe.source, "android");
    assert.throws(
      () => j.source(j.list().find((x) => x.sku === "456")!.id, "browser"),
      /切换/,
    );
  } finally {
    s.close();
  }
});

test("mobile native labels prefer regular price and never fall back to subsidy after a regular conflict", () => {
  const selected = '<node content-desc="已选中款式 500mL 2瓶"/>';
  const title =
    '<node text="某品牌清洁喷雾500mL两瓶装适用于家居清洁使用" resource-id="" clickable="true"/>';
  assert.equal(
    parseAndroidProduct(
      "123",
      selected + '<node text="京东价 ¥34.90"/>' + title,
      details,
    ).price?.basis,
    "jd-price",
  );
  assert.equal(
    parseAndroidProduct(
      "123",
      selected +
        '<node text="京东价 ¥34.90"/><node text="补贴价 ¥30.90"/>' +
        title,
      details,
    ).price?.value,
    "34.90",
  );
  assert.equal(
    parseAndroidProduct(
      "123",
      selected +
        '<node text="京东价 ¥34.90"/><node text="日常价 ¥35.90"/><node text="补贴价 ¥30.90"/>' +
        title,
      details,
    ).price,
    null,
  );
  const daily = parseAndroidProduct(
    "123",
    selected +
      '<node text="日常价 ¥36.90"/><node text="补贴价 ¥30.90"/>' +
      title,
    details,
  ).price;
  assert.equal(daily?.value, "36.90");
  assert.equal(daily?.basis, "jd-price");
  assert.match(daily?.evidence || "", /日常价/);
  assert.equal(
    parseAndroidProduct(
      "123",
      selected + '<node text="日常价"/><node text="补贴价 ¥30.90"/>' + title,
      details,
    ).price,
    null,
  );
});

test("Android distinguishes an accessibility-labelled title from a long PLUS upsell", () => {
  const title = "某品牌清洁喷雾500mL两瓶装适用于家居清洁使用";
  const labelled = main.replace(
    `text="${title}"`,
    `text="${title}" content-desc="京东超市${title}"`,
  );
  const promo =
    '<node text="续费PLUS会员等，本单含赠金省¥21.81" resource-id="" clickable="true"/>';
  assert.equal(
    parseAndroidProduct("123", labelled + promo, details).title.value,
    title,
  );
  assert.throws(
    () => parseAndroidProduct("123", labelled + labelled + promo, details),
    /不唯一/,
  );
});
