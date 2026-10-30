import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import type { AnalyticsStore } from "./core.js";
import type { ObservationInput } from "./types.js";

const hash = (v: unknown) =>
  createHash("sha256").update(JSON.stringify(v)).digest("hex");
const normal = (v: string) => v.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
const escape = (v: string) => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function titleSupportsBrand(title: string, brand: string) {
  const aliases = [
    brand,
    ...(brand.match(/[\u4e00-\u9fff]{2,}|[a-zA-Z][a-zA-Z0-9-]{1,}/g) ?? []),
  ];
  return [...new Set(aliases)].some((alias) => {
    if (normal(alias).length < 2) return false;
    if (/^[a-zA-Z0-9][a-zA-Z0-9-]*$/.test(alias))
      return new RegExp(
        `(^|[^a-zA-Z0-9])${escape(alias)}($|[^a-zA-Z0-9])`,
        "i",
      ).test(title);
    if (/^[\u4e00-\u9fff]+$/.test(alias)) {
      const trimmed = title.replace(/^[\s\p{P}\p{S}]+/u, "");
      return (
        normal(trimmed).startsWith(normal(alias)) ||
        new RegExp(
          `(^|[\\s\\p{P}\\p{S}])${escape(alias)}($|[\\s\\p{P}\\p{S}])`,
          "u",
        ).test(title)
      );
    }
    return false;
  });
}

export function inferResearchBrand(title: string, brands: string[]) {
  for (const brand of [...brands].sort((a, b) => b.length - a.length)) {
    if (titleSupportsBrand(title, brand))
      return { brand, identitySource: "title-matched-shop-brand-list" };
  }
  return { brand: null, identitySource: "unknown" };
}
const categories: Array<[string, RegExp]> = [
  ["纸品", /抽纸|卷纸|大盘纸|卫生纸|擦手纸|面巾纸|餐巾纸|纸巾/],
  ["清洁洗化", /洗衣液|洗衣粉|洗手液|洗洁精|清洁剂|消毒液|洁厕|漂白/],
  ["电缆导管与管材", /MPP|PVC管|HDPE|PE管|波纹管|保护管|穿线管|涂塑钢管|管件/i],
  ["电线电缆与导线", /电缆|电线|架空线|铜芯|铝芯|JKLYJ|BLVV|YJV/i],
  ["电力与工业材料", /变压器|钢筋|角钢|螺栓|绝缘子|金具|接地|钢绞线|扁钢/],
  ["办公文具与耗材", /复印纸|硒鼓|墨盒|档案|文件|笔|回形针|订书|票夹|办公/],
  ["劳保安全", /安全帽|手套|劳保|防护|口罩|雨靴|反光/],
  ["电池与电源", /电池|南孚|金霸王|电源/],
  ["数码家电", /电脑|打印机|空调|冰箱|风扇|鼠标|键盘|路由器|显示器/],
  ["饮用水与食品", /饮用水|矿泉水|纯净水|牛奶|大米|食用油|饮料/],
  ["日用与餐饮耗材", /垃圾袋|垃圾桶|餐盒|纸杯|拖把|扫把|保鲜膜|一次性/],
];
export const inferResearchCategory = (title: string) =>
  categories.find(([, re]) => re.test(title))?.[0] ?? "其他（待细分）";
const money = (v: unknown) =>
  Number.isFinite(Number(v)) && Number(v) > 0
    ? Math.round(Number(v) * 100)
    : null;
async function json(path: string): Promise<any | null> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (e: any) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
}

