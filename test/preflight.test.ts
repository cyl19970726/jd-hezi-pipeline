import { test } from "node:test";
import assert from "node:assert/strict";
import { Catalog } from "../src/catalog.js";
import { example } from "../src/demo.js";
import { Jobs } from "../src/jobs.js";
import { Planner } from "../src/planner.js";
import { preflightJob, preflightQueue } from "../src/preflight.js";
import { SourceIndex } from "../src/source-index.js";
import { Store } from "../src/store.js";
import { Worker } from "../src/worker.js";

const recipe = {
  brandId: "brand",
  categoryId: "leaf",
  policyId: "policy",
  unit: "件",
  through: "draft" as const,
};

function setup() {
  const store = new Store(":memory:");
  new Catalog(store);
  new Planner(store);
  new SourceIndex(store);
  const jobs = new Jobs(store, "shop");
  return { store, jobs };
}

function setupUncollectedAuthorization(
  grant: "missing" | "expired" | "uncovered" | "valid",
) {
  const { store, jobs } = setup();
  const now = new Date();
  new Catalog(store).import({
    shop: "shop",
    categories: [
      {
        id: "root",
        parentId: null,
        name: "根",
        path: "根",
        selectable: false,
        sourceUrl: "https://b.csgmall.com.cn/",
        checkedAt: now.toISOString(),
      },
      ...["leaf", "other"].map((id) => ({
        id,
        parentId: "root",
        name: id === "leaf" ? "类目" : "其他类目",
        path: id === "leaf" ? "根>类目" : "根>其他类目",
        selectable: true,
        sourceUrl: "https://b.csgmall.com.cn/",
        checkedAt: now.toISOString(),
      })),
    ],
    brands: [
      {
        id: "brand",
        name: "品牌",
        sourceUrl: "https://b.csgmall.com.cn/",
        checkedAt: now.toISOString(),
      },
    ],
    grants:
      grant === "missing"
        ? []
        : [
            {
              id: "grant",
              brandId: "brand",
              status: "approved" as const,
              validFrom: new Date(now.getTime() - 60_000).toISOString(),
              validUntil: new Date(
                now.getTime() + (grant === "expired" ? -1 : 86_400_000),
              ).toISOString(),
              scopes: [
                {
                  categoryId: grant === "uncovered" ? "other" : "leaf",
                  descendants: false,
                },
              ],
              sourceUrl: "https://b.csgmall.com.cn/",
              checkedAt: now.toISOString(),
            },
          ],
  });
  new Planner(store).importTemplate("shop", "leaf", {
    categoryId: "leaf",
    specs: ["规格"],
    fields: [{ id: "f", name: "规格", required: true, selectType: "3" }],
    sourceUrl: "https://b.csgmall.com.cn/shop-view/",
    checkedAt: now.toISOString(),
  });
  new Planner(store).importPolicy("shop", "policy", {
    inventory: "1",
    logistics: {
      sourceItemId: "1",
      checkedAt: now.toISOString(),
      templateId: "1",
      templateName: "默认模板",
      addressIds: ["1"],
      areas: [{ areaId: "1", areaName: "全国" }],
    },
    sourceUrl: "https://b.csgmall.com.cn/",
    checkedAt: now.toISOString(),
  });
  const queued = jobs.enqueue(["100000000001"], recipe).items[0];
  return { store, jobs, queued, now: now.getTime() };
}

for (const kind of ["missing", "expired", "uncovered"] as const) {
  test(`uncollected work reports ${kind} authorization with collection required`, () => {
    const s = setupUncollectedAuthorization(kind);
    try {
      const result = preflightJob(s.store, s.jobs, s.queued.id, s.now);
      const codes = result.issues.map((entry) => entry.code);
      assert.ok(codes.includes("COLLECT_REQUIRED"));
      assert.ok(codes.includes("AUTHORIZATION_INVALID"));
      assert.ok(!codes.includes("TEMPLATE_MISSING"));
      assert.ok(!codes.includes("POLICY_MISSING"));
    } finally {
      s.store.close();
    }
  });
}

