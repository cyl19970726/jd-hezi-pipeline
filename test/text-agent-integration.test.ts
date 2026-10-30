import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.js";
import { TextAgentTasks } from "../src/text-agent.js";
import {
  requestTitle,
  titleAgentInput,
} from "../src/text-agent-integration.js";
import type { Product } from "../src/model.js";
import type { Job } from "../src/jobs.js";

const url = "https://item.jd.com/100000000001.html";
const fact = (value: string, sourceUrl = url) => ({
  value,
  sourceUrl,
  capturedAt: new Date().toISOString(),
  evidence: "测试来源",
});
const product = (
  title = "示例品牌 加厚爆款 收纳盒 蓝色 30L 2个装",
): Product => ({
  sku: "100000000001",
  variant: "蓝色 30L 2个装",
  url,
  title: fact(title),
  price: null,
  specs: {
    京东销售规格: fact("蓝色 30L 2个装"),
    容量: fact("30L"),
    包装清单: fact("收纳盒 2个"),
  },
  assets: [],
  capturedAt: new Date().toISOString(),
});
const job: Job = {
  id: "job-title-1",
  sku: "100000000001",
  status: "RUNNING",
  stage: "assets",
  productId: null,
  recipe: {
    brandId: "brand",
    categoryId: "category",
    policyId: "policy",
    unit: "件",
    through: "draft",
  },
  error: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  attempt: 1,
};

async function completed(
  tasks: TextAgentTasks,
  p: Product,
  value: string,
  sources: Array<{ field: string; quote: string }>,
) {
  const queued = requestTitle(tasks, job, "shop", p).task;
  await tasks.runOne(async () => ({ value, sources }), queued.id);
}

test("a result bound to the previous title is never applied after input changes", async () => {
  const store = new Store(":memory:");
  try {
    const tasks = new TextAgentTasks(store),
      old = product();
    await completed(tasks, old, "示例品牌 收纳盒 蓝色 30L 2个装", [
      { field: "title", quote: old.title.value },
      { field: "selectedVariant", quote: "蓝色 30L 2个装" },
    ]);
    const accepted = requestTitle(tasks, job, "shop", old);
    assert.equal(accepted.title?.value, "示例品牌 收纳盒 蓝色 30L 2个装");

    const changed = product("示例品牌 收纳盒 红色 20L 单个装");
    changed.specs["京东销售规格"] = fact("红色 20L 单个装");
    changed.specs["容量"] = fact("20L");
    changed.specs["包装清单"] = fact("收纳盒 1个");
    const decision = requestTitle(tasks, job, "shop", changed);
    assert.equal(decision.title, null);
    assert.equal(decision.task.status, "pending");
    assert.notEqual(decision.task.inputHash, accepted.task.inputHash);
  } finally {
    store.close();
  }
});

test("a title cannot exchange a selected specification number or unit", async () => {
  const store = new Store(":memory:");
  try {
    const tasks = new TextAgentTasks(store),
      p = product();
    await completed(tasks, p, "示例品牌 收纳盒 蓝色 30升 2个装", [
      { field: "title", quote: p.title.value },
      { field: "selectedVariant", quote: "蓝色 30L 2个装" },
    ]);
    assert.throws(
      () => requestTitle(tasks, job, "shop", p),
      /未完整保留所选销售规格/,
    );
  } finally {
    store.close();
  }
});

test("the complete selected specification must remain in the title", async () => {
  const store = new Store(":memory:");
  try {
    const tasks = new TextAgentTasks(store),
      p = product();
    await completed(tasks, p, "示例品牌 收纳盒 蓝色 30L", [
      { field: "title", quote: p.title.value },
      { field: "selectedVariant", quote: "蓝色 30L 2个装" },
    ]);
    assert.throws(
      () => requestTitle(tasks, job, "shop", p),
      /未完整保留所选销售规格/,
    );
  } finally {
    store.close();
  }
});

test("quantity and capacity inside selected-label brackets must remain", async () => {
  const store = new Store(":memory:");
  try {
    const tasks = new TextAgentTasks(store),
      p = product("示例品牌 收纳盒 蓝色【30L 2个装】");
    p.specs["京东销售规格"] = fact("蓝色【30L 2个装】");
    await completed(tasks, p, "示例品牌 收纳盒 蓝色", [
      { field: "title", quote: p.title.value },
      { field: "selectedVariant", quote: "蓝色【30L 2个装】" },
    ]);
    assert.throws(
      () => requestTitle(tasks, job, "shop", p),
      /未完整保留所选销售规格/,
    );
  } finally {
    store.close();
  }
});

test("a textual selected variant inside brackets must remain", async () => {
  const store = new Store(":memory:");
  try {
    const tasks = new TextAgentTasks(store),
      p = product("示例品牌 驱蚊液【薰衣草味】30L 2个装");
    p.specs["京东销售规格"] = fact("【薰衣草味】30L 2个装");
    await completed(tasks, p, "示例品牌 驱蚊液 30L 2个装", [
      { field: "title", quote: p.title.value },
      { field: "selectedVariant", quote: "【薰衣草味】30L 2个装" },
    ]);
    assert.throws(
      () => requestTitle(tasks, job, "shop", p),
      /未完整保留所选销售规格/,
    );
  } finally {
    store.close();
  }
});

test("a title containing any character absent from verified quotes is rejected", async () => {
  const store = new Store(":memory:");
  try {
    const tasks = new TextAgentTasks(store),
      p = product();
    await completed(tasks, p, "示例品牌 进口收纳盒 蓝色 30L 2个装", [
      { field: "title", quote: p.title.value },
      { field: "selectedVariant", quote: "蓝色 30L 2个装" },
    ]);
    assert.throws(
      () => requestTitle(tasks, job, "shop", p),
      /增加了无来源文字/,
    );
  } finally {
    store.close();
  }
});

test("queueing a title task neither acquires nor waits for the publisher lock", () => {
  const store = new Store(":memory:");
  try {
    const tasks = new TextAgentTasks(store),
      unlock = store.lock("publisher");
    try {
      const before = Number(
        store.db.prepare("SELECT COUNT(*) n FROM locks").get()?.n,
      );
      const decision = requestTitle(tasks, job, "shop", product());
      assert.equal(decision.task.status, "pending");
      assert.equal(
        Number(store.db.prepare("SELECT COUNT(*) n FROM locks").get()?.n),
        before,
      );
    } finally {
      unlock();
    }
  } finally {
    store.close();
  }
});

test("agent input excludes selected and packaging facts from another source item", () => {
  const p = product();
  p.specs["京东销售规格"] = fact(
    "红色 50L 10个装",
    "https://item.jd.com/999999999999.html",
  );
  p.specs["包装清单"] = fact("10个", "https://item.jd.com/999999999999.html");
  const input = titleAgentInput(job, "shop", p);
  assert.equal(input.selectedVariant, null);
  assert.equal(input.packaging, null);
});
