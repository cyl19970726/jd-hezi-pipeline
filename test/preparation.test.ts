import test from "node:test";
import assert from "node:assert/strict";
import { example } from "../src/demo.js";
import { Store } from "../src/store.js";
import { Preparation } from "../src/preparation.js";
import { collectionNeed } from "../src/collection-needs.js";
import { JdCaptureStore } from "../src/jd-capture.js";
import { Jobs } from "../src/jobs.js";
import { Worker } from "../src/worker.js";

test("local normalization retains raw observations, caches decisions, and preserves unrelated source", () => {
  const s = new Store(":memory:");
  try {
    const p = structuredClone(example().product);
    delete p.specs["商品毛重"];
    p.specs["毛重"] = { ...p.title, value: "500g", sourceUrl: p.url };
    const original = structuredClone(p),
      row = s.put("shop", p),
      prep = new Preparation(s);
    const first = prep.apply(row.id, ["商品毛重"]);
    assert.equal(first.product.specs["商品毛重"].value, "0.5kg");
    assert.deepEqual(p, original);
    const saved = s.get(row.id).product!;
    assert.deepEqual(saved.assets, p.assets);
    assert.deepEqual(saved.price, p.price);
    assert.equal(prep.analyze("shop", p, ["商品毛重"]).cached, true);
    const evidence = s.db
      .prepare("SELECT product FROM preparation_observations")
      .get();
    assert.deepEqual(JSON.parse(String(evidence!.product)), original);
    assert.equal(
      prep.analyze("shop", p, ["商品毛重", "缺失字段"]).cached,
      false,
    );
  } finally {
    s.close();
  }
});

test("archive-box preparation caches category semantics independently", () => {
  const s = new Store(":memory:");
  try {
    const p = structuredClone(example().product);
    const fact = (value: string, evidence: string) => ({
      ...p.title,
      value,
      sourceUrl: p.url,
      evidence,
    });
    p.title = fact("齐心5622档案盒 A4", "fabricated current-SKU title");
    p.specs = {
      规格: fact("A4", "fabricated current-SKU paper format"),
      包装清单: fact("5622档案盒 × １个", "fabricated current-SKU packing"),
      京东销售规格: fact(
        "【35mm侧宽】蓝色-纯PP材质",
        "fabricated current-SKU sale specification",
      ),
      货号: fact("5622", "fabricated current-SKU item number"),
      材质: fact("pp", "fabricated current-SKU material"),
    };
    const before = structuredClone(p);
    const prep = new Preparation(s);
    const required = ["规格", "尺寸规格", "材质"];

    const defaultCategory = prep.analyze("shop", p, required);
    const otherCategory = prep.analyze("shop", p, required, undefined, {
      categoryId: "other-category",
    });
    const archiveCategory = prep.analyze("shop", p, required, undefined, {
      categoryId: "10048009",
    });

    assert.equal(defaultCategory.cached, false);
    assert.equal(otherCategory.cached, false);
    assert.equal(archiveCategory.cached, false);
    assert.equal(defaultCategory.product.specs["规格"].value, "A4");
    assert.equal(otherCategory.product.specs["规格"].value, "A4");
    assert.equal(archiveCategory.product.specs["规格"].value, "单个装");
    assert.equal(archiveCategory.product.specs["尺寸规格"].value, "35mm");
    assert.equal(archiveCategory.product.specs["京东原始规格"].value, "A4");
    assert.deepEqual(p, before);

    assert.equal(prep.analyze("shop", p, required).cached, true);
    assert.equal(
      prep.analyze("shop", p, required, undefined, {
        categoryId: "other-category",
      }).cached,
      true,
    );
    assert.equal(
      prep.analyze("shop", p, required, undefined, {
        categoryId: "10048009",
      }).cached,
      true,
    );
  } finally {
    s.close();
  }
});

test("normalization cannot edit a planned, bound or pending product", () => {
  for (const kind of ["plan", "bound", "pending"]) {
    const s = new Store(":memory:");
    try {
      const { product, plan } = example(),
        row = s.put(plan.shop, product),
        prep = new Preparation(s);
      if (kind === "plan") s.setPlan(row.id, plan);
      if (kind === "bound") s.bind(row.id, "990911001001", "990911001001");
      if (kind === "pending") s.intent(row.id, "save");
      const before = s.get(row.id);
      assert.throws(() => prep.apply(row.id, ["商品毛重"]));
      assert.deepEqual(s.get(row.id), before);
    } finally {
      s.close();
    }
  }
});