test("authorized uncollected work reports collection only", () => {
  const s = setupUncollectedAuthorization("valid");
  try {
    const result = preflightJob(s.store, s.jobs, s.queued.id, s.now);
    assert.deepEqual(
      result.issues.map((entry) => entry.code),
      ["COLLECT_REQUIRED"],
    );
  } finally {
    s.store.close();
  }
});

test("an existing complete plan authorizes its actual binding instead of the recipe", () => {
  const s = setupUncollectedAuthorization("valid");
  try {
    const { product, plan } = example();
    const row = s.store.put("shop", product);
    s.store.setPlan(row.id, {
      ...plan,
      shop: "shop",
      brand: "品牌",
      categoryPath: "根>其他类目",
      catalogBinding: { brandId: "brand", categoryId: "other" },
    });
    s.jobs.update(s.queued.id, "QUEUED", "queued", null, row.id);
    const result = preflightJob(s.store, s.jobs, s.queued.id, s.now);
    assert.ok(
      result.issues.some((entry) => entry.code === "AUTHORIZATION_INVALID"),
    );
  } finally {
    s.store.close();
  }
});

test("queue preflight marks uncollected work and aggregates independent missing setup", () => {
  const { store, jobs } = setup();
  try {
    const queued = jobs.enqueue(["123"], recipe).items[0];
    const result = preflightQueue(store, jobs, [queued.id]);
    assert.equal(result.ready, false);
    assert.deepEqual(
      new Set(result.items[0].issues.map((x) => x.code)),
      new Set([
        "COLLECT_REQUIRED",
        "CATALOG_MISSING",
        "TEMPLATE_MISSING",
        "POLICY_MISSING",
      ]),
    );
    assert.equal(store.list().length, 0);
    assert.equal(jobs.get(queued.id).status, "QUEUED");
  } finally {
    store.close();
  }
});

test("single preflight reports stale template, unsupported field type, authorization, validation and source index together", () => {
  const { store, jobs } = setup();
  try {
    const now = new Date().toISOString();
    new Catalog(store).import({
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
      grants: [],
    });
    new Planner(store).importTemplate("shop", "leaf", {
      categoryId: "leaf",
      specs: ["规格"],
      fields: [{ id: "f", name: "规格", required: true, selectType: "99" }],
      sourceUrl: "https://b.csgmall.com.cn/shop-view/",
      checkedAt: now,
    });
    store.db
      .prepare(
        "UPDATE category_templates SET checked_at='2000-01-01T00:00:00Z'",
      )
      .run();
    const queued = jobs.enqueue(["100000000001"], recipe).items[0];
    const { product, plan } = example();
    product.assets = [];
    const row = store.put("shop", product);
    store.setPlan(row.id, {
      ...plan,
      shop: "shop",
      brand: "品牌",
      categoryPath: "根>类目",
      catalogBinding: { brandId: "brand", categoryId: "leaf" },
      mediaReviewed: false,
    });
    jobs.update(queued.id, "QUEUED", "queued", null, row.id);
    const result = preflightJob(store, jobs, queued.id);
    const codes = new Set(result.issues.map((x) => x.code));
    for (const code of [
      "TEMPLATE_STALE",
      "FIELD_TYPE_UNSUPPORTED",
      "POLICY_MISSING",
      "AUTHORIZATION_INVALID",
      "VALIDATION_MISSING",
      "SOURCE_INDEX_INCOMPLETE",
    ])
      assert.ok(codes.has(code as any), code);
    assert.equal(result.ready, false);
    assert.equal(jobs.get(queued.id).status, "QUEUED");
  } finally {
    store.close();
  }
});

