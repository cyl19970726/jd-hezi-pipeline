import test from "node:test";
import assert from "node:assert/strict";
import { Catalog, type CatalogBatch } from "../src/catalog.js";
import { Engine } from "../src/engine.js";
import { expectedFields, PipelineError, type Plan } from "../src/model.js";
import {
  repairRejected,
  type RejectionRepairAdapter,
} from "../src/rejection-repair.js";
import { example, MemoryAdapter } from "../src/demo.js";
import { Store } from "../src/store.js";

function setup() {
  const store = new Store(":memory:"),
    catalog = new Catalog(store),
    { product, plan } = example(),
    checkedAt = new Date().toISOString(),
    sourceUrl = "https://b.csgmall.com.cn/";
  plan.catalogBinding = { brandId: "b", categoryId: "leaf" };
  const batch: CatalogBatch = {
    shop: plan.shop,
    brands: [{ id: "b", name: plan.brand, checkedAt, sourceUrl }],
    categories: [
      {
        id: "root",
        parentId: null,
        name: "根",
        path: "根",
        selectable: false,
        checkedAt,
        sourceUrl,
      },
      {
        id: "leaf",
        parentId: "root",
        name: "叶",
        path: plan.categoryPath,
        selectable: true,
        checkedAt,
        sourceUrl,
      },
    ],
    grants: [
      {
        id: "g",
        brandId: "b",
        status: "approved",
        validFrom: new Date(Date.now() - 3600000).toISOString(),
        validUntil: new Date(Date.now() + 86400000).toISOString(),
        scopes: [{ categoryId: "root", descendants: true }],
        checkedAt,
        sourceUrl,
      },
    ],
  };
  catalog.import(batch);
  const row = store.put(plan.shop, product);
  store.setPlan(row.id, plan);
  const memory = new MemoryAdapter();
  return { store, product, plan, id: row.id, memory };
}

async function rejectedFixture() {
  const s = setup();
  await new Engine(s.store, s.memory).run(s.id, "submit");
  const remoteId = s.store.get(s.id).remoteId!,
    remote = s.memory.records.get(remoteId)!;
  remote.status = "已驳回";
  s.store.state(s.id, "REJECTED");
  const calls = { repair: 0 };
  const adapter: RejectionRepairAdapter = {
    checkShop: (shop) => s.memory.checkShop(shop),
    read: (itemId) => s.memory.read(itemId),
    repairRejected: async ({ itemId, plan }) => {
      calls.repair++;
      const snapshot = s.memory.records.get(itemId)!;
      snapshot.title = expectedFields(s.product, plan).title;
      snapshot.fields.title = snapshot.title;
      snapshot.specs["规格"] = plan.specs["规格"].value;
      snapshot.status = "待审核";
      return structuredClone(snapshot);
    },
  };
  return { ...s, remoteId, adapter, calls };
}

function repairedPlan(plan: Plan) {
  const next = structuredClone(plan);
  next.displayTitle = { ...next.specs["规格"], value: "示例品牌 一个装" };
  next.specs["规格"] = { ...next.specs["规格"], value: "一个装" };
  return next;
}

test("repairs only title and specification on the same rejected item", async () => {
  const s = await rejectedFixture();
  try {
    const row = await repairRejected(
      s.store,
      s.adapter,
      s.id,
      repairedPlan(s.plan),
    );
    assert.equal(row.state, "SUBMITTED");
    assert.equal(row.remoteId, s.remoteId);
    assert.equal(row.plan!.specs["规格"].value, "一个装");
    assert.equal(row.verifiedHash, row.dataHash);
    assert.equal(s.calls.repair, 1);
    assert.equal(s.store.pending(s.id), undefined);
  } finally {
    s.store.close();
  }
});

test("a completed local SUBMITTED repair is idempotently verified without another write", async () => {
  const s = await rejectedFixture();
  try {
    const next = repairedPlan(s.plan);
    const first = await repairRejected(s.store, s.adapter, s.id, next);
    assert.equal(first.state, "SUBMITTED");
    assert.equal(s.calls.repair, 1);

    const second = await repairRejected(s.store, s.adapter, s.id, next);

    assert.equal(second.state, "SUBMITTED");
    assert.equal(second.remoteId, s.remoteId);
    assert.equal(second.verifiedHash, second.dataHash);
    assert.equal(s.calls.repair, 1);
    assert.equal(s.store.pending(s.id), undefined);
  } finally {
    s.store.close();
  }
});

test("rejects changes outside title and specification before creating an intent", async () => {
  const s = await rejectedFixture();
  try {
    const next = repairedPlan(s.plan);
    next.price.value = "18.90";
    await assert.rejects(
      repairRejected(s.store, s.adapter, s.id, next),
      /displayTitle|规格字段/,
    );
    assert.equal(s.calls.repair, 0);
    assert.equal(s.store.pending(s.id), undefined);
  } finally {
    s.store.close();
  }
});

