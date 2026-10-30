import { test } from "node:test";
import assert from "node:assert/strict";
import { readExactItem } from "../src/browser/exact-item.js";

type Response = { totalCount: number; result: unknown[] | null };
type Call = { args: Record<string, unknown>; mode: string };

const moduleSource = `
export async function exactList(args, mode) {
  globalThis.__exactItemCalls.push({ args: structuredClone(args), mode });
  const response = globalThis.__exactItemResponses.shift();
  if (response instanceof Error) throw response;
  return response;
}`;
const moduleUrl = `data:text/javascript,${encodeURIComponent(moduleSource)}`;

function harness(responses: Response[]) {
  const calls: Call[] = [];
  Object.assign(globalThis, {
    document: {
      scripts: [{ src: "https://b.csgmall.com.cn/index-current.js" }],
    },
    __exactItemCalls: calls,
    __exactItemResponses: [...responses],
  });
  const resolver = async (paths: string[]) => {
    assert.deepEqual(paths, ["https://b.csgmall.com.cn/index-current.js"]);
    return { path: moduleUrl, exports: { list: "exactList" } };
  };
  return {
    calls,
    read: () =>
      readExactItem("990911001087", "900000000008", "测试店铺", resolver),
  };
}

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: "990911001087",
    shopId: 900000000008,
    shopName: "测试店铺",
    itemName: "测试商品",
    saleStatusView: "锁定",
    soldOutTypeDesc: "  已知下架原因  ",
    ...overrides,
  };
}

test("sends only the observed exact identity query and preserves list strings", async () => {
  const h = harness([{ totalCount: 1, result: [row()] }]);
  assert.deepEqual(await h.read(), {
    itemId: "990911001087",
    code: "990911001087",
    shop: "测试店铺",
    title: "测试商品",
    status: "锁定",
    platformWarning: "已知下架原因",
  });
  assert.deepEqual(h.calls, [
    {
      args: {
        pageNum: 1,
        pageSize: 10,
        queryItemIdList: ["990911001087"],
        shopId: 900000000008,
        hideStatus: 0,
      },
      mode: "none",
    },
  ]);
});

test("uses at most one exact draft retry and has no inventory scan fallback", async () => {
  const h = harness([
    { totalCount: 0, result: [] },
    { totalCount: 1, result: [row({ soldOutTypeDesc: null })] },
  ]);
  assert.equal((await h.read()).platformWarning, null);
  assert.equal(h.calls.length, 2);
  assert.deepEqual(h.calls[0].args, {
    pageNum: 1,
    pageSize: 10,
    queryItemIdList: ["990911001087"],
    shopId: 900000000008,
    hideStatus: 0,
  });
  assert.deepEqual(h.calls[1].args, {
    ...h.calls[0].args,
    itemStatusList: ["99"],
  });

  const absent = harness([
    { totalCount: 0, result: null },
    { totalCount: 0, result: [] },
  ]);
  await assert.rejects(absent.read(), /Exact item was not uniquely returned/);
  assert.equal(absent.calls.length, 2);
  assert.ok(
    absent.calls.every(
      ({ args }) =>
        Array.isArray(args.queryItemIdList) &&
        args.queryItemIdList.length === 1 &&
        args.shopId === 900000000008,
    ),
  );
});

test("current rejection retains all observed review reason fields without duplicate text", async () => {
  const data = row({
    saleStatusView: "已驳回",
    soldOutTypeDesc: null,
    rejectReason: "其他",
    contentRejectReason: "其他",
    contentRejectRemark: "商品标题审核：标题需标明型号",
    refusalReason: "商品标题审核：标题需标明型号",
    categoryRejectRemark: "类目问题",
  });
  assert.equal(
    (await harness([{ totalCount: 1, result: [data] }]).read()).platformWarning,
    "其他；商品标题审核：标题需标明型号；类目问题",
  );
  assert.equal(
    (
      await harness([
        { totalCount: 1, result: [{ ...data, saleStatusView: "待审核" }] },
      ]).read()
    ).platformWarning,
    null,
  );
});

test("fails closed on wrong identity and duplicate list results", async (t) => {
  for (const [name, changed] of [
    ["item", { id: "990911001088" }],
    ["shop id", { shopId: 900000000009 }],
    ["shop name", { shopName: "其他店铺" }],
  ] as const) {
    await t.test(name, async () => {
      await assert.rejects(
        harness([{ totalCount: 1, result: [row(changed)] }]).read(),
        /Exact item or shop differs/,
      );
    });
  }
  await t.test("duplicate", async () => {
    await assert.rejects(
      harness([{ totalCount: 2, result: [row(), row()] }]).read(),
      /Exact item was not uniquely returned/,
    );
  });
});

test("requires authoritative status, title and warning-column presence", async (t) => {
  for (const [name, changed, message] of [
    ["missing status", { saleStatusView: undefined }, /status\/title missing/],
    ["blank status", { saleStatusView: " " }, /status\/title missing/],
    ["missing title", { itemName: undefined }, /status\/title missing/],
    [
      "changed warning type",
      { soldOutTypeDesc: 1 },
      /warning column missing or changed/,
    ],
  ] as const) {
    await t.test(name, async () => {
      await assert.rejects(
        harness([{ totalCount: 1, result: [row(changed)] }]).read(),
        message,
      );
    });
  }
  await t.test("missing warning property", async () => {
    const value = row();
    delete value.soldOutTypeDesc;
    await assert.rejects(
      harness([{ totalCount: 1, result: [value] }]).read(),
      /warning column missing or changed/,
    );
  });
});

test("rejects malformed requested identities before loading the module", async () => {
  const resolver = async () => {
    throw Error("resolver must not run");
  };
  for (const [itemId, shopId] of [
    ["2609x", "900000000008"],
    ["990911001087", "2.5"],
    ["990911001087", "99999999999999999999"],
  ])
    await assert.rejects(
      readExactItem(itemId, shopId, "测试店铺", resolver),
      /Invalid exact item identity/,
    );
});