test("worker platform preflight caches success by config and template revision, and retries failures", async () => {
  const { store, jobs } = setup();
  try {
    const now = new Date().toISOString();
    new Planner(store).importTemplate("shop", "leaf", {
      categoryId: "leaf",
      specs: ["规格"],
      fields: [{ id: "f", name: "规格", required: true, selectType: "3" }],
      sourceUrl: "https://b.csgmall.com.cn/shop-view/",
      checkedAt: now,
    });
    const { plan } = example();
    const bound = {
      ...plan,
      shop: "shop",
      categoryPath: "根>类目",
      catalogBinding: { brandId: "brand", categoryId: "leaf" },
      fields: {
        ...plan.fields,
        packingName: {
          value: "说明书",
          sourceUrl: "https://item.jd.com/1.html",
          capturedAt: now,
          evidence: "测试包装清单",
        },
      },
    };
    let calls = 0;
    const bridge = {
      async call(action: string, args: any) {
        calls++;
        assert.equal(action, "preflight");
        assert.equal(args.categories[0].categoryId, "leaf");
        return {
          checkedAt: now,
          modules: { entry: "e", logistics: "l" },
          categories: [],
          ready: true,
        };
      },
    } as any;
    const config = {
      shop: "shop",
      session: { spaceId: 1, hzPage: "hz", jdPage: "jd", profileId: "p" },
      listUrl: "list",
      newUrl: "new",
      editUrl: "edit",
      maxPages: 1,
    };
    const worker = new Worker(store, jobs, config, "/tmp", bridge);
    await worker.platformPreflight(bound);
    await worker.platformPreflight(bound);
    assert.equal(calls, 1);
    store.db
      .prepare("UPDATE category_templates SET checked_at=?")
      .run(new Date(Date.now() + 1).toISOString());
    await worker.platformPreflight(bound);
    assert.equal(calls, 2);

    const failing = new Worker(store, jobs, config, "/tmp", {
      async call() {
        calls++;
        if (calls === 3) throw Error("changed");
        return {
          checkedAt: now,
          modules: { entry: "e", logistics: "l" },
          categories: [],
          ready: true,
        };
      },
    } as any);
    await assert.rejects(failing.platformPreflight(bound), /changed/);
    await failing.platformPreflight(bound);
    assert.equal(calls, 4);
  } finally {
    store.close();
  }
});

test("unplanned product reports every missing planning fact, pricing evidence, and pending reconciliation", () => {
  const { store, jobs } = setup();
  try {
    const now = new Date().toISOString();
    new Planner(store).importTemplate("shop", "leaf", {
      categoryId: "leaf",
      specs: ["规格", "净含量"],
      fields: [
        { id: "a", name: "规格", required: true, selectType: "3" },
        { id: "b", name: "净含量", required: true, selectType: "3" },
      ],
      sourceUrl: "https://b.csgmall.com.cn/shop-view/",
      checkedAt: now,
    });
    const queued = jobs.enqueue(["100000000001"], recipe).items[0];
    const { product } = example();
    product.price = null;
    product.specs = {};
    const row = store.put("shop", product);
    jobs.update(queued.id, "QUEUED", "queued", null, row.id);
    store.intent(row.id, "save");

    const result = preflightJob(store, jobs, queued.id);
    const missing = result.issues
      .filter((x) => x.code === "FACT_MISSING")
      .map((x) => x.field);
    assert.deepEqual(
      new Set(missing),
      new Set(["商品毛重", "包装名称", "包装数量", "规格", "净含量"]),
    );
    assert.ok(result.issues.some((x) => x.code === "PRICING_INVALID"));
    assert.ok(result.issues.some((x) => x.code === "PENDING_OPERATION"));
    assert.equal(result.ready, false);
    assert.equal(jobs.get(queued.id).status, "QUEUED");
  } finally {
    store.close();
  }
});

