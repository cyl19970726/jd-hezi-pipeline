import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.js";
import { Engine } from "../src/engine.js";
import { example, MemoryAdapter } from "../src/demo.js";
import {
  money,
  parseSku,
  PipelineError,
  validate,
  verify,
  digest,
  identity,
} from "../src/model.js";

function setup() {
  const store = new Store(":memory:");
  const { product, plan } = example();
  const row = store.put(plan.shop, product);
  store.setPlan(row.id, plan);
  const adapter = new MemoryAdapter();
  return {
    store,
    product,
    plan,
    id: row.id,
    adapter,
    engine: new Engine(store, adapter),
  };
}
test("same source identity is deterministic, variant and shop remain isolated", () => {
  assert.equal(identity("a", "1"), identity("a", "1"));
  assert.notEqual(identity("a", "1"), identity("b", "1"));
  assert.notEqual(identity("a", "1"), identity("a", "1", "red"));
});
test("prices preserve decimals and never use sentinel values", () => {
  assert.equal(money("￥1,099.90"), "1099.90");
  assert.equal(money("999"), "999.00");
  assert.equal(money("券后19 原价29"), null);
  assert.equal(money("unknown"), null);
  assert.equal(money("0"), null);
});
test("SKU URL rejects lookalike hosts", () => {
  assert.throws(() => parseSku("https://item.jd.com.evil.test/12.html"));
  assert.equal(parseSku("https://item.jd.com/12.html?x=1"), "12");
});
test("repeat publishing creates one remote item and submits once", async () => {
  const s = setup();
  try {
    await s.engine.run(s.id, "submit");
    await s.engine.run(s.id, "submit");
    assert.equal(s.adapter.saves, 1);
    assert.equal(s.adapter.submits, 1);
    assert.equal(s.store.get(s.id).state, "SUBMITTED");
  } finally {
    s.store.close();
  }
});
test("draft terminal never submits", async () => {
  const s = setup();
  try {
    assert.equal((await s.engine.run(s.id)).state, "DRAFT_VERIFIED");
    assert.equal(s.adapter.submits, 0);
  } finally {
    s.store.close();
  }
});
test("competitive pricing without persisted proof cannot reach a remote write", async () => {
  const s = setup();
  try {
    const plan = {
      ...s.plan,
      rulesVersion: "catalog-competitive-v1",
      competitivePricingReviewId: "11111111-1111-4111-8111-111111111111",
      catalogBinding: { brandId: "brand", categoryId: "category" },
      price: {
        ...s.plan.price,
        value: "19.70",
        basis: "competitor-bounded" as const,
      },
    };
    assert.deepEqual(validate(s.product, plan), []);
    s.store.setPlan(s.id, plan);
    await assert.rejects(s.engine.run(s.id, "submit"), /竞品定价复核不存在/);
    assert.equal(s.adapter.saves, 0);
    assert.equal(s.adapter.submits, 0);
    const withoutProof = { ...plan, competitivePricingReviewId: undefined };
    assert.ok(
      validate(s.product, withoutProof).some((error) =>
        error.includes("持久化复核"),
      ),
    );
  } finally {
    s.store.close();
  }
});
test("direct reconciliation respects Hezi pause before remote reads", async () => {
  const s = setup();
  try {
    let calls = 0;
    s.adapter.checkShop = async () => {
      calls++;
    };
    s.store.pause(`hz:${s.plan.shop}`, { code: "RATE_LIMITED" }, "test-risk");
    await assert.rejects(
      s.engine.reconcile(s.id),
      (error: unknown) =>
        error instanceof PipelineError && error.code === "PAUSED",
    );
    assert.equal(calls, 0);
    assert.equal(s.store.get(s.id).remoteId, null);
  } finally {
    s.store.close();
  }
});
test("lost detail after save blocks submit and retains remote identity", async () => {
  const s = setup();
  try {
    const read = s.adapter.read.bind(s.adapter);
    s.adapter.read = async (id) => {
      const r = await read(id);
      r.detailImages = [];
      return r;
    };
    await assert.rejects(s.engine.run(s.id, "submit"));
    assert.equal(s.adapter.submits, 0);
    assert.equal(s.store.get(s.id).remoteId, "100001");
    assert.equal(s.store.get(s.id).state, "NEEDS_INPUT");
  } finally {
    s.store.close();
  }
});
test("same image count with wrong references also blocks submit", async () => {
  const s = setup();
  try {
    const read = s.adapter.read.bind(s.adapter);
    s.adapter.read = async (id) => {
      const r = await read(id);
      r.detailImages[0].url = "https://wrong.example/image.jpg";
      return r;
    };
    await assert.rejects(s.engine.run(s.id, "submit"));
    assert.equal(s.adapter.submits, 0);
  } finally {
    s.store.close();
  }
});
test("save succeeded remotely then crashed: no blind recreation", async () => {
  const s = setup();
  try {
    const save = s.adapter.save.bind(s.adapter);
    s.adapter.save = async (...args) => {
      await save(...args);
      throw new Error("response lost");
    };
    await assert.rejects(s.engine.run(s.id));
    assert.equal(s.store.get(s.id).state, "UNKNOWN_OUTCOME");
    await assert.rejects(s.engine.run(s.id));
    assert.equal(s.adapter.saves, 1);
    const row = await s.engine.reconcile(s.id);
    assert.equal(row.remoteId, "100001");
    assert.equal(row.state, "NEEDS_INPUT");
    assert.equal(s.store.pending(s.id), undefined);
  } finally {
    s.store.close();
  }
});
test("submit succeeded then connection lost: reconciliation observes status without resubmission", async () => {
  const s = setup();
  try {
    const submit = s.adapter.submit.bind(s.adapter);
    s.adapter.submit = async (id) => {
      await submit(id);
      throw new Error("connection lost");
    };
    await assert.rejects(s.engine.run(s.id, "submit"));
    assert.equal(s.store.get(s.id).state, "UNKNOWN_OUTCOME");
    assert.equal((await s.engine.reconcile(s.id)).state, "SUBMITTED");
    assert.equal(s.adapter.submits, 1);
  } finally {
    s.store.close();
  }
});
test("incomplete lookup never authorizes creation", async () => {
  const s = setup();
  try {
    s.adapter.find = async () => ({ complete: false, records: [] });
    await assert.rejects(s.engine.run(s.id));
    assert.equal(s.adapter.saves, 0);
  } finally {
    s.store.close();
  }
});
test("duplicate remote candidates never authorize creation", async () => {
  const s = setup();
  try {
    const a = await s.adapter.save(s.product, s.plan, null);
    s.adapter.find = async () => ({
      complete: true,
      records: [a, { ...a, itemId: "999999" }],
    });
    await assert.rejects(s.engine.run(s.id));
    assert.equal(s.adapter.saves, 1);
  } finally {
    s.store.close();
  }
});
test("expired HZ login pauses platform without creating a global shop pause", async () => {
  const s = setup();
  try {
    s.adapter.checkShop = async () => {
      throw new PipelineError("AUTH_REQUIRED", "登录失效");
    };
    await assert.rejects(s.engine.run(s.id));
    assert.ok(s.store.meta("pause:hz:" + s.plan.shop));
    assert.equal(s.store.meta("pause:" + s.plan.shop), null);
    assert.equal(s.adapter.saves, 0);
  } finally {
    s.store.close();
  }
});
test("shop mismatch blocks before mutation", async () => {
  const s = setup();
  try {
    s.adapter.checkShop = async () => {
      throw new PipelineError("ACCOUNT_CHANGED", "账号变更");
    };
    await assert.rejects(s.engine.run(s.id));
    assert.equal(s.adapter.saves, 0);
  } finally {
    s.store.close();
  }
});
test("business denial is recorded, not generalized to unrelated products", async () => {
  const s = setup();
  try {
    s.adapter.submit = async () => {
      throw new PipelineError("BUSINESS_BLOCKED", "请先维护品牌资质信息");
    };
    await assert.rejects(s.engine.run(s.id, "submit"));
    assert.match(s.store.get(s.id).error!, /品牌资质/);
    assert.equal(s.store.meta("pause:" + s.plan.shop), null);
  } finally {
    s.store.close();
  }
});
test("changed rules invalidate verification, retain original itemId", async () => {
  const s = setup();
  try {
    await s.engine.run(s.id);
    const old = s.store.get(s.id);
    s.plan.inventory = "29";
    s.store.setPlan(s.id, s.plan);
    const next = s.store.get(s.id);
    assert.equal(next.remoteId, old.remoteId);
    assert.equal(next.verifiedHash, null);
    assert.notEqual(next.dataHash, old.dataHash);
    await s.engine.run(s.id);
    assert.equal(s.adapter.records.size, 1);
  } finally {
    s.store.close();
  }
});
test("pending operation forbids changing source or plan", () => {
  const s = setup();
  try {
    s.store.intent(s.id, "save");
    s.plan.rulesVersion = "changed";
    assert.throws(() => s.store.setPlan(s.id, s.plan));
    s.product.title.value = "new";
    assert.throws(() => s.store.put(s.plan.shop, s.product));
  } finally {
    s.store.close();
  }
});
test("concurrent publisher cannot acquire lock, no automatic lease stealing", () => {
  const s = setup();
  try {
    const unlock = s.store.lock("publisher");
    assert.throws(() => s.store.lock("publisher"));
    assert.equal(s.store.recoverLocks(), 0);
    unlock();
    const again = s.store.lock("publisher");
    again();
  } finally {
    s.store.close();
  }
});
test("invalid ID cannot be bound, remote identity cannot be replaced", () => {
  const s = setup();
  try {
    assert.throws(() => s.store.bind(s.id, "预览 商品标题", "123"));
    s.store.bind(s.id, "123", "456");
    assert.throws(() => s.store.bind(s.id, "789", "789"));
  } finally {
    s.store.close();
  }
});
test("product row and pending operation survive database reopen", () => {
  const dir = mkdtempSync(join(tmpdir(), "hezi-test-"));
  try {
    let st = new Store(join(dir, "state.sqlite"));
    const { product, plan } = example();
    const r = st.put(plan.shop, product);
    st.setPlan(r.id, plan);
    st.intent(r.id, "save");
    st.close();
    st = new Store(join(dir, "state.sqlite"));
    assert.equal(st.get(r.id).sku, product.sku);
    assert.equal(st.pending(r.id)?.kind, "save");
    st.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("count-based net contents and expired authorization fail validation", () => {
  const { product, plan } = example();
  plan.specs["总净含量"].value = "1盒";
  plan.authorization.checkedAt = "2020-01-01T00:00:00.000Z";
  const errors = validate(product, plan);
  assert.ok(errors.some((e) => e.includes("质量或体积")));
  assert.ok(errors.some((e) => e.includes("资质")));
});
test("read-back accepts only mL capitalization for total net content", async () => {
  const { product, plan } = example();
  plan.specs["总净含量"].value = "1000mL";
  const adapter = new MemoryAdapter();
  const record = await adapter.save(product, plan, null);
  const snapshot = await adapter.read(record.itemId);
  const totalNetContentError = () =>
    verify(snapshot, product, plan, record.mediaReferences).some((error) =>
      error.includes("规格 总净含量"),
    );

  for (const actual of ["1000ML", "1000ml"] as const) {
    snapshot.specs["总净含量"] = actual;
    assert.equal(totalNetContentError(), false, actual);
  }
  for (const actual of ["1000L", "1000mg", "500ML", "1000Ml"] as const) {
    snapshot.specs["总净含量"] = actual;
    assert.equal(totalNetContentError(), true, actual);
  }
  snapshot.specs.规格 = "单件装A";
  assert.equal(
    verify(snapshot, product, plan, record.mediaReferences).some((error) =>
      error.includes("规格 规格"),
    ),
    true,
  );
});
test("net content retains its existing case-insensitive compatibility", async () => {
  const { product, plan } = example();
  plan.specs["净含量"] = { ...plan.specs["总净含量"], value: "原装ABC" };
  const adapter = new MemoryAdapter();
  const record = await adapter.save(product, plan, null);
  const snapshot = await adapter.read(record.itemId);
  snapshot.specs["净含量"] = "原装abc";
  assert.equal(
    verify(snapshot, product, plan, record.mediaReferences).some((error) =>
      error.includes("规格 净含量"),
    ),
    false,
  );
});
test("missing required field prevents verified state despite successful save", async () => {
  const s = setup();
  try {
    const read = s.adapter.read.bind(s.adapter);
    s.adapter.read = async (id) => ({
      ...(await read(id)),
      requiredMissing: ["加热器数量"],
    });
    await assert.rejects(s.engine.run(s.id, "submit"));
    assert.equal(s.adapter.submits, 0);
  } finally {
    s.store.close();
  }
});

test("verification rejects inherited values that the plan explicitly clears", async () => {
  const { product, plan } = example();
  const adapter = new MemoryAdapter();
  const record = await adapter.save(product, plan, null);
  const snapshot = await adapter.read(record.itemId);
  delete plan.fields.length;
  plan.clearFields = ["length"];
  snapshot.fields.length = "400";
  assert.ok(
    verify(snapshot, product, plan, record.mediaReferences).some((e) =>
      e.includes("应清空"),
    ),
  );
});

test("replacement preserves old identity, records new binding atomically and cannot repeat", () => {
  const s = setup();
  try {
    s.store.bind(s.id, "100", "100");
    const op = s.store.beginReplacement(s.id, {
      itemId: "100",
      hasOrderInfo: 0,
      status: "待提交",
      reason: "legacy fields cannot be cleared",
    });
    assert.equal(s.store.get(s.id).remoteId, "100");
    assert.throws(() =>
      s.store.beginReplacement(s.id, {
        itemId: "100",
        hasOrderInfo: 0,
        status: "待提交",
        reason: "retry",
      }),
    );
    assert.throws(() =>
      s.store.completeReplacement(s.id, op, {
        itemId: "101",
        code: "101",
        shop: "wrong",
        sku: s.product.sku,
      }),
    );
    assert.ok(s.store.pending(s.id));
    s.store.completeReplacement(s.id, op, {
      itemId: "101",
      code: "101",
      shop: s.plan.shop,
      sku: s.product.sku,
    });
    assert.equal(s.store.get(s.id).remoteId, "101");
    assert.equal(s.store.replacement(s.id)?.old_id, "100");
    assert.equal(s.store.pending(s.id), undefined);
  } finally {
    s.store.close();
  }
});
test("replacement refuses order-bearing or submitted records", () => {
  const s = setup();
  try {
    s.store.bind(s.id, "100", "100");
    assert.throws(() =>
      s.store.beginReplacement(s.id, {
        itemId: "100",
        hasOrderInfo: 1,
        status: "待提交",
        reason: "bad data",
      }),
    );
    assert.throws(() =>
      s.store.beginReplacement(s.id, {
        itemId: "100",
        hasOrderInfo: 0,
        status: "待审核",
        reason: "bad data",
      }),
    );
    assert.equal(s.store.replacement(s.id), undefined);
  } finally {
    s.store.close();
  }
});
test("pending replacement quarantines old record from ordinary publishing", async () => {
  const s = setup();
  try {
    s.store.bind(s.id, "100", "100");
    s.store.beginReplacement(s.id, {
      itemId: "100",
      hasOrderInfo: 0,
      status: "草稿",
      reason: "bad data",
    });
    await assert.rejects(s.engine.run(s.id, "submit"));
    assert.equal(s.adapter.submits, 0);
    assert.equal(s.adapter.saves, 0);
  } finally {
    s.store.close();
  }
});
test("after-sales mismatch blocks acceptance even when basic fields and media match", async () => {
  const s = setup();
  try {
    const fact = { ...s.product.title, value: "30" };
    s.plan.afterSales = {
      refund: fact,
      exchange: fact,
      warranty: { ...fact, value: "0" },
    };
    s.store.setPlan(s.id, s.plan);
    await s.engine.run(s.id, "draft");
    const snap = await s.adapter.read(s.store.get(s.id).remoteId!);
    snap.fields.after_warranty = "12";
    assert.ok(
      verify(snap, s.product, s.plan).some((x) => x.includes("after_warranty")),
    );
  } finally {
    s.store.close();
  }
});

test("legacy unlabelled prices and mismatched subsidy cannot be published", async () => {
  const s = setup();
  try {
    delete s.product.price!.basis;
    s.store.put(s.plan.shop, s.product);
    s.store.setPlan(s.id, s.plan);
    await assert.rejects(s.engine.run(s.id), (e: any) =>
      e.details.some((x: string) => x.includes("补贴价")),
    );
    assert.equal(s.adapter.records.size, 0);
    s.product.price!.basis = "subsidy";
    s.plan.price.value = "1.00";
    assert.ok(validate(s.product, s.plan).some((x) => x.includes("不一致")));
  } finally {
    s.store.close();
  }
});

test("pending withdrawal is not acknowledged while remote remains under review", async () => {
  const s = setup();
  try {
    await s.engine.run(s.id, "submit");
    s.store.intent(s.id, "withdraw");
    s.store.state(s.id, "UNKNOWN_OUTCOME");
    await assert.rejects(s.engine.reconcile(s.id), /撤回/);
    assert.equal(s.store.pending(s.id)?.kind, "withdraw");
    assert.equal(s.store.get(s.id).state, "UNKNOWN_OUTCOME");
    assert.equal(s.adapter.submits, 1);
  } finally {
    s.store.close();
  }
});

test("reconcile records a rejected bound item without changing identity or resubmitting", async () => {
  const s = setup();
  try {
    await s.engine.run(s.id, "submit");
    const remoteId = s.store.get(s.id).remoteId!,
      remote = s.adapter.records.get(remoteId)!;
    remote.status = "审核不通过";
    remote.platformWarning = "规格应填一个装";

    const row = await s.engine.reconcile(s.id);

    assert.equal(row.state, "REJECTED");
    assert.equal(row.remoteId, remoteId);
    assert.equal(s.store.pending(s.id), undefined);
    assert.match(row.error!, /规格应填一个装/);
    assert.equal(s.adapter.submits, 1);
  } finally {
    s.store.close();
  }
});

test("run observes rejection and stops before an unchanged automatic resubmit", async () => {
  const s = setup();
  try {
    await s.engine.run(s.id, "submit");
    const remoteId = s.store.get(s.id).remoteId!,
      remote = s.adapter.records.get(remoteId)!;
    remote.status = "已驳回";

    const row = await s.engine.run(s.id, "submit");

    assert.equal(row.state, "REJECTED");
    assert.equal(row.remoteId, remoteId);
    assert.equal(s.adapter.submits, 1);
    assert.equal(s.store.pending(s.id), undefined);
  } finally {
    s.store.close();
  }
});

test("lost withdrawal response recovers only from the original item in an editable draft state", async () => {
  const s = setup();
  try {
    await s.engine.run(s.id, "submit");
    const remoteId = s.store.get(s.id).remoteId!;
    s.store.intent(s.id, "withdraw");
    s.store.state(s.id, "UNKNOWN_OUTCOME");
    s.adapter.records.get(remoteId)!.status = "待提交";
    const row = await s.engine.reconcile(s.id);
    assert.equal(row.state, "DRAFT_VERIFIED");
    assert.equal(row.remoteId, remoteId);
    assert.equal(s.store.pending(s.id), undefined);
    assert.equal(s.adapter.saves, 1);
    assert.equal(s.adapter.submits, 1);
  } finally {
    s.store.close();
  }
});

test("withdrawal preserves original identity and repeated draft withdrawal performs no write", async () => {
  const s = setup();
  let calls = 0;
  const adapter = Object.assign(s.adapter, {
    withdraw: async (id: string) => {
      calls++;
      s.adapter.records.get(id)!.status = "待提交";
      return s.adapter.read(id);
    },
  });
  const engine = new Engine(s.store, adapter);
  try {
    await engine.run(s.id, "submit");
    const remoteId = s.store.get(s.id).remoteId;
    await engine.withdraw(s.id);
    await engine.withdraw(s.id);
    assert.equal(calls, 1);
    assert.equal(s.store.get(s.id).remoteId, remoteId);
    assert.equal(s.store.get(s.id).state, "DRAFT_SAVED");
    assert.equal(s.adapter.saves, 1);
  } finally {
    s.store.close();
  }
});
test("lost withdrawal response retains intent until reconciliation and never repeats withdrawal", async () => {
  const s = setup();
  let calls = 0;
  const adapter = Object.assign(s.adapter, {
    withdraw: async (id: string) => {
      calls++;
      s.adapter.records.get(id)!.status = "待提交";
      throw Error("response lost");
    },
  });
  const engine = new Engine(s.store, adapter);
  try {
    await engine.run(s.id, "submit");
    await assert.rejects(engine.withdraw(s.id), /response lost/);
    await assert.rejects(engine.withdraw(s.id), /对账/);
    assert.equal(s.store.pending(s.id)?.kind, "withdraw");
    assert.equal((await engine.reconcile(s.id)).state, "DRAFT_VERIFIED");
    assert.equal(calls, 1);
  } finally {
    s.store.close();
  }
});
test("an on-sale item cannot be withdrawn as if it were pending review", async () => {
  const s = setup();
  let calls = 0;
  const adapter = Object.assign(s.adapter, {
    withdraw: async (id: string) => {
      calls++;
      return s.adapter.read(id);
    },
  });
  try {
    await s.engine.run(s.id, "submit");
    s.adapter.records.get(s.store.get(s.id).remoteId!)!.status = "在售";
    await assert.rejects(
      new Engine(s.store, adapter).withdraw(s.id),
      /不能撤回/,
    );
    assert.equal(calls, 0);
    assert.equal(s.store.pending(s.id), undefined);
  } finally {
    s.store.close();
  }
});

test("bottle specification accepts observed mL spelling without relaxing quantity or identity", async () => {
  const { product, plan } = example();
  plan.specs["规格"] = { ...plan.specs["总净含量"], value: "600mL×1瓶" };
  const adapter = new MemoryAdapter();
  const record = await adapter.save(product, plan, null);
  const snapshot = await adapter.read(record.itemId);
  const mismatches = () =>
    verify(snapshot, product, plan, record.mediaReferences).some((e) =>
      e.includes("规格 规格"),
    );
  for (const value of ["600ml×1瓶", "600ML×1瓶"]) {
    snapshot.specs["规格"] = value;
    assert.equal(mismatches(), false, value);
  }
  for (const value of [
    "600L×1瓶",
    "500ml×1瓶",
    "600ml×2瓶",
    "600ml×1盒",
    "600Ml×1瓶",
  ]) {
    snapshot.specs["规格"] = value;
    assert.equal(mismatches(), true, value);
  }
  plan.specs["规格"].value = "型号ML-A";
  snapshot.specs["规格"] = "型号ml-A";
  assert.equal(mismatches(), true);
});

test("explicit same-SKU media failure before save closes only that unsent intent", async () => {
  const s = setup();
  try {
    s.adapter.save = async () => {
      throw new PipelineError(
        "UI_CHANGED",
        "平台上传返回无效图片，已在保存前停止",
        {
          phase: "media-upload",
          saveDispatched: false,
          sku: s.product.sku,
          shop: s.plan.shop,
        },
      );
    };
    await assert.rejects(s.engine.run(s.id, "submit"));
    assert.equal(s.store.pending(s.id), undefined);
    assert.equal(s.store.get(s.id).state, "NEEDS_INPUT");
    assert.equal(s.adapter.submits, 0);
    const op = s.store.db
      .prepare("select status,receipt from operations where product_id=?")
      .get(s.id)!;
    assert.equal(op.status, "not_applied");
    assert.equal(JSON.parse(String(op.receipt)).reason, "save-not-dispatched");
  } finally {
    s.store.close();
  }
});

test("structured media wait timeout before save leaves no pending intent", async () => {
  const s = setup();
  try {
    s.adapter.save = async () => {
      throw new PipelineError(
        "UI_CHANGED",
        "平台图片上传等待超时，已在保存前停止",
        {
          phase: "media-upload",
          saveDispatched: false,
          sku: s.product.sku,
          shop: s.plan.shop,
          role: "main",
          expectedCount: 4,
          images: [],
        },
      );
    };
    await assert.rejects(s.engine.run(s.id, "submit"));
    assert.equal(s.store.pending(s.id), undefined);
    assert.equal(s.store.get(s.id).state, "NEEDS_INPUT");
    assert.equal(s.adapter.submits, 0);
  } finally {
    s.store.close();
  }
});

test("missing or mismatched pre-save proof keeps the save outcome unknown", async () => {
  for (const detail of [
    null,
    {
      phase: "media-upload",
      saveDispatched: false,
      sku: "wrong",
      shop: "wrong",
    },
    { phase: "media-upload", saveDispatched: true },
  ]) {
    const s = setup();
    try {
      s.adapter.save = async () => {
        throw new PipelineError(
          "UI_CHANGED",
          "平台上传返回无效图片，已在保存前停止",
          detail,
        );
      };
      await assert.rejects(s.engine.run(s.id, "submit"));
      assert.ok(s.store.pending(s.id));
      assert.equal(s.store.get(s.id).state, "UNKNOWN_OUTCOME");
    } finally {
      s.store.close();
    }
  }
});

test("a platform-title mismatch closes only an explicitly undispatched save", async () => {
  for (const message of [
    "平台自动生成标题与已核验计划不一致",
    "平台标题命名方式与已核验计划不一致",
  ])
    for (const dispatched of [false, true]) {
      const s = setup();
      try {
        s.adapter.save = async () => {
          throw new PipelineError("VALIDATION_MISSING", message, {
            phase: "title-validation",
            saveDispatched: dispatched,
            sku: s.product.sku,
            shop: s.plan.shop,
          });
        };
        await assert.rejects(s.engine.run(s.id, "submit"));
        assert.equal(Boolean(s.store.pending(s.id)), dispatched);
        assert.equal(
          s.store.get(s.id).state,
          dispatched ? "UNKNOWN_OUTCOME" : "NEEDS_INPUT",
        );
        assert.equal(s.adapter.submits, 0);
      } finally {
        s.store.close();
      }
    }
});

test("updated regular-first policy blocks cached plans before any remote creation", async () => {
  const s = setup();
  try {
    s.store.setMeta("listing-price:" + s.plan.shop, "jd-regular-preferred");
    s.store.setMeta(
      "listing-price-effective-at:" + s.plan.shop,
      new Date(Date.now() + 1000).toISOString(),
    );
    await assert.rejects(
      () => s.engine.run(s.id, "submit"),
      /旧报价必须重新采集/,
    );
    assert.equal(s.store.get(s.id).remoteId, null);
    assert.equal(
      s.store.db.prepare("SELECT COUNT(*) AS n FROM operations").get()?.n,
      0,
    );
  } finally {
    s.store.close();
  }
});

test("clip model readback accepts observed Latin suffix casing only within the clip category", async () => {
  const { product, plan } = example();
  plan.catalogBinding = { brandId: "fixture-brand", categoryId: "10049005" };
  plan.specs.型号 = { ...plan.specs.规格, value: "1234ES" };
  const adapter = new MemoryAdapter();
  const record = await adapter.save(product, plan, null);
  const snapshot = await adapter.read(record.itemId);
  const errors = () =>
    verify(snapshot, product, plan, record.mediaReferences).filter((x) =>
      x.includes("规格 型号"),
    );
  snapshot.specs.型号 = "1234es";
  assert.equal(errors().length, 0);
  for (const value of ["1235es", "1234e", "1234-es", "1234", "1234ab", ""]) {
    snapshot.specs.型号 = value;
    assert.equal(errors().length, 1, value);
  }
  snapshot.specs.型号 = "1234es";
  plan.catalogBinding.categoryId = "other-category";
  assert.equal(errors().length, 1);
});

test("pen writing width accepts only the observed millimeter case change", async () => {
  const { product, plan } = example();
  plan.catalogBinding = { brandId: "fixture-brand", categoryId: "10041013" };
  plan.specs.书写粗细 = { ...plan.specs.规格, value: "0.5mm" };
  const adapter = new MemoryAdapter();
  const record = await adapter.save(product, plan, null);
  const snapshot = await adapter.read(record.itemId);
  const errors = () =>
    verify(snapshot, product, plan, record.mediaReferences).filter((x) =>
      x.includes("规格 书写粗细"),
    );
  snapshot.specs.书写粗细 = "0.5MM";
  assert.equal(errors().length, 0);
  for (const value of ["0.7MM", "0.5CM", "0.5", "", "5MM"]) {
    snapshot.specs.书写粗细 = value;
    assert.equal(errors().length, 1, value);
  }
  snapshot.specs.书写粗细 = "0.5MM";
  plan.catalogBinding.categoryId = "other-category";
  assert.equal(errors().length, 1);
});

test("copy paper readback accepts only observed A4 case within its paper-size field", async () => {
  const { product, plan } = example();
  plan.catalogBinding = { brandId: "fixture-brand", categoryId: "10015007" };
  plan.specs.纸张尺寸 = { ...plan.specs.规格, value: "A4" };
  const adapter = new MemoryAdapter();
  const record = await adapter.save(product, plan, null);
  const snapshot = await adapter.read(record.itemId);
  const errors = () =>
    verify(snapshot, product, plan, record.mediaReferences).filter((x) =>
      x.includes("规格 纸张尺寸"),
    );
  snapshot.specs.纸张尺寸 = "a4";
  assert.equal(errors().length, 0);
  for (const value of ["a3", "b4", "4", "", "A4加厚"]) {
    snapshot.specs.纸张尺寸 = value;
    assert.equal(errors().length, 1, value);
  }
  snapshot.specs.纸张尺寸 = "a4";
  plan.catalogBinding.categoryId = "other-category";
  assert.equal(errors().length, 1);
});
