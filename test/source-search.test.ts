import test from "node:test";
import assert from "node:assert/strict";
import { parseHTML } from "linkedom";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.js";
import {
  readSourceSearchCards,
  searchSourceCandidates,
  SOURCE_SEARCH_PARSER,
} from "../src/browser/source-search.js";

test("search cards preserve SKU identity, discard tracking domains and never infer pack facts", () => {
  const { document } = parseHTML(
    `<a href="//item.jd.com/123.html">品牌 抽纸 200抽</a><a href="https://evil.example/123.html">相似商品</a><a href="https://item.jd.com/123.html?ad=1" title="品牌 抽纸 200抽 20包">详情</a><a href="https://item.jd.com/456.html">￥24.00</a><a href="https://item.jd.com/789.html">品牌 卷纸 12卷</a>`,
  );
  const previousDocument = (globalThis as any).document,
    previousLocation = (globalThis as any).location;
  Object.assign(globalThis, {
    document,
    location: { href: "https://search.jd.com/Search?keyword=纸" },
  });
  try {
    const result = new Function(
      `return (${readSourceSearchCards.toString()})`,
    )()({ query: "纸", limit: 1 });
    assert.deepEqual(result.candidates, [
      {
        sku: "123",
        url: "https://item.jd.com/123.html",
        title: "品牌 抽纸 200抽 20包",
      },
    ]);
    assert.throws(
      () => readSourceSearchCards({ query: "不同查询", limit: 5 }),
      /不一致/,
    );
  } finally {
    Object.assign(globalThis, {
      document: previousDocument,
      location: previousLocation,
    });
  }
});

test("new JD cards bind data SKU to title and reject conflicting chat PID", () => {
  const { document } = parseHTML(`<body>
    <div class="_wrapper_1y1ag_3 plugin_goodsCardWrapper" data-sku="90000000123">
      <div class="_goods_title_container_1k2fi_1"><span title="示例牌TEST01大卷纸2层240米12卷整箱">标题</span></div>
      <a href="https://chat.jd.com/index.action?pid=90000000123">客服</a>
    </div>
    <div class="plugin_goodsCardWrapper" data-sku="222">
      <div class="goods_title_container"><span title="冲突商品标题">标题</span></div>
      <a href="https://chat.jd.com/index.action?pid=333">客服</a>
    </div>
  </body>`);
  const previousDocument = (globalThis as any).document,
    previousLocation = (globalThis as any).location;
  Object.assign(globalThis, {
    document,
    location: { href: "https://search.jd.com/Search?keyword=示例牌" },
  });
  try {
    const result = new Function(
      `return (${readSourceSearchCards.toString()})`,
    )()({ query: "示例牌", limit: 10 });
    assert.equal(result.parserVersion, SOURCE_SEARCH_PARSER);
    assert.deepEqual(result.candidates, [
      {
        sku: "90000000123",
        url: "https://item.jd.com/90000000123.html",
        title: "示例牌TEST01大卷纸2层240米12卷整箱",
      },
    ]);
  } finally {
    Object.assign(globalThis, {
      document: previousDocument,
      location: previousLocation,
    });
  }
});

test("unsupported titled layouts and incomplete pages cannot become cached empty receipts", () => {
  for (const html of [
    `<body><div><span title="尚未适配的商品标题">商品</span></div></body>`,
    `<body><div class="loading">加载中</div></body>`,
  ]) {
    const { document } = parseHTML(html);
    const previousDocument = (globalThis as any).document,
      previousLocation = (globalThis as any).location;
    Object.assign(globalThis, {
      document,
      location: { href: "https://search.jd.com/Search?keyword=纸" },
    });
    try {
      assert.throws(
        () => readSourceSearchCards({ query: "纸", limit: 10 }),
        /尚未适配|尚未加载/,
      );
    } finally {
      Object.assign(globalThis, {
        document: previousDocument,
        location: previousLocation,
      });
    }
  }
});

test("source search refuses invalid budget and alternate state database before browser access", async () => {
  const page = {
    goto() {
      throw Error("must not access browser");
    },
  };
  const config: any = { sourceDatabasePath: "/configured", shop: "shop" };
  await assert.rejects(
    searchSourceCandidates(
      page,
      config,
      { database: "/other", query: "纸" },
      async () => {},
    ),
    /状态库/,
  );
  await assert.rejects(
    searchSourceCandidates(
      page,
      config,
      { database: "/configured", query: "纸", limit: 11 },
      async () => {},
    ),
    /最多十个/,
  );
});

test("repeated source search reuses the original receipt; account pause prevents browser access", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hezi-search-")),
    database = join(dir, "state.sqlite");
  const config: any = { sourceDatabasePath: database, shop: "test-shop" };
  let navigations = 0;
  const receipt = {
    parserVersion: SOURCE_SEARCH_PARSER,
    query: "品牌 型号",
    checkedAt: new Date().toISOString(),
    candidates: [
      {
        sku: "123",
        url: "https://item.jd.com/123.html",
        title: "品牌 型号 单件",
      },
    ],
  };
  const page = {
    async goto() {
      navigations++;
    },
    async url() {
      return "https://www.jd.com/";
    },
    async waitForFunction() {},
    async evaluate() {
      return receipt;
    },
  };
  try {
    const first = await searchSourceCandidates(
      page,
      config,
      { database, query: receipt.query },
      async () => {},
    );
    const second = await searchSourceCandidates(
      page,
      config,
      { database, query: receipt.query },
      async () => {},
    );
    assert.deepEqual(second, first);
    assert.equal(navigations, 1);
    const store = new Store(database);
    store.pause("jd-account:test-shop", { code: "RATE_LIMITED" }, "browser");
    store.close();
    await assert.rejects(
      searchSourceCandidates(
        page,
        config,
        { database, query: "另一个型号" },
        async () => {},
      ),
      /暂停/,
    );
    assert.equal(navigations, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("same current search URL is reread without another navigation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hezi-search-same-page-"));
  const database = join(dir, "state.sqlite");
  let navigations = 0;
  const receipt = {
    parserVersion: SOURCE_SEARCH_PARSER,
    query: "清风 B913JY",
    checkedAt: new Date().toISOString(),
    candidates: [
      {
        sku: "10052030936399",
        url: "https://item.jd.com/10052030936399.html",
        title: "清风 B913JY",
      },
    ],
  };
  try {
    const result = await searchSourceCandidates(
      {
        async url() {
          return (
            "https://search.jd.com/Search?keyword=" +
            encodeURIComponent(receipt.query) +
            "&enc=utf-8"
          );
        },
        async goto() {
          navigations++;
        },
        async waitForFunction() {},
        async evaluate() {
          return receipt;
        },
      },
      { sourceDatabasePath: database, shop: "test-shop" } as any,
      { database, query: receipt.query },
      async () => {},
    );
    assert.deepEqual(result, receipt);
    assert.equal(navigations, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a challenge observed during search persists an account stop without retrying", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hezi-search-risk-"));
  const database = join(dir, "state.sqlite");
  let healthCalls = 0;
  try {
    await assert.rejects(
      searchSourceCandidates(
        {},
        { shop: "test-shop", sourceDatabasePath: database } as any,
        { database, query: "品牌 型号" },
        async () => {
          healthCalls++;
          throw Object.assign(Error("当前页面处于风控或验证状态"), {
            code: "RATE_LIMITED",
          });
        },
      ),
      /验证状态/,
    );
    const store = new Store(database);
    assert.ok(store.pauseReasons("jd-account:test-shop").browser);
    store.close();
    assert.equal(healthCalls, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