function setupCustomizationFactGate(
  categoryPath: string,
  approvedPolicy: boolean,
) {
  const { store, jobs } = setup();
  const now = new Date().toISOString();
  new Catalog(store).import({
    shop: "shop",
    categories: [
      {
        id: "leaf",
        parentId: null,
        name: "中性笔",
        path: categoryPath,
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
        scopes: [{ categoryId: "leaf", descendants: false }],
        sourceUrl: "https://b.csgmall.com.cn/",
        checkedAt: now,
      },
    ],
  });
  new Planner(store).importTemplate("shop", "leaf", {
    categoryId: "leaf",
    specs: ["是否可定制"],
    fields: [
      { id: "custom", name: "是否可定制", required: true, selectType: "1" },
    ],
    sourceUrl: "https://b.csgmall.com.cn/shop-view/",
    checkedAt: now,
  });
  new Planner(store).importPolicy("shop", "policy", {
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
  if (approvedPolicy)
    store.setMeta("listing-customization-policy:shop", {
      version: 1,
      scope: "office-stationery",
      value: "不可定制",
      approvedAt: now,
      approval: "用户明确授权：普通文具统一不提供定制服务",
    });
  const queued = jobs.enqueue(["100000000001"], recipe).items[0];
  const { product } = example();
  const fact = (value: string) => ({ ...product.title, value });
  product.specs = {
    商品毛重: fact("0.1kg"),
    包装名称: fact("中性笔"),
    包装数量: fact("12"),
  };
  const before = structuredClone(product);
  const row = store.put("shop", product);
  jobs.update(queued.id, "QUEUED", "queued", null, row.id);
  return { store, jobs, queued, before, row };
}

test("approved office-stationery policy satisfies only the customization source-fact gate", () => {
  const s = setupCustomizationFactGate(
    "办公用品 > 办公文具 > 书写工具 > 中性笔",
    true,
  );
  try {
    const result = preflightJob(s.store, s.jobs, s.queued.id);
    assert.ok(
      !result.issues.some(
        (entry) =>
          entry.code === "FACT_MISSING" && entry.field === "是否可定制",
      ),
    );
    assert.deepEqual(s.store.get(s.row.id).product, s.before);
    assert.equal(s.store.get(s.row.id).product?.specs["是否可定制"], undefined);
  } finally {
    s.store.close();
  }
});

test("missing customization policy retains the source-fact gate", () => {
  const s = setupCustomizationFactGate(
    "办公用品 > 办公文具 > 书写工具 > 中性笔",
    false,
  );
  try {
    const result = preflightJob(s.store, s.jobs, s.queued.id);
    assert.ok(
      result.issues.some(
        (entry) =>
          entry.code === "FACT_MISSING" && entry.field === "是否可定制",
      ),
    );
  } finally {
    s.store.close();
  }
});

test("customization policy does not bypass the source-fact gate outside office stationery", () => {
  const s = setupCustomizationFactGate("家居用品 > 清洁用品 > 抽纸", true);
  try {
    const result = preflightJob(s.store, s.jobs, s.queued.id);
    assert.ok(
      result.issues.some(
        (entry) =>
          entry.code === "FACT_MISSING" && entry.field === "是否可定制",
      ),
    );
  } finally {
    s.store.close();
  }
});

test("facts preflight defers only local media download readiness to the final phase", () => {
  const { store, jobs } = setup();
  try {
    const queued = jobs.enqueue(["100000000001"], recipe).items[0];
    const { product, plan } = example();
    product.assets = product.assets.map(({ role, order, url }) => ({
      role,
      order,
      url,
    }));
    const row = store.put("shop", product);
    store.setPlan(row.id, { ...plan, shop: "shop", mediaReviewed: false });
    jobs.update(queued.id, "QUEUED", "queued", null, row.id);

    const facts = preflightJob(store, jobs, queued.id, Date.now(), {
      phase: "facts",
    });
    const final = preflightJob(store, jobs, queued.id);
    const messages = (result: typeof facts) =>
      result.issues.map((entry) => entry.message);

    assert.ok(
      !messages(facts).some((message) => message.includes("图片尚未下载")),
    );
    assert.ok(
      facts.issues.some((entry) => entry.code === "FACT_MISSING"),
      "facts phase must retain non-media fact failures",
    );
    assert.ok(!messages(final).some((message) => message.includes("图片内容")));
    assert.ok(
      messages(final).some((message) => message.includes("图片尚未下载")),
    );
  } finally {
    store.close();
  }
});