test("a recorded collection without weight routes to local work, not another JD navigation", () => {
  const s = new Store(":memory:");
  try {
    const p = structuredClone(example().product);
    delete p.specs["商品毛重"];
    const c = { shop: "shop", sku: p.sku, source: "browser" as const },
      capture = new JdCaptureStore(s);
    assert.equal(collectionNeed(p, "browser"), "full");
    capture.saveProduct(c, p);
    assert.equal(capture.observedProduct(c, p), true);
    assert.equal(
      collectionNeed(p, "browser", Date.now(), {
        previouslyObserved: capture.observedProduct(c, p),
      }),
      "local",
    );
    assert.equal(capture.observedProduct({ ...c, shop: "other" }, p), false);
    assert.equal(capture.observedProduct(c, { ...p, variant: "other" }), false);
    assert.equal(capture.observedProduct(c, { ...p, assets: [] }), false);
    assert.equal(capture.observedProduct(c, { ...p, specs: {} }), false);
    assert.equal(
      capture.observedProduct({ ...c, parserVersion: "next" }, p),
      false,
    );
  } finally {
    s.close();
  }
});

test("an offline worker pass resolves aliases and requeues without opening pages or downloading URL-only assets", async () => {
  const s = new Store(":memory:");
  try {
    const p = structuredClone(example().product);
    delete p.specs["商品毛重"];
    p.specs["毛重"] = { ...p.title, sourceUrl: p.url, value: "500g" };
    p.specs["包装名称"] = { ...p.title, sourceUrl: p.url, value: "测试单品" };
    p.specs["包装数量"] = { ...p.title, sourceUrl: p.url, value: "1" };
    p.assets = p.assets.map((a) => ({
      ...a,
      path: undefined,
      originalPath: undefined,
    }));
    const row = s.put("shop", p),
      jobs = new Jobs(s, "shop");
    new JdCaptureStore(s).saveProduct(
      { shop: "shop", sku: p.sku, source: "browser" },
      p,
    );
    jobs.enqueue([p.sku], {
      brandId: "b",
      categoryId: "c",
      policyId: "p",
      unit: "件",
      through: "submit",
    });
    let calls = 0;
    const forbidden = async () => {
      calls++;
      throw Error("network forbidden");
    };
    await new Worker(
      s,
      jobs,
      { shop: "shop" } as any,
      "/unused",
      { call: forbidden } as any,
      { collectAndroid: forbidden, downloadAssets: forbidden } as any,
    ).run(jobs.claim()!);
    assert.equal(calls, 0);
    assert.equal(jobs.list()[0].status, "QUEUED");
    assert.equal(s.get(row.id).product!.specs["商品毛重"].value, "0.5kg");
    assert.notEqual(collectionNeed(s.get(row.id).product!, "browser"), "local");
    assert.equal(s.get(row.id).remoteId, null);
  } finally {
    s.close();
  }
});

test("preparation accepts only registry-qualified family facts and revokes them when donor proof changes", async () => {
  const { registerFamilyEvidence } =
    await import("../src/automation-evidence.js");
  const { productFamilySnapshotHash } =
    await import("../src/product-family.js");
  const s = new Store(":memory:");
  try {
    const p = example().product;
    const donor = structuredClone(p);
    donor.sku = "987654";
    donor.url = "https://item.jd.com/987654.html";
    donor.specs.品牌 = {
      ...donor.title,
      sourceUrl: donor.url,
      value: "明确品牌",
    };
    s.put("shop", donor);
    const row = s.put("shop", p);
    registerFamilyEvidence(s, "shop", {
      version: 1,
      kind: "explicit-product-family-membership",
      familyId: "test-family",
      donorSku: donor.sku,
      recipientSku: p.sku,
      donorSnapshotHash: productFamilySnapshotHash(donor),
      recipientSnapshotHash: productFamilySnapshotHash(p),
      capturedAt: new Date().toISOString(),
      evidence: "fixture exact membership",
      applicableFields: [
        { field: "品牌", evidence: "fixture brand applicability" },
      ],
    });
    const preparation = new Preparation(s);
    const result = preparation.apply(row.id, ["品牌"]);
    assert.deepEqual(result.issues, []);
    assert.equal(result.product.specs.品牌.sourceUrl, donor.url);
    assert.deepEqual(preparation.apply(row.id, ["品牌"]).issues, []);
    donor.specs.品牌.value = "改变品牌";
    s.put("shop", donor);
    const revoked = preparation.apply(row.id, ["品牌"]);
    assert.ok(revoked.issues.length);
    assert.equal(s.get(row.id).product!.specs.品牌, undefined);
  } finally {
    s.close();
  }
});