test("keeps the submit intent pending when the combined remote action fails", async () => {
  const s = await rejectedFixture();
  try {
    s.adapter.repairRejected = async () => {
      s.calls.repair++;
      throw new Error("response lost");
    };
    await assert.rejects(
      repairRejected(s.store, s.adapter, s.id, repairedPlan(s.plan)),
      /response lost/,
    );
    assert.equal(s.store.get(s.id).state, "UNKNOWN_OUTCOME");
    assert.equal(s.store.pending(s.id)?.kind, "submit");
    assert.equal(s.store.get(s.id).remoteId, s.remoteId);
    assert.equal(s.calls.repair, 1);
  } finally {
    s.store.close();
  }
});

test("treats an already-consistent pending-review item as a read-only idempotent success", async () => {
  const s = await rejectedFixture();
  try {
    const next = repairedPlan(s.plan),
      remote = s.memory.records.get(s.remoteId)!;
    remote.title = expectedFields(s.product, next).title;
    remote.fields.title = remote.title;
    remote.specs["规格"] = next.specs["规格"].value;
    remote.status = "审核中";

    const row = await repairRejected(s.store, s.adapter, s.id, next);

    assert.equal(row.state, "SUBMITTED");
    assert.equal(row.remoteId, s.remoteId);
    assert.equal(row.verifiedHash, row.dataHash);
    assert.equal(s.calls.repair, 0);
    assert.equal(s.store.pending(s.id), undefined);
  } finally {
    s.store.close();
  }
});

test("refuses an existing pending operation without reading or replaying", async () => {
  const s = await rejectedFixture();
  try {
    s.store.intent(s.id, "submit");
    let reads = 0;
    s.adapter.read = async (id) => {
      reads++;
      return s.memory.read(id);
    };
    await assert.rejects(
      repairRejected(s.store, s.adapter, s.id, repairedPlan(s.plan)),
      (error: unknown) =>
        error instanceof PipelineError && error.code === "UNKNOWN_OUTCOME",
    );
    assert.equal(reads, 0);
    assert.equal(s.calls.repair, 0);
  } finally {
    s.store.close();
  }
});

test("ready-for-sale repair requires an explicit per-call gate", async () => {
  const s = await rejectedFixture();
  try {
    s.memory.records.get(s.remoteId)!.status = "待上架";
    await assert.rejects(
      repairRejected(s.store, s.adapter, s.id, repairedPlan(s.plan)),
      /未显式允许/,
    );
    assert.equal(s.calls.repair, 0);

    const row = await repairRejected(
      s.store,
      s.adapter,
      s.id,
      repairedPlan(s.plan),
      { allowReadyForSale: true },
    );
    assert.equal(row.state, "SUBMITTED");
    assert.equal(row.remoteId, s.remoteId);
    assert.equal(s.calls.repair, 1);
  } finally {
    s.store.close();
  }
});

test("explicit ready-for-sale gate never permits an on-sale item", async () => {
  for (const status of ["在售", "已上架"] as const) {
    const s = await rejectedFixture();
    try {
      s.memory.records.get(s.remoteId)!.status = status;
      await assert.rejects(
        repairRejected(s.store, s.adapter, s.id, repairedPlan(s.plan), {
          allowReadyForSale: true,
        }),
        /未显式允许/,
      );
      assert.equal(s.calls.repair, 0);
      assert.equal(s.store.pending(s.id), undefined);
    } finally {
      s.store.close();
    }
  }
});

test("HZ pause blocks before account checks or creation of a repair intent", async () => {
  const s = await rejectedFixture();
  try {
    let checks = 0,
      reads = 0;
    s.adapter.checkShop = async () => {
      checks++;
    };
    s.adapter.read = async (id) => {
      reads++;
      return s.memory.read(id);
    };
    s.store.pause("hz:" + s.plan.shop, "operator pause", "test");

    await assert.rejects(
      repairRejected(s.store, s.adapter, s.id, repairedPlan(s.plan)),
      (error: unknown) =>
        error instanceof PipelineError && error.code === "PAUSED",
    );

    assert.equal(checks, 0);
    assert.equal(reads, 0);
    assert.equal(s.calls.repair, 0);
    assert.equal(s.store.pending(s.id), undefined);
  } finally {
    s.store.close();
  }
});

test("a pause appearing after the account check still blocks before remote repair", async () => {
  const s = await rejectedFixture();
  try {
    s.adapter.checkShop = async () => {
      s.store.pause("hz:" + s.plan.shop, "late operator pause", "test-late");
    };

    await assert.rejects(
      repairRejected(s.store, s.adapter, s.id, repairedPlan(s.plan)),
      (error: unknown) =>
        error instanceof PipelineError && error.code === "PAUSED",
    );

    assert.equal(s.calls.repair, 0);
    assert.equal(s.store.pending(s.id), undefined);
    assert.equal(s.store.get(s.id).remoteId, s.remoteId);
  } finally {
    s.store.close();
  }
});