/** Import only local, previously captured evidence. No external request or business DB write. */
export async function importResearch(store: AnalyticsStore, root: string) {
  store.db.exec(
    "CREATE TABLE IF NOT EXISTS analytics_research_imports(path TEXT PRIMARY KEY,hash TEXT NOT NULL,imported_at TEXT NOT NULL,summary TEXT NOT NULL)",
  );
  const results: any[] = [];
  const importFile = async (
    path: string,
    data: any,
    groups: Map<string, ObservationInput[]>,
    coverage: "complete" | "partial",
  ) => {
    const digest = hash(data);
    const previous = store.db
      .prepare(
        "SELECT hash,summary FROM analytics_research_imports WHERE path=?",
      )
      .get(path);
    if (previous?.hash === digest) {
      results.push({
        path,
        unchanged: true,
        ...JSON.parse(String(previous.summary)),
      });
      return;
    }
    let inserted = 0,
      conflicts = 0,
      rejected = 0;
    for (const [at, rows] of groups) {
      const r = store.importObservations(rows, {
        id: "research:" + hash({ path, digest, at }),
        source: path,
        observedAt: at,
        coverage,
        expectedCount: rows.length,
      });
      inserted += r.inserted;
      conflicts += r.conflicts;
      rejected += r.rejected;
    }
    const summary = { inserted, conflicts, rejected, groups: groups.size };
    store.db
      .prepare(
        "INSERT INTO analytics_research_imports VALUES(?,?,?,?) ON CONFLICT(path) DO UPDATE SET hash=excluded.hash,imported_at=excluded.imported_at,summary=excluded.summary",
      )
      .run(path, digest, new Date().toISOString(), JSON.stringify(summary));
    results.push({ path, ...summary });
  };
  const dir = resolve(root, "company-study-20260919/full");
  let files: string[] = [];
  try {
    files = (await readdir(dir)).filter((f) => /^\d+\.json$/.test(f)).sort();
  } catch (e: any) {
    if (e.code !== "ENOENT") throw e;
  }
  for (const file of files) {
    const path = resolve(dir, file),
      data = await json(path);
    if (!data) continue;
    const latest = new Map<string, { s: any; at: string }>();
    for (const page of [
      ...(data.pages ?? []),
      ...(data.salesSortedPages ?? []),
    ]) {
      if (!Number.isFinite(Date.parse(page.at)))
        throw Error("研究数据缺采集时间：" + file);
      for (const s of page.skus ?? []) {
        if (String(s.shopId) !== String(data.shopId))
          throw Error("研究商品店铺归属不符：" + file);
        const key = String(s.skuId),
          prior = latest.get(key);
        if (!prior || Date.parse(page.at) >= Date.parse(prior.at))
          latest.set(key, { s, at: page.at });
      }
    }
    const groups = new Map<string, ObservationInput[]>();
    for (const { s, at } of latest.values()) {
      const title = String(s.skuName),
        b = inferResearchBrand(title, data.brandNameList ?? []);
      const row: ObservationInput = {
        platform: "hezi",
        shop: String(data.shopId),
        itemId: String(s.itemId),
        skuId: String(s.skuId),
        title,
        brand: b.brand,
        category: inferResearchCategory(title),
        saleUnit: String(s.saleUnit ?? "未知单位"),
        packaging: title,
        sourceEntry: "hezi-shop-list-v1",
        field: "saleCount",
        fieldVersion: "2026-09",
        semanticsVersion: "display-cumulative-unknown-period-v1",
        currency: "CNY",
        value: Number(s.saleCount),
        priceMinor: money(s.sellPrice),
        raw: {
          ...s,
          shopName: data.name,
          brandIdentitySource: b.identitySource,
          categorySource: "title-rule",
          declaredTotal: data.pages?.[0]?.total,
          uniqueCaptured: latest.size,
          sampleScope: "10家研究样本；非官方前十",
          evidencePath: path,
          url: data.url,
        },
      };
      const list = groups.get(at) ?? [];
      list.push(row);
      groups.set(at, list);
    }
    await importFile(
      path,
      data,
      groups,
      latest.size === Number(data.pages?.[0]?.total) ? "complete" : "partial",
    );
  }
  const recentPath = resolve(
      root,
      "../reports/evidence/recent-hot-20260919/data.json",
    ),
    recent = await json(recentPath);
  if (recent?.rows) {
    const groups = new Map<string, ObservationInput[]>();
    for (const r of recent.rows)
      for (const end of [false, true]) {
        const at = end ? r.to : r.from;
        const row: ObservationInput = {
          platform: "hezi",
          shop: String(r.shopId),
          itemId: String(r.item),
          skuId: String(r.sku),
          title: r.name,
          brand: r.brand,
          category: r.category,
          saleUnit: r.unit,
          packaging: r.name,
          sourceEntry: "hezi-shop-list-cohort-v1",
          field: "saleCount",
          fieldVersion: "2026-09",
          semanticsVersion: "display-cumulative-unknown-period-v1",
          currency: "CNY",
          value: Number(end ? r.new : r.old),
          priceMinor: money(end ? r.price : r.oldPrice),
          raw: {
            shopName: r.shop,
            brandIdentitySource: "research-inference",
            sampleScope: "9月17—19日同店同SKU匹配样本106款；不代表全店",
            evidencePath: recentPath,
            url: r.url,
            endpoint: end ? "end" : "start",
            unitEvidence: "所选SKU标题销售单位与列表字段",
            sourceEntryActual: "shop-list",
          },
        };
        const list = groups.get(at) ?? [];
        list.push(row);
        groups.set(at, list);
      }
    await importFile(recentPath, recent, groups, "complete");
  }
  return {
    files: results,
    available: results.length > 0,
    importedAt: new Date().toISOString(),
  };
}
