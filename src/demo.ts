import { Store } from "./store.js";
import { Engine } from "./engine.js";
import {
  expectedFields,
  type Product,
  type Plan,
  type Adapter,
  type RemoteSnapshot,
} from "./model.js";

export function example() {
  const now = new Date().toISOString();
  const url = "https://item.jd.com/100000000001.html";
  const fact = (value: string) => ({
    value,
    sourceUrl: url,
    capturedAt: now,
    evidence: "合成测试数据；不是可发布商品",
  });
  const product: Product = {
    sku: "100000000001",
    variant: "",
    url,
    title: fact("示例品牌 500g袋装"),
    price: { ...fact("19.90"), basis: "subsidy" },
    specs: { 总净含量: fact("500g") },
    assets: [0, 1, 2, 3].map((n) => ({
      role: n < 3 ? "main" : "detail",
      order: n < 3 ? n : 0,
      url: `https://img10.360buyimg.com/example-${n}.jpg`,
      path: `/synthetic/${n}.jpg`,
      sha256: String(n + 1).repeat(64),
      width: 800,
      height: 800,
    })),
    capturedAt: now,
  };
  const plan: Plan = {
    version: 1,
    rulesVersion: "demo-v1",
    shop: "DEMO ONLY",
    categoryPath: "食品>测试类目",
    brand: "示例品牌",
    unit: "件",
    price: { ...fact("19.90"), basis: "subsidy" },
    inventory: "1000",
    shippingTemplate: "示例运费模板",
    fields: { model: fact("DEMO-1") },
    specs: { 总净含量: fact("500g"), 规格: fact("单件装") },
    mediaReviewed: true,
    authorization: {
      category: true,
      brandCategory: true,
      source: "合成测试授权",
      checkedAt: now,
    },
  };
  return { product, plan };
}
export class MemoryAdapter implements Adapter {
  records = new Map<string, RemoteSnapshot>();
  saves = 0;
  submits = 0;
  nextId = 100001;
  async checkShop(_shop: string) {}
  async find(p: Product, plan: Plan) {
    return {
      complete: true,
      records: [...this.records.values()].filter(
        (r) => r.sku === p.sku && r.shop === plan.shop,
      ),
    };
  }
  async save(p: Product, plan: Plan, id: string | null) {
    this.saves++;
    id ??= String(this.nextId++);
    const image = (role: string) =>
      p.assets
        .filter((a) => a.role === role)
        .map((a) => ({
          url: `https://platform.invalid/${a.sha256}.jpg`,
          loaded: true,
        }));
    const s: RemoteSnapshot = {
      itemId: id,
      code: id,
      sku: p.sku,
      title: expectedFields(p, plan).title,
      shop: plan.shop,
      status: "草稿",
      fields: expectedFields(p, plan),
      specs: Object.fromEntries(
        Object.entries(plan.specs).map(([k, v]) => [k, v.value]),
      ),
      mainImages: image("main"),
      detailImages: image("detail"),
      mediaReferences: {
        main: image("main").map((x) => x.url),
        detail: image("detail").map((x) => x.url),
      },
      requiredMissing: [],
    };
    this.records.set(id, s);
    return structuredClone(s);
  }
  async read(id: string) {
    const s = this.records.get(id);
    if (!s) throw new Error("not found");
    return structuredClone(s);
  }
  async submit(id: string) {
    this.submits++;
    const s = this.records.get(id)!;
    s.status = "待审核";
    return structuredClone(s);
  }
}
export async function demo() {
  const store = new Store(":memory:");
  try {
    const { product, plan } = example();
    const row = store.put(plan.shop, product);
    store.setPlan(row.id, plan);
    const adapter = new MemoryAdapter();
    const engine = new Engine(store, adapter);
    const first = await engine.run(row.id, "submit");
    const again = await engine.run(row.id, "submit");
    return {
      mode: "SIMULATED — no browser / no network / no real goods",
      firstState: first.state,
      secondState: again.state,
      remoteId: first.remoteId,
      saves: adapter.saves,
      submits: adapter.submits,
      events: store.events().map((e) => e.event),
    };
  } finally {
    store.close();
  }
}
