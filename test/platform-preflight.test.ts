import { SourceReuse, sourceContext } from "../src/source-reuse.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import sharp from "sharp";
import { Catalog } from "../src/catalog.js";
import { example } from "../src/demo.js";
import { Jobs } from "../src/jobs.js";
import { PipelineError } from "../src/model.js";
import { Planner } from "../src/planner.js";
import { SourceIndex } from "../src/source-index.js";
import { Store } from "../src/store.js";
import { Worker } from "../src/worker.js";

const config = {
  shop: "shop",
  session: { spaceId: 1, hzPage: "hz", jdPage: "jd", profileId: "profile" },
  listUrl: "list",
  newUrl: "new",
  editUrl: "edit",
  maxPages: 1,
};
const recipe = {
  brandId: "brand",
  categoryId: "leaf",
  policyId: "policy",
  unit: "件",
  through: "draft" as const,
};

function fixture(bridge: any) {
  const store = new Store(":memory:");
  new Catalog(store);
  const planner = new Planner(store);
  new SourceIndex(store);
  const jobs = new Jobs(store, "shop");
  planner.importTemplate("shop", "leaf", {
    categoryId: "leaf",
    specs: ["规格"],
    fields: [{ id: "f", name: "规格", required: true, selectType: "3" }],
    sourceUrl: "https://b.csgmall.com.cn/shop-view/",
    checkedAt: new Date().toISOString(),
  });
  planner.importPolicy("shop", "policy", {
    inventory: "100",
    logistics: {
      sourceItemId: "1",
      checkedAt: new Date().toISOString(),
      templateId: "1",
      templateName: "默认模板",
      addressIds: ["1"],
      areas: [{ areaId: "1", areaName: "全国" }],
    },
    sourceUrl: "https://b.csgmall.com.cn/",
    checkedAt: new Date().toISOString(),
  });
  const plan = {
    ...example().plan,
    shop: "shop",
    categoryPath: "根>类目",
    brand: "品牌",
    catalogBinding: { brandId: "brand", categoryId: "leaf" },
    fields: {
      ...example().plan.fields,
      packingName: {
        value: "说明书",
        sourceUrl: "https://item.jd.com/1.html",
        capturedAt: new Date().toISOString(),
        evidence: "测试包装清单",
      },
    },
  };
  return {
    store,
    jobs,
    plan,
    worker: new Worker(store, jobs, config, "/tmp", bridge),
  };
}

const ok = () => ({
  checkedAt: new Date().toISOString(),
  modules: { entry: "entry", logistics: "logistics" },
  categories: [],
  ready: true,
});

test("platform readiness success is cached for five minutes and expires afterward", async () => {
  let calls = 0;
  const s = fixture({
    async call() {
      calls++;
      return ok();
    },
  });
  const original = Date.now;
  let now = original();
  Date.now = () => now;
  try {
    await s.worker.platformPreflight(s.plan);
    now += 299_999;
    await s.worker.platformPreflight(s.plan);
    assert.equal(calls, 1);
    now += 2;
    await s.worker.platformPreflight(s.plan);
    assert.equal(calls, 2);
  } finally {
    Date.now = original;
    s.store.close();
  }
});

test("platform preflight sends packing name and cache identity changes with it", async () => {
  const calls: any[] = [];
  const s = fixture({
    async call(action: string, args: any) {
      calls.push({ action, args });
      return ok();
    },
  });
  try {
    await s.worker.platformPreflight(s.plan);
    await s.worker.platformPreflight(s.plan);
    const changed = structuredClone(s.plan);
    changed.fields.packingName = {
      ...changed.fields.packingName,
      value: changed.fields.packingName.value + "加长",
    };
    await s.worker.platformPreflight(changed);
    assert.equal(calls.length, 2);
    assert.equal(
      calls[0].args.categories[0].packingName,
      s.plan.fields.packingName.value,
    );
    assert.equal(
      calls[1].args.categories[0].packingName,
      changed.fields.packingName.value,
    );
  } finally {
    s.store.close();
  }
});

