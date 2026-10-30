import test from "node:test";
import assert from "node:assert/strict";
import { example } from "../src/demo.js";
import { normalizeProduct } from "../src/normalization.js";
import {
  mergeProductPatch,
  targetedPlan,
  TargetedCaptures,
} from "../src/targeted-collection.js";
import { Store } from "../src/store.js";

test("missing fields group by region; observed regions and local conflicts do not cause repeat capture", () => {
  const p = example().product;
  delete p.specs["商品毛重"];
  delete p.specs["包装名称"];
  const result = normalizeProduct(p, ["商品毛重", "包装名称", "保质期"]);
  assert.deepEqual(targetedPlan(result, ["商品毛重", "包装名称"]).regions, [
    "summarySpecs",
    "packaging",
  ]);
  assert.deepEqual(
    targetedPlan(
      result,
      ["商品毛重", "包装名称"],
      ["summarySpecs", "packaging"],
    ).regions,
    [],
  );
});
test("targeted patch merges only requested facts, retaining original price and assets", () => {
  const p = example().product;
  delete p.specs["商品毛重"];
  const now = Date.now(),
    at = new Date(now).toISOString();
  const request = { fields: ["商品毛重"], regions: ["summarySpecs" as const] };
  const patch = {
    sku: p.sku,
    url: p.url,
    variant: p.variant,
    selectedVariant: p.specs["京东销售规格"]?.value,
    specs: {
      商品毛重: {
        value: "0.5kg",
        sourceUrl: p.url,
        capturedAt: at,
        evidence: "业务响应weight",
      },
    },
    observedAt: at,
    regions: request.regions,
    completeRegions: request.regions,
  };
  const out = mergeProductPatch(p, patch, request, now);
  assert.equal(out.specs["商品毛重"].value, "0.5kg");
  assert.deepEqual(out.assets, p.assets);
  assert.deepEqual(out.price, p.price);
  assert.equal(p.specs["商品毛重"], undefined);
  assert.throws(() =>
    mergeProductPatch(p, { ...patch, sku: "999" }, request, now),
  );
  assert.throws(() =>
    mergeProductPatch(
      out,
      {
        ...patch,
        specs: { 商品毛重: { ...patch.specs.商品毛重, value: "1kg" } },
      },
      request,
      now,
    ),
  );
  assert.throws(() =>
    mergeProductPatch(
      p,
      {
        ...patch,
        specs: { 品牌: { ...patch.specs.商品毛重, value: "other" } },
      },
      request,
      now,
    ),
  );
  assert.throws(() =>
    mergeProductPatch(
      p,
      {
        ...patch,
        specs: {
          商品毛重: {
            ...patch.specs.商品毛重,
            sourceUrl: "https://item.jd.com/999.html",
          },
        },
      },
      request,
      now,
    ),
  );
});
test("unfinished attempts can resume; observed regions survive restart and prevent repetition", () => {
  const s = new Store(":memory:");
  try {
    const p = example().product;
    const r = ["商品毛重"];
    const c = new TargetedCaptures(s);
    c.begin("shop", p, "browser", r, ["summarySpecs"]);
    assert.deepEqual(c.attempted("shop", p, "browser", r), []);
    c.begin("shop", p, "browser", r, ["summarySpecs"]);
    c.finish("shop", p, "browser", r, {
      sku: p.sku,
      url: p.url,
      variant: p.variant,
      specs: {},
      observedAt: new Date().toISOString(),
      regions: ["summarySpecs"],
      completeRegions: ["summarySpecs"],
    });
    assert.deepEqual(
      new TargetedCaptures(s).attempted("shop", p, "browser", r),
      ["summarySpecs"],
    );
    assert.deepEqual(c.attempted("other", p, "browser", r), []);
    assert.deepEqual(c.attempted("shop", p, "browser", ["品牌"]), []);
  } finally {
    s.close();
  }
});
test("product, checkpoint and targeted receipt commit atomically even through nested store operations", () => {
  const s = new Store(":memory:");
  try {
    const p = example().product;
    const row = s.put("shop", p);
    const captures = new TargetedCaptures(s);
    const required = ["商品毛重"];
    captures.begin("shop", p, "browser", required, ["summarySpecs"]);
    assert.throws(() =>
      s.tx(() => {
        s.put("shop", { ...p, title: { ...p.title, value: "changed" } });
        captures.finish("shop", p, "browser", required, {
          sku: p.sku,
          url: p.url,
          variant: p.variant,
          specs: {},
          observedAt: new Date().toISOString(),
          regions: ["summarySpecs"],
          completeRegions: ["summarySpecs"],
        });
        throw Error("simulated last write failure");
      }),
    );
    assert.equal(s.get(row.id).product!.title.value, p.title.value);
    assert.deepEqual(captures.attempted("shop", p, "browser", required), []);
    s.tx(() => s.tx(() => s.setMeta("nested-success", true)));
    assert.equal(s.meta("nested-success"), true);
  } finally {
    s.close();
  }
});