test("failure and invalid receipts are never cached, and both browser locks are released", async () => {
  let calls = 0;
  const s = fixture({
    async call() {
      calls++;
      if (calls === 1) throw new PipelineError("UI_CHANGED", "changed");
      if (calls === 2) return { ...ok(), modules: [] };
      return ok();
    },
  });
  try {
    await assert.rejects(s.worker.platformPreflight(s.plan), /changed/);
    const releasePublisher = s.store.lock("publisher");
    releasePublisher();
    const releaseTraffic = s.store.lock("hezi-traffic");
    releaseTraffic();
    await assert.rejects(s.worker.platformPreflight(s.plan), /返回结构无效/);
    await s.worker.platformPreflight(s.plan);
    assert.equal(calls, 3);
    assert.equal(s.store.meta("preflight-platform:shop").ready, true);
  } finally {
    s.store.close();
  }
});

async function runnable(bridge: any) {
  const root = await mkdtemp(join(tmpdir(), "hezi-preflight-"));
  const s = fixture(bridge);
  const now = new Date().toISOString();
  new Catalog(s.store).import({
    shop: "shop",
    categories: [
      {
        id: "root",
        parentId: null,
        name: "根",
        path: "根",
        selectable: false,
        sourceUrl: "https://b.csgmall.com.cn/",
        checkedAt: now,
      },
      {
        id: "leaf",
        parentId: "root",
        name: "类目",
        path: "根>类目",
        selectable: true,
        sourceUrl: "https://b.csgmall.com.cn/",
        checkedAt: now,
      },
    ],
    brands: [
      {
        id: "brand",
        name: "品牌",
        sourceUrl: "https://b.csgmall.com.cn/",
        checkedAt: now,
      },
    ],
    grants: [
      {
        id: "grant",
        brandId: "brand",
        status: "approved",
        validFrom: new Date(Date.now() - 1000).toISOString(),
        validUntil: new Date(Date.now() + 86400000).toISOString(),
        scopes: [{ categoryId: "leaf", descendants: false }],
        sourceUrl: "https://b.csgmall.com.cn/",
        checkedAt: now,
      },
    ],
  });
  const { product } = example();
  product.specs = {
    ...product.specs,
    规格: { ...product.title, value: "单件" },
    商品毛重: { ...product.title, value: "0.5kg" },
    包装名称: { ...product.title, value: "盒" },
    包装数量: { ...product.title, value: "1" },
  };
  product.assets = await Promise.all(
    product.assets.map(async (a, index) => {
      const bytes = await sharp({
        create: {
          width: 800,
          height: 800,
          channels: 3,
          background: { r: 20 + index * 30, g: 80, b: 120 },
        },
      })
        .jpeg()
        .toBuffer();
      const path = join(root, `image-${index}.jpg`);
      await writeFile(path, bytes);
      return {
        ...a,
        path,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        width: 800,
        height: 800,
      };
    }),
  );
  s.store.setMeta("jd-context:shop", {
    account: "fixture-account",
    region: "fixture-region",
  });
  new SourceReuse(s.store).remember(
    sourceContext(s.store, "shop", product.sku),
    product,
  );
  const row = s.store.put("shop", product);
  s.store.setPlan(row.id, {
    ...s.plan,
    specs: { 规格: product.specs.规格 },
    mediaReviewed: true,
  });
  const job = s.jobs.enqueue([product.sku], recipe).items[0];
  s.jobs.update(job.id, "QUEUED", "queued", null, row.id);
  const index = new SourceIndex(s.store);
  const scan = index.begin("shop");
  index.finish(
    scan,
    ["visible-normal", "visible-draft", "hidden-normal", "hidden-draft"].map(
      (partition) => ({ partition, expected: 0, seen: 0 }),
    ),
  );
  return { ...s, root, row, job, downloadedProduct: product };
}

test("worker downloads URL-only media and reaches platform preflight without visual review", async () => {
  const s = await runnable({
    async call() {
      throw new Error("bridge is replaced by the platform sentinel");
    },
  });
  let downloads = 0;
  (s.worker.sources as any).downloadAssets = async () => {
    downloads++;
    return structuredClone(s.downloadedProduct);
  };
  let platformPreflights = 0;
  s.worker.platformPreflight = async () => {
    platformPreflights++;
    throw new PipelineError("UI_CHANGED", "platform-sentinel");
  };
  const raw = structuredClone(s.downloadedProduct);
  raw.assets = raw.assets.map(({ role, order, url }) => ({ role, order, url }));
  s.store.put("shop", raw);
  s.store.setPlan(s.row.id, { ...s.plan, mediaReviewed: false });
  try {
    await s.worker.run(s.jobs.get(s.job.id));
    assert.equal(downloads, 1);
    assert.equal(platformPreflights, 1);
    assert.equal(s.jobs.get(s.job.id).stage, "preflight");
    assert.match(s.jobs.get(s.job.id).error!, /platform-sentinel/);
    assert.ok(
      s.store.get(s.row.id).product!.assets.every((asset) => asset.sha256),
    );
  } finally {
    s.store.close();
    await rm(s.root, { recursive: true, force: true });
  }
});

test("legacy mediaReviewed value does not alter URL-only upload readiness", async () => {
  const s = await runnable({
    async call() {
      throw new Error("bridge is replaced by the platform sentinel");
    },
  });
  let downloads = 0;
  let platformPreflights = 0;
  (s.worker.sources as any).downloadAssets = async () => {
    downloads++;
    return structuredClone(s.downloadedProduct);
  };
  s.worker.platformPreflight = async () => {
    platformPreflights++;
    throw new PipelineError("UI_CHANGED", "platform-sentinel");
  };
  const raw = structuredClone(s.downloadedProduct);
  raw.assets = raw.assets.map(({ role, order, url }) => ({ role, order, url }));
  s.store.put("shop", raw);
  s.store.setPlan(s.row.id, { ...s.plan, mediaReviewed: true });
  try {
    await s.worker.run(s.jobs.get(s.job.id));
    assert.equal(downloads, 1);
    assert.equal(platformPreflights, 1);
    assert.equal(s.jobs.get(s.job.id).stage, "preflight");
    assert.match(s.jobs.get(s.job.id).error!, /platform-sentinel/);
  } finally {
    s.store.close();
    await rm(s.root, { recursive: true, force: true });
  }
});

test("UI_CHANGED from the platform stage pauses HZ only", async () => {
  const s = await runnable({
    async call() {
      return ok();
    },
  });
  s.worker.platformPreflight = async () => {
    throw new PipelineError("UI_CHANGED", "schema changed");
  };
  try {
    await s.worker.run(s.jobs.get(s.job.id));
    assert.equal(s.jobs.get(s.job.id).stage, "preflight");
    assert.equal(s.jobs.get(s.job.id).status, "NEEDS_INPUT");
    assert.equal(s.store.meta("pause:hz:shop").code, "UI_CHANGED");
    assert.equal(s.store.meta("pause:shop"), null);
  } finally {
    s.store.close();
    await rm(s.root, { recursive: true, force: true });
  }
});

test("pending write stops for reconciliation before any platform preflight", async () => {
  let calls = 0;
  const s = await runnable({
    async call() {
      calls++;
      return ok();
    },
  });
  s.store.intent(s.row.id, "save");
  try {
    await s.worker.run(s.jobs.get(s.job.id));
    assert.equal(calls, 0);
    assert.equal(s.jobs.get(s.job.id).status, "UNKNOWN_OUTCOME");
    assert.ok(s.store.pending(s.row.id));
  } finally {
    s.store.close();
    await rm(s.root, { recursive: true, force: true });
  }
});
