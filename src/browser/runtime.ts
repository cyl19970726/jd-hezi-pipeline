import { readAnalyticsShopPage } from "./analytics-collection.js";
import {
  markDocumentForNavigation,
  didDocumentSurviveNavigation,
} from "./document-navigation.js";
import { readExactItem } from "./exact-item.js";
import { markRejectionSpec, rejectionContent } from "./rejection-fields.js";
import { digest } from "../model.js";
import { readSnapshotPanes } from "./snapshot-panes.js";
import {
  comparePreflightTemplate,
  preflightControls,
  preflightPackingName,
} from "./preflight-schema.js";
import {
  ensureSupplierWorkspace,
  prepareNewTemplateWorkspace,
} from "./supplier-workspace.js";
import { readCategoryTemplate } from "./category-template.js";
import { readMarketDetails } from "./market-details-runner.js";
import { hydrateOpportunityDetails } from "./opportunity-details.js";
import { scanMarket } from "./market-runner.js";
import { discoverSource } from "./discovery-runner.js";
import { searchSourceCandidates } from "./source-search.js";
import { readBrandGrant, syncBrandInventory } from "./brand-sync.js";
import { writeFile, rename } from "node:fs/promises";
import { ensureRequestHook } from "./request-hook.js";
import { Store } from "../store.js";
import { JdTraffic } from "../jd-traffic.js";
import { Traffic } from "../traffic.js";
import { syncSources } from "./source-scan.js";
import { enrichJd } from "./jd-business.js";
import { archiveJdBusinessObservation } from "./jd-observation-archive.js";
import { formBatch } from "./form-batch.js";
import { readTitleControl, readPlatformTitleRule } from "./platform-title.js";
import { completeSubmissionDialogs } from "./submission-dialog.js";
import { setDetailOrder } from "./detail-order.js";
import { afterSales } from "./after-sales.js";
import { observeNewSave, selectSiteApiClient } from "./receipt.js";
import { applyLogistics, readLogistics } from "./logistics.js";
import { resolveLogisticsModule } from "./logistics-client.js";
import { resolveSourceModule } from "./source-client.js";
import {
  readPage,
  readJd,
  readJdRegions,
  type JdFactRegion,
  readFields,
  readRows,
  openJdPriceDetails,
} from "./extractors.js";
import { readCatalogOptions, catalogOptionsReady } from "./catalog.js";

export type UploadedMediaState = "pending" | "ready" | "invalid";
export const MEDIA_UPLOAD_MAX_ATTEMPTS = 2;

/** Classify rendered upload output; an HTTP 200 alone is not media success. */
export function classifyUploadedMedia(
  images: { src: string; complete: boolean; naturalWidth: number }[],
  expectedCount: number,
): UploadedMediaState {
  if (images.length !== expectedCount) return "pending";
  if (
    images.some(
      (image) =>
        !/^https?:\/\//i.test(image.src) ||
        /(?:^|\/)undefined(?:[?#]|$)/i.test(image.src) ||
        (image.complete && image.naturalWidth <= 0),
    )
  )
    return "invalid";
  return images.every((image) => image.complete && image.naturalWidth > 0)
    ? "ready"
    : "pending";
}

/** Locate one newly added URL occurrence without confusing duplicate CDN URLs. */
export function locateSingleAddedMedia(
  before: string[],
  after: { src: string }[],
): number | null {
  const counts = new Map<string, number>();
  for (const url of before) counts.set(url, (counts.get(url) ?? 0) + 1);
  const added: number[] = [];
  after.forEach((image, index) => {
    const remaining = counts.get(image.src) ?? 0;
    if (remaining) counts.set(image.src, remaining - 1);
    else added.push(index);
  });
  return added.length === 1 ? added[0] : null;
}

export function mediaUploadFailureDetails(
  sku: string,
  shop: string,
  context: Record<string, unknown> = {},
) {
  return {
    ...context,
    phase: "media-upload" as const,
    saveDispatched: false as const,
    sku,
    shop,
  };
}

type Page = any;
export interface Session {
  spaceId: number;
  hzPage: string;
  jdPage: string;
  profileId: string;
}
export interface BrowserConfig {
  session: Session;
  shop: string;
  listUrl: string;
  newUrl: string;
  editUrl: string;
  maxPages: number;
  experimentalBatchForm?: boolean;
  snapshotMode?: "legacy" | "batched";
  textAgent?: { enabled: boolean; codexPath?: string; timeoutMs?: number };
  allowSourceScan?: boolean;
  requestMetricsPath?: string;
  sourceDatabasePath?: string;
}

export function evaluatePreflightPackingName(
  page: Pick<Page, "evaluate">,
  packingName?: string,
) {
  return packingName === undefined
    ? page.evaluate(preflightPackingName)
    : page.evaluate(preflightPackingName, packingName);
}
async function jdNavigate(
  page: Page,
  config: BrowserConfig,
  url: string,
  reload = false,
) {
  if (!config.sourceDatabasePath) throw Error("缺少京东持久化流量数据库");
  const store = new Store(config.sourceDatabasePath);
  try {
    return await new JdTraffic(store, config.shop).navigate(url, () =>
      reload ? page.reload() : page.goto(url),
    );
  } finally {
    store.close();
  }
}
async function withHzTraffic<T>(
  config: BrowserConfig,
  kind: string,
  operation: () => Promise<T>,
) {
  if (!config.sourceDatabasePath) throw Error("缺少赫兹持久化流量数据库");
  const store = new Store(config.sourceDatabasePath);
  try {
    return await new Traffic(store, config.shop).run(kind, operation);
  } finally {
    store.close();
  }
}
const fail = (code: string, message: string, details?: unknown): never => {
  throw Object.assign(new Error(message), { code, details });
};
const labels: Record<string, string> = {
  title: "商品名称",
  origin: "产地",
  model: "规格型号",
  weight: "商品重量",
  length: "长",
  width: "宽",
  height: "高",
  unit: "单位",
  sourceUrl: "商品链接",
  price: "售价",
  inventory: "库存",
};
async function health(p: Page, shop?: string) {
  const s = await p.evaluate(readPage);
  if (s.accountChanged)
    fail("ACCOUNT_CHANGED", "平台报告登录账号变更，刷新并重新核验身份后恢复");
  if (s.login) fail("AUTH_REQUIRED", "当前站点需要登录");
  if (s.risk) fail("RATE_LIMITED", "当前页面处于风控或验证状态");
  if (shop && s.shop !== shop)
    fail("ACCOUNT_CHANGED", "页面店铺身份与配置不匹配", {
      expected: shop,
      actual: s.shop,
    });
  return s;
}
/** Classify redirects before a selector timeout can hide an account-level stop. */
export async function waitForJdProduct(p: Page) {
  await health(p);
  try {
    await p.waitForFunction(
      () => !!document.querySelector("#spec-img,#spec-list"),
      undefined,
      { timeout: 15000 },
    );
  } catch (error) {
    await health(p);
    throw error;
  }
  await health(p);
}
async function tab(p: Page, text: string) {
  await p.evaluate(
    (t: string) =>
      [...document.querySelectorAll(".ant-tabs-tab-btn")]
        .find((e) => e.textContent?.trim() === t)
        ?.scrollIntoView({ block: "center" }),
    text,
  );
  await p.click(`.ant-tabs-tab-btn:text-is("${text}")`);
  await p.waitForFunction(
    (t: string) => {
      if (
        ![...document.querySelectorAll(".ant-tabs-tab-active")].some(
          (e) => e.textContent?.trim() === t,
        )
      )
        return false;
      const pane = [
        ...document.querySelectorAll(".ant-tabs-tabpane-active"),
      ].at(-1);
      if (!pane || pane.querySelector(".ant-spin-spinning")) return false;
      if (t === "规格参数")
        return [...pane.querySelectorAll("tr")].some(
          (r) =>
            r.querySelectorAll("td").length >= 2 && r.querySelector("input"),
        );
      if (t === "包装清单")
        return !!pane.querySelector('input[placeholder="附件名称"]');
      if (t === "商品详情")
        return !!(
          pane.querySelector(
            "iframe.tox-edit-area__iframe",
          ) as HTMLIFrameElement
        )?.contentDocument?.body;
      if (t === "上传图片") return !!pane.querySelector("input[type=file]");
      return true;
    },
    text,
    { timeout: 45000 },
  );
}
async function fieldSelector(p: Page, key: string) {
  return await p.evaluate(
    ({ key, label }: { key: string; label: string }) => {
      if (key === "inventory") {
        const found: Element[] = [];
        for (const table of document.querySelectorAll(
          ".ant-tabs-tabpane-active table",
        )) {
          const headers = [...table.querySelectorAll("thead th")].map((e) =>
            e.textContent?.trim(),
          );
          const i = headers.indexOf("库存");
          if (i < 0) continue;
          for (const tr of table.querySelectorAll("tbody tr")) {
            const input = tr.querySelectorAll("td")[i]?.querySelector("input");
            if (input) found.push(input);
          }
        }
        if (found.length !== 1) return null;
        found[0].setAttribute("data-hezi-field", key);
        return '[data-hezi-field="inventory"]';
      }
      const aliases: Record<string, string[]> = {
        title: ["商品名称"],
        price: ["售价", "销售价格"],
        inventory: ["库存"],
        sourceUrl: ["商品链接", "链接地址"],
        model: ["规格型号"],
      };
      const candidates = [
        ...document.querySelectorAll(".ant-form-item"),
      ].filter((el) => {
        const l =
          el.querySelector("label")?.textContent?.replace(/[\s*：:]/g, "") ??
          "";
        return (aliases[key] ?? [label]).some(
          (a) => l === a || (key === "weight" && l.startsWith(a)),
        );
      });
      const inputs = candidates
        .flatMap((e) => [
          ...e.querySelectorAll(
            "input:not([type=hidden]):not([readonly]),textarea",
          ),
        ])
        .filter((e) => (e as HTMLElement).getBoundingClientRect().width > 0);
      const placeholders: Record<string, string> = {
        length: "长,大于0的整数",
        width: "宽,大于0的整数",
        height: "高,大于0的整数",
        weight: "商品重量",
        price: "最多保留两位小数",
        inventory: "最多保留三位小数",
      };
      const matches = inputs.length
        ? inputs
        : [...document.querySelectorAll("input,textarea")].filter(
            (e) =>
              placeholders[key] &&
              e.getAttribute("placeholder") === placeholders[key] &&
              (e as HTMLElement).getBoundingClientRect().width > 0,
          );
      if (matches.length !== 1) return null;
      matches[0].setAttribute("data-hezi-field", key);
      return `[data-hezi-field="${key}"]`;
    },
    { key, label: labels[key] ?? key },
  );
}
async function fill(p: Page, key: string, value: string) {
  const selector = await fieldSelector(p, key);
  if (!selector) fail("UI_CHANGED", "不能唯一定位字段：" + key);
  if (
    (await p.evaluate(
      (s: string) => (document.querySelector(s) as HTMLInputElement)?.value,
      selector,
    )) === value
  )
    return;
  if (value === "") {
    await p.focus(selector);
    await p.press(selector, "ControlOrMeta+A");
    await p.press(selector, "Backspace");
  } else await p.fill(selector, value);
  await p.press(selector, "Tab");
}
async function button(p: Page, text: string) {
  const selector = await p.evaluate((text: string) => {
    const b = [...document.querySelectorAll("button")].filter(
      (e) =>
        e.getBoundingClientRect().width > 0 &&
        e.textContent?.replace(/\s/g, "") === text.replace(/\s/g, ""),
    );
    if (b.length !== 1) return null;
    document
      .querySelectorAll("[data-hezi-button]")
      .forEach((e) => e.removeAttribute("data-hezi-button"));
    b[0].setAttribute("data-hezi-button", "target");
    return '[data-hezi-button="target"]';
  }, text);
  if (!selector) fail("UI_CHANGED", "不能唯一定位按钮：" + text);
  await p.click(selector);
}
async function choose(p: Page, label: string, value: string) {
  const selector = await p.evaluate((label: string) => {
    const forms = [...document.querySelectorAll(".ant-form-item,tr")].filter(
      (e) =>
        (
          e.querySelector("label")?.textContent ??
          e.querySelector("th,td")?.textContent
        )?.replace(/[\s*：:]/g, "") === label,
    );
    const el = forms
      .flatMap((e) => [
        ...e.querySelectorAll(".ant-select-selector,.ant-dropdown-trigger"),
      ])
      .filter((e) => (e as HTMLElement).getBoundingClientRect().width > 0);
    if (el.length !== 1) return null;
    document
      .querySelectorAll("[data-hezi-select]")
      .forEach((e) => e.removeAttribute("data-hezi-select"));
    el[0].setAttribute("data-hezi-select", "target");
    return '[data-hezi-select="target"]';
  }, label);
  if (!selector) fail("UI_CHANGED", "不能唯一定位选项字段：" + label);
  await p.click(selector);
  const search = await p.evaluate(() => {
    const a = [
      ...document.querySelectorAll('[data-hezi-select="target"] input'),
    ].filter((e) => !(e as HTMLInputElement).readOnly);
    return a.length === 1;
  });
  if (search) await p.fill('[data-hezi-select="target"] input', value);
  await p.waitForFunction(
    (v: string) =>
      [
        ...document.querySelectorAll(
          ".ant-select-item-option-content,.ant-dropdown-menu-item",
        ),
      ].some(
        (e) =>
          (e as HTMLElement).getBoundingClientRect().width > 0 &&
          e.textContent?.trim() === v,
      ),
    value,
    { timeout: 10000 },
  );
  const option = await p.evaluate((v: string) => {
    const a = [
      ...document.querySelectorAll(
        ".ant-select-item-option-content,.ant-dropdown-menu-item",
      ),
    ].filter(
      (e) =>
        (e as HTMLElement).getBoundingClientRect().width > 0 &&
        e.textContent?.trim() === v,
    );
    if (a.length !== 1) return null;
    document
      .querySelectorAll("[data-hezi-option]")
      .forEach((e) => e.removeAttribute("data-hezi-option"));
    a[0].setAttribute("data-hezi-option", "target");
    return '[data-hezi-option="target"]';
  }, value);
  if (!option) fail("NEEDS_INPUT", "选项缺失或重名，无法自动选择：" + value);
  await p.click(option);
}
async function chooseCategory(h: Page, path: string) {
  await h.click("#form_item_categoryName");
  const manual = await h.evaluate(
    () =>
      ![...document.querySelectorAll("input")].some(
        (e) => e.placeholder === "类目名称",
      ),
  );
  if (manual) await h.click('text="手动查询类目"');
  await h.waitForFunction(
    () =>
      [...document.querySelectorAll('[role="dialog"] tbody tr')].some((r) =>
        r.textContent?.includes("选择该类目"),
      ) && !document.querySelector('[role="dialog"] .ant-spin-spinning'),
    undefined,
    { timeout: 15000 },
  );
  await h.fill('input[placeholder="类目名称"]', path.split(">").pop()!.trim());
  await button(h, "查询");
  await h.waitForFunction(
    (leaf: string) =>
      [...document.querySelectorAll("[role=dialog] td")].some(
        (e) => e.textContent?.trim() === leaf,
      ),
    path.split(">").pop()!.trim(),
    { timeout: 10000 },
  );
  const category = await h.evaluate((path: string) => {
    const normalize = (s: string) => s.replace(/\s/g, "");
    const rows = [...document.querySelectorAll("[role=dialog] tr")].filter(
      (r) => {
        const actual = [...r.querySelectorAll("td")]
          .slice(0, 5)
          .map((c) => c.textContent?.trim() ?? "")
          .filter((v) => v && v !== "-");
        return (
          actual.map(normalize).join(">") ===
          path.split(">").map(normalize).join(">")
        );
      },
    );
    const b = rows
      .flatMap((r) => [...r.querySelectorAll("button,a")])
      .filter((x) => x.textContent?.trim() === "选择该类目");
    if (b.length !== 1) return null;
    b[0].setAttribute("data-hezi-category", "target");
    return '[data-hezi-category="target"]';
  }, path);
  if (!category) fail("NEEDS_INPUT", "没有唯一匹配完整路径的类目");
  await h.click(category);
  await h.waitForFunction(
    () =>
      ![...document.querySelectorAll("[role=dialog]")].some(
        (e) => (e as HTMLElement).getBoundingClientRect().width > 0,
      ),
    undefined,
    { timeout: 10000 },
  );
}
async function observeRequests(p: Page) {
  await p.evaluate(() => {
    const w = window as any;
    if (w.__heziNetwork) return;
    const state = (w.__heziNetwork = { pending: 0, activity: Date.now() });
    const start = () => {
      state.pending++;
      state.activity = Date.now();
    };
    const end = () => {
      state.pending--;
      state.activity = Date.now();
    };
    const originalFetch = w.fetch;
    w.fetch = function (...args: any[]) {
      start();
      try {
        return originalFetch.apply(this, args).finally(end);
      } catch (e) {
        end();
        throw e;
      }
    };
    const send = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.send = function (...args: any[]) {
      start();
      this.addEventListener("loadend", end, { once: true });
      try {
        return send.apply(this, args as any);
      } catch (e) {
        end();
        throw e;
      }
    };
  });
}
async function settleRequests(p: Page) {
  await p.waitForFunction(
    () => {
      const s = (window as any).__heziNetwork;
      return s && s.pending === 0 && Date.now() - s.activity > 500;
    },
    undefined,
    { timeout: 30000 },
  );
}
async function listAll(
  p: Page,
  c: BrowserConfig,
  query?: { code?: string; title?: string; draft?: boolean },
) {
  await p.goto(c.listUrl);
  await p.evaluate(() =>
    document.documentElement.setAttribute("data-hezi-list-reload", "old"),
  );
  await p.reload();
  await p.waitForFunction(
    () =>
      !!document.documentElement &&
      !document.documentElement.hasAttribute("data-hezi-list-reload") &&
      !document.querySelector(".ant-spin-spinning") &&
      !!document.querySelector("tbody tr td") &&
      [...document.querySelectorAll("thead th")].some(
        (e) => e.textContent?.trim() === "商品编码",
      ),
    undefined,
    { timeout: 45000 },
  );
  await health(p, c.shop);
  await observeRequests(p);
  await p.evaluate(() => ((window as any).__heziNetwork.activity = Date.now()));
  await button(p, "重置");
  await settleRequests(p);
  if (query?.code) {
    await p.click("#form_item_queryItemIdList");
    await p.waitForSelector("#form_item_queryItemIdList + div textarea", {
      state: "visible",
      timeout: 5000,
    });
    await p.fill("#form_item_queryItemIdList + div textarea", query.code);
    await p.press("#form_item_queryItemIdList + div textarea", "Tab");
  }
  if (query?.title) await p.fill("#form_item_itemName", query.title);
  // Drafts use a distinct backend query path; combining with normal statuses omits them.
  if (query?.draft) {
    await p.click("#form_item_itemStatusList");
    await p.click('.ant-select-item-option-content:text-is("草稿")');
    await p.press("#form_item_itemStatusList", "Escape");
  }
  await p.evaluate(() => ((window as any).__heziNetwork.activity = Date.now()));
  await button(p, "查询");
  await settleRequests(p);
  const records: any[] = [];
  const fingerprints = new Set<string>();
  for (let i = 0; i < c.maxPages; i++) {
    const r = await p.evaluate(readRows);
    if (!r.hasTable || (!r.records.length && !r.empty))
      return { complete: false, records };
    const fingerprint = r.records.map((x: any) => x.code).join(",");
    if (fingerprints.has(fingerprint) && r.records.length)
      return { complete: false, records };
    fingerprints.add(fingerprint);
    records.push(...r.records);
    if (query?.code && r.records.some((x: any) => x.itemId === query.code))
      return { complete: false, records };
    if (!r.nextAvailable) return { complete: true, records };
    const previous = await p.evaluate(() =>
      [...document.querySelectorAll("tbody tr")]
        .map((e) => e.textContent)
        .join(""),
    );
    await p.click(".ant-pagination-next");
    await p.waitForFunction(
      (prev: string) => {
        const rows = [...document.querySelectorAll("tbody tr")]
          .map((e) => e.textContent)
          .join("");
        return rows !== prev && !document.querySelector(".ant-spin-spinning");
      },
      previous,
      { timeout: 12000 },
    );
    await health(p, c.shop);
  }
  return { complete: false, records };
}
async function locate(p: Page, c: BrowserConfig, code: string) {
  let all = await listAll(p, c, { code });
  if (!all.records.some((r: any) => r.itemId === code))
    all = await listAll(p, c, { code, draft: true });
  const rows = all.records.filter((r: any) => r.itemId === code);
  if (rows.length !== 1)
    fail("UNKNOWN_OUTCOME", "商品编码未唯一命中当前列表", {
      code,
      complete: all.complete,
    });
  return rows[0];
}
async function savedRecord(
  p: Page,
  c: BrowserConfig,
  itemId: string,
  sku: string,
) {
  try {
    await p.waitForFunction(
      (id: string) =>
        !!document.body &&
        [...document.querySelectorAll("tbody tr")].some((r) =>
          r.textContent?.includes(id),
        ),
      itemId,
      { timeout: 20000 },
    );
    const rows = (await p.evaluate(readRows)).records.filter(
      (r: any) => r.itemId === itemId,
    );
    if (rows.length === 1) return { ...rows[0], sku, shop: c.shop };
    throw Error("Saved row is not unique");
  } catch (e) {
    fail("UNKNOWN_OUTCOME", "已取得保存编号，列表读回未完成", {
      itemId,
      sku,
      error: String(e),
    });
  }
}
async function openEdit(p: Page, c: BrowserConfig, itemId: string) {
  // Prove a fresh Document, rather than blindly loading it twice. Same-document
  // SPA navigation retains this marker and therefore still requires reload.
  const marker = String(Date.now()) + ":" + Math.random();
  await p.evaluate(markDocumentForNavigation, marker);
  await p.goto(c.editUrl.replace("{itemId}", encodeURIComponent(itemId)));
  const sameDocument = await p.evaluate(didDocumentSurviveNavigation, marker);
  if (c.snapshotMode === "legacy" || sameDocument) await p.reload();
  await p.waitForFunction(
    () =>
      !!document.documentElement &&
      !document.documentElement.hasAttribute("data-hezi-reload") &&
      [...document.querySelectorAll(".ant-tabs-tab-btn")].some(
        (e) => e.textContent?.trim() === "基本信息",
      ),
    undefined,
    { timeout: 45000 },
  );
  await p.waitForFunction(
    () =>
      !!(
        document.querySelector(
          "#form_item_linkList_0_goodsLink",
        ) as HTMLInputElement
      )?.value && !document.querySelector(".ant-spin-spinning"),
    undefined,
    { timeout: 15000 },
  );
  await health(p, c.shop);
}
async function snapshot(
  p: Page,
  c: BrowserConfig,
  itemId: string,
  record?: any,
) {
  const readbackStartedAt = performance.now();
  let listing =
    record ?? (c.snapshotMode === "legacy" ? await locate(p, c, itemId) : null);
  await openEdit(p, c, itemId);
  const openDurationMs = performance.now() - readbackStartedAt;
  let result: any = {
    fields: {},
    specs: {},
    requiredMissing: [],
    mainImages: [],
    detailImages: [],
  };
  if (c.snapshotMode !== "legacy") {
    result = await p.evaluate(
      `(${readSnapshotPanes.toString()})(${readFields.toString()},${formBatch.toString()},${afterSales.toString()})`,
    );
  } else {
    for (const name of [
      "基本信息",
      "上传图片",
      "商品详情",
      "规格参数",
      "销售价格",
      "包装清单",
      "售后服务",
      "物流规则",
    ]) {
      await tab(p, name);
      if (name === "售后服务")
        Object.assign(result.fields, await p.evaluate(afterSales));
      const raw = await p.evaluate(readFields);
      result.requiredMissing.push(...raw.requiredMissing);
      Object.assign(result.specs, raw.specs);
      if (name === "基本信息" || name === "销售价格") {
        if (c.experimentalBatchForm) {
          Object.assign(
            result.fields,
            await p.evaluate(formBatch, {
              keys:
                name === "基本信息"
                  ? [
                      "title",
                      "origin",
                      "model",
                      "weight",
                      "length",
                      "width",
                      "height",
                      "sourceUrl",
                    ]
                  : ["price", "inventory"],
            }),
          );
        } else {
          for (const key of name === "基本信息"
            ? [
                "title",
                "origin",
                "model",
                "weight",
                "length",
                "width",
                "height",
                "sourceUrl",
              ]
            : ["price", "inventory"]) {
            const sel = await fieldSelector(p, key);
            if (sel)
              result.fields[key] = await p.evaluate(
                (s: string) =>
                  (document.querySelector(s) as HTMLInputElement)?.value ?? "",
                sel,
              );
          }
        }
        if (name === "基本信息")
          Object.assign(
            result.fields,
            await p.evaluate(() => {
              const values: Record<string, string> = {};
              const map: Record<string, string> = {
                商品类目: "category",
                品牌: "brand",
                单位: "unit",
              };
              for (const form of document.querySelectorAll(".ant-form-item")) {
                const key =
                  map[
                    form
                      .querySelector("label")
                      ?.textContent?.replace(/[\s*：:]/g, "") ?? ""
                  ];
                if (key) {
                  const input = form.querySelector(
                    key === "category" ? "#form_item_categoryName" : "input",
                  ) as HTMLInputElement;
                  values[key] =
                    form
                      .querySelector(".ant-select-selection-item")
                      ?.textContent?.trim() ||
                    input?.value ||
                    form
                      .querySelector(".ant-form-item-control-input-content")
                      ?.textContent?.trim() ||
                    "";
                }
              }
              const jd = [...document.querySelectorAll("input")].find((x) =>
                /^https:\/\/item\.jd\.com\/\d+\.html/.test(x.value),
              );
              if (jd) values.sourceUrl = jd.value;
              return values;
            }),
          );
      }
      if (name === "上传图片" || name === "商品详情") {
        await p.waitForFunction(
          (detail: boolean) => {
            const imgs = detail
              ? [
                  ...document.querySelectorAll("iframe.tox-edit-area__iframe"),
                ].flatMap((f) => [
                  ...((
                    f as HTMLIFrameElement
                  ).contentDocument?.querySelectorAll("img") ?? []),
                ])
              : ([
                  ...document.querySelectorAll(".img-upload-box img"),
                ] as HTMLImageElement[]);
            return imgs.every((e) => (e as HTMLImageElement).complete);
          },
          name === "商品详情",
          { timeout: 30000 },
        );
      }
      if (name === "上传图片")
        result.mainImages = await p.evaluate(() =>
          [...document.querySelectorAll(".img-upload-box img")].map((e) => ({
            url: (e as HTMLImageElement).src,
            loaded:
              (e as HTMLImageElement).complete &&
              (e as HTMLImageElement).naturalWidth > 0,
          })),
        );
      if (name === "商品详情")
        result.detailImages = await p.evaluate(() => {
          const frames = [...document.querySelectorAll("iframe")].filter(
            (f) =>
              f.id.includes("tiny") ||
              f.classList.contains("tox-edit-area__iframe"),
          );
          return frames.flatMap((f) => {
            try {
              return [
                ...(f.contentDocument?.querySelectorAll("img") ?? []),
              ].map((e) => ({
                url: e.src,
                loaded: e.complete && e.naturalWidth > 0,
              }));
            } catch {
              return [];
            }
          });
        });
      if (name === "包装清单")
        Object.assign(
          result.fields,
          await p.evaluate(() => ({
            packingName:
              (
                document.querySelector(
                  'input[placeholder="附件名称"]',
                ) as HTMLInputElement
              )?.value ?? "",
            packingCount:
              (
                document.querySelector(
                  'input[placeholder="附件数量，请输入1-999的整数"]',
                ) as HTMLInputElement
              )?.value ?? "",
          })),
        );
      if (name === "物流规则")
        result.fields.shippingTemplate = await p.evaluate(
          () =>
            [
              ...document.querySelectorAll(
                ".ant-tabs-tabpane-active .ant-select-selection-item",
              ),
            ]
              .map((x) => x.textContent?.trim() ?? "")
              .filter(Boolean)[0] ?? "",
        );
    }
  }
  const logisticsStartedAt = performance.now();
  const lr = await p.cdp("Runtime.evaluate", {
    expression: `(async()=>{const resolveModule=${resolveLogisticsModule.toString()};const paths=performance.getEntriesByType("resource").map(x=>x.name).filter(x=>/\\/shop-view\\/assets\\/manage-[a-z0-9]+\\.js(?:[?#].*)?$/i.test(x)).slice(-12);return (${readLogistics.toString()})(${JSON.stringify(itemId)},paths,resolveModule)})()`,
    awaitPromise: true,
    returnByValue: true,
  });
  if (lr.exceptionDetails)
    fail(
      "UI_CHANGED",
      "配送关系读回失败",
      lr.exceptionDetails.exception?.description ?? lr.exceptionDetails.text,
    );
  result.logistics = lr.result.value;
  const statusStartedAt = performance.now();
  if (!listing)
    listing = await p.evaluate(
      `(${readExactItem.toString()})(${JSON.stringify(itemId)},${JSON.stringify(result.logistics.sourceShopId)},${JSON.stringify(c.shop)},${resolveSourceModule.toString()})`,
    );

  result.readbackMetrics = {
    ...result.readbackMetrics,
    mode: c.snapshotMode ?? "batched",
    statusDurationMs: performance.now() - statusStartedAt,
    openDurationMs,
    logisticsDurationMs: statusStartedAt - logisticsStartedAt,
    totalDurationMs: performance.now() - readbackStartedAt,
  };
  const sku =
    result.fields.sourceUrl?.match(/item\.jd\.com\/(\d+)\.html/)?.[1] ?? "";
  return {
    itemId,
    code: listing.code,
    sku,
    title: result.fields.title,
    shop: c.shop,
    status: listing.status,
    platformWarning: listing.platformWarning,
    ...result,
    requiredMissing: [...new Set(result.requiredMissing)],
  };
}
const summarySourceAliases = ["毛重", "包装毛重", "含包装重量"];
const packagingSourceAliases = ["包装清单", "销售数量", "装数", "加热器个数"];

async function selectJdBusinessResponse(
  page: Page,
  events: any[],
  expectedSku: string,
) {
  const isCandidate = (event: any) =>
    event.method === "Network.responseReceived" &&
    event.params.type === "XHR" &&
    event.params.response.url.includes("pc_detailpage_wareBusiness");
  let candidates = events.filter(isCandidate);
  if (!candidates.length) return undefined;
  const observedSkus: string[] = [];
  const readRequestIds = new Set<string>();
  let unreadable = 0;
  for (let round = 0; round <= 12; round++) {
    for (const event of [...candidates].reverse()) {
      const requestId = String(event.params.requestId ?? "");
      if (!requestId || readRequestIds.has(requestId)) continue;
      readRequestIds.add(requestId);
      try {
        const response = await page.cdp("Network.getResponseBody", {
          requestId,
        });
        const business = JSON.parse(response.body);
        const observed = String(business?.wareInfoReadMap?.product_id ?? "");
        if (observed) observedSkus.push(observed);
        if (observed === expectedSku) return business;
      } catch {
        unreadable++;
      }
    }
    if (round === 12) break;
    await page.waitForTimeout(250);
    candidates = (await page.events()).filter(isCandidate);
  }
  fail("NEEDS_INPUT", "京东业务响应SKU与请求不符", {
    expectedSku,
    observedSkus: [...new Set(observedSkus)],
    unreadableResponses: unreadable,
  });
}

/** A single normal navigation followed by narrowly-scoped fact readers. */
export async function collectJdRegions(
  page: Page,
  config: BrowserConfig,
  args: { url: string; regions: JdFactRegion[]; fields: string[] },
) {
  const regions = [...new Set(args.regions ?? [])];
  if (
    !regions.length ||
    regions.some(
      (region) =>
        !(["summarySpecs", "detailSpecs", "packaging"] as string[]).includes(
          region,
        ),
    )
  )
    fail("NEEDS_INPUT", "采集区域缺失或不受支持");
  const expectedSku = args.url.match(/\/([0-9]+)\.html(?:[?#]|$)/)?.[1];
  if (!expectedSku) fail("NEEDS_INPUT", "京东商品链接缺少明确SKU");

  await health(page);
  await page.cdp("Network.enable", {});
  await page.events();
  await jdNavigate(
    page,
    config,
    args.url,
    (await page.url()).split("#")[0] === args.url,
  );
  await page.waitForFunction(
    (sku: string) =>
      location.pathname === `/${sku}.html` && document.readyState !== "loading",
    expectedSku,
    { timeout: 15000 },
  );
  await health(page);

  if (regions.some((region) => region !== "summarySpecs")) {
    // Bring only parameter/packaging roots into view. Do not traverse media.
    await page.evaluate((requested: JdFactRegion[]) => {
      const selectors = [
        requested.includes("detailSpecs") ? ".Ptable,.parameter2" : "",
        requested.includes("packaging")
          ? ".package-list,#package-list,[class~='packing-list']"
          : "",
      ].filter(Boolean);
      for (const selector of selectors)
        document.querySelector(selector)?.scrollIntoView({ block: "center" });
    }, regions);
    await page.waitForTimeout(250);
  }

  const raw = await page.evaluate(readJdRegions, regions);
  if (raw.sku !== expectedSku)
    fail("NEEDS_INPUT", "京东页面SKU与请求不符", {
      expected: expectedSku,
      actual: raw.sku,
    });

  const events = await page.events();
  const business = await selectJdBusinessResponse(page, events, expectedSku!);
  if (business) {
    await archiveJdBusinessObservation({
      sourceDatabasePath: config.sourceDatabasePath,
      shop: config.shop,
      sku: expectedSku!,
      sourceUrl: raw.url,
      response: business,
    });
  }

  const responseVariant = business?.wareInfoReadMap?.color
    ? String(business.wareInfoReadMap.color).trim()
    : "";
  const normalizeVariant = (value: string) => value.replace(/\s+/g, "");
  if (
    raw.selectedVariant &&
    responseVariant &&
    normalizeVariant(raw.selectedVariant) !== normalizeVariant(responseVariant)
  )
    fail("NEEDS_INPUT", "京东页面所选规格与业务响应不符", {
      page: raw.selectedVariant,
      response: responseVariant,
    });

  let specs = raw.specs as Record<string, any>;
  if (business && regions.includes("summarySpecs")) {
    const shell: any = {
      sku: expectedSku,
      variant: raw.selectedVariant ?? responseVariant,
      url: raw.url,
      title: {
        value: expectedSku,
        sourceUrl: raw.url,
        capturedAt: raw.capturedAt,
        evidence: "SKU",
      },
      price: null,
      specs,
      assets: [],
      capturedAt: raw.capturedAt,
    };
    specs = enrichJd(shell, business).specs;
  }
  // Keep Browser's established source identity: its Product.variant is empty.
  // The observed caption is evidence, not a second identity dimension.
  if (specs["商品毛重"] && !specs["毛重"]) specs["毛重"] = specs["商品毛重"];
  if (!(args.fields ?? []).includes("商品毛重")) delete specs["商品毛重"];
  const allowed = new Set([
    ...(args.fields ?? []),
    "京东销售规格",
    ...(regions.includes("summarySpecs") ? summarySourceAliases : []),
    ...(regions.includes("packaging") ? packagingSourceAliases : []),
  ]);
  specs = Object.fromEntries(
    Object.entries(specs).filter(([field]) => allowed.has(field)),
  );
  const completeRegions = new Set(raw.observedRegions as JdFactRegion[]);
  if (business && regions.includes("summarySpecs"))
    completeRegions.add("summarySpecs");
  return {
    sku: expectedSku,
    url: raw.url,
    variant: "",
    ...(raw.selectedVariant || responseVariant
      ? { selectedVariant: raw.selectedVariant ?? responseVariant }
      : {}),
    specs,
    observedAt: raw.capturedAt,
    regions,
    completeRegions: regions.filter((region) => completeRegions.has(region)),
  };
}

async function runInternal(env: any, action: string, args: any): Promise<any> {
  if (action === "open") {
    const matches = (await env.profiles()).filter(
      (p: any) => p.name === args.profile,
    );
    if (matches.length !== 1) fail("NEEDS_INPUT", "个人资料名称不存在或重名");
    const t = await env.taskSpace(args.name ?? "京东赫兹发布", {
      profileId: matches[0].id,
    });
    const h = t.page("p1");
    await h.goto("https://b.csgmall.com.cn/shop-view/");
    const j = await t.newPage();
    await j.goto("https://www.jd.com/");
    return {
      spaceId: t.spaceId,
      hzPage: h.label,
      jdPage: j.label,
      profileId: matches[0].id,
    };
  }
  if (action === "resume") {
    await env.takeOverTaskSpace(args.spaceId);
    return { resumed: true };
  }
  const c = args.config as BrowserConfig;
  const t = await env.taskSpace(c.session.spaceId);
  const h = t.page(c.session.hzPage);
  const j = t.page(c.session.jdPage);
  if (action === "handoff") {
    await t.handOff();
    return { handedOff: true };
  }
  if (action === "finish") {
    await t.finish({
      keep: args.keep ? [c.session.hzPage, c.session.jdPage] : [],
    });
    return { finished: true };
  }
  await ensureRequestHook(h);
  if (action === "analytics-shop-page")
    return readAnalyticsShopPage(
      h,
      c,
      { ...args, database: c.sourceDatabasePath },
      health,
    );
  if (action === "scan-market") return scanMarket(h, c, args, health);
  if (action === "market-details") return readMarketDetails(h, c, args, health);
  if (action === "opportunity-details")
    return hydrateOpportunityDetails(h, c, args, health);
  if (action === "discover-source") return discoverSource(j, c, args, health);
  if (action === "search-source-candidates")
    return searchSourceCandidates(j, c, args, health);
  if (action === "sync-brands") {
    await health(h, c.shop);
    return syncBrandInventory(h, c, args);
  }
  if (action === "brand-read") {
    return withHzTraffic(c, "brand-read", async () => {
      await health(h, c.shop);
      return readBrandGrant(h, c, args);
    });
  }
  if (action === "check-hz") {
    await health(h, c.shop);
    return { ready: true };
  }
  if (action === "resume-requests") {
    await health(h, c.shop);
    const reasonIds = args.reasonIds;
    const recoverable = new Set(["http-403", "auth-redirect"]);
    if (
      !Array.isArray(reasonIds) ||
      !reasonIds.length ||
      reasonIds.some(
        (id: unknown) => typeof id !== "string" || !recoverable.has(id),
      )
    )
      fail("NEEDS_INPUT", "缺少已核验的页面暂停原因，保持暂停");
    const r = await h.cdp("Runtime.evaluate", {
      expression: `window.__heziRequests.queue.resumeReasons(${JSON.stringify(reasonIds)})`,
      returnByValue: true,
    });
    if (r.exceptionDetails)
      fail(
        "UNKNOWN_OUTCOME",
        "页面请求暂停原因未能确认恢复",
        r.exceptionDetails.text,
      );
    return { resumed: r.result?.value ?? [] };
  }
  if (action === "inspect")
    return { hezi: await h.evaluate(readPage), jd: await j.evaluate(readPage) };
  if (action === "check-jd") {
    await health(j);
    return { ready: true };
  }
  if (action === "schema")
    return {
      page: await h.evaluate(readPage),
      form: await h.evaluate(readFields),
    };
  if (action === "template-read") {
    return withHzTraffic(c, "template-read", async () => {
      if (args.categoryPath) {
        await prepareNewTemplateWorkspace(h, c, c.shop, health);
        // The category dialog closes before its queued naming/config requests finish.
        // Observe before selection so a temporarily editable title is not cached as manual.
        await observeRequests(h);
        await chooseCategory(h, String(args.categoryPath));
        await settleRequests(h);
        await tab(h, "规格参数");
      } else await health(h, c.shop);
      const template = await h.evaluate(readCategoryTemplate, args.categoryId);
      await tab(h, "基本信息");
      const title = await h.evaluate(readTitleControl);
      if (title.mode !== "platform-generated") return template;
      await button(h, "查看属性命名规则");
      if (args.categoryPath) await settleRequests(h);
      const titleRule = await h.evaluate(readPlatformTitleRule);
      await button(h, "取 消");
      return { ...template, titleRule };
    });
  }
  if (action === "collect-regions") return collectJdRegions(j, c, args);
  if (action === "collect" || action === "refresh-price") {
    await health(j);
    await j.cdp("Network.enable", {});
    await j.events();
    await jdNavigate(
      j,
      c,
      args.url,
      (await j.url()).split("#")[0] === args.url,
    );
    await waitForJdProduct(j);
    if (action === "collect") {
      const details = await j.evaluate(
        () => !!document.querySelector("#SPXQ-tab-column"),
      );
      if (details) {
        await j.click("#SPXQ-tab-column");
        await j.evaluate(() => window.scrollBy(0, 500));
      } else
        for (let i = 0; i < 8; i++)
          await j.evaluate(() => window.scrollBy(0, 800));
      await j
        .waitForFunction(
          () =>
            !!document.querySelector(
              "#detail-main img,#J-detail-content img,.ssd-module-wrap img",
            ),
          undefined,
          { timeout: 15000 },
        )
        .catch(() => {});
      await j.waitForLoadState();
    }
    let raw = await j.evaluate(readJd);
    if (raw.price?.basis !== "jd-price") {
      const opened = await j.evaluate(openJdPriceDetails, raw.sku);
      if (opened) {
        await health(j);
        await j
          .waitForFunction(
            () =>
              [...document.querySelectorAll(".formula-details .item")].some(
                (item) =>
                  ["京东价", "日常价"].includes(
                    item.querySelector(".desc")?.textContent?.trim() ?? "",
                  ) && !!item.querySelector(".jd-price")?.textContent?.trim(),
              ),
            undefined,
            { timeout: 3000 },
          )
          .catch(() => {});
        await health(j);
        raw = await j.evaluate(readJd);
      }
    }
    const events = await j.events();
    if (action === "refresh-price") await health(j);
    const business = await selectJdBusinessResponse(j, events, raw.sku);
    if (business) {
      raw = enrichJd(raw, business);
      await archiveJdBusinessObservation({
        sourceDatabasePath: c.sourceDatabasePath,
        shop: c.shop,
        sku: raw.sku,
        sourceUrl: raw.url,
        response: business,
      });
    }
    if (action === "refresh-price") {
      if (!business || String(business.wareInfoReadMap?.product_id) !== raw.sku)
        fail("NEEDS_INPUT", "价格更新缺少本次加载的SKU业务响应证据");
      if (!raw.price) fail("NEEDS_INPUT", "当前页面没有明确补贴价或京东价");
      raw.assets = [];
      raw.captureMetrics = {
        navigations: 1,
        observableRequests: events.filter(
          (e: any) => e.method === "Network.responseReceived",
        ).length,
        samePageReused: false,
      };
      return raw;
    }
    const hero = await j.evaluate(
      () => (document.querySelector("#spec-img") as HTMLImageElement)?.src,
    );
    const original = business?.mainImageVO?.mainImageArea?.imageUrl;
    if (original && hero?.includes(original)) {
      const offset = hero.indexOf(original),
        prefix = hero.slice(0, offset),
        suffix = hero.slice(offset + original.length);
      const paths: string[] = [
        ...new Set<string>(
          (business.mainImageVO.carouselArea ?? [])
            .filter(
              (x: any) => x.siteType === "1" && x.imageUrl?.startsWith("jfs/"),
            )
            .map((x: any) => x.imageUrl),
        ),
      ];
      const urls = paths.map((path) => prefix + path + suffix);
      if (urls.length >= 3)
        raw.assets = [
          ...urls.map((url, order) => ({ role: "main", url, order })),
          ...raw.assets.filter((a: any) => a.role === "detail"),
        ];
    }
    raw.captureMetrics = {
      navigations: 1,
      observableRequests: events.filter(
        (e: any) => e.method === "Network.responseReceived",
      ).length,
      samePageReused: false,
    };
    return raw;
  }
  if (action === "discover") {
    await health(j);
    await jdNavigate(j, c, args.url);
    await j.waitForFunction(
      () => document.readyState === "complete",
      undefined,
      { timeout: 15000 },
    );
    await health(j);
    for (let i = 0; i < 8; i++) await j.evaluate(() => window.scrollBy(0, 800));
    return await j.evaluate(() => ({
      url: location.href,
      skus: [
        ...new Set(
          [...document.querySelectorAll("a[href]")]
            .map(
              (a) =>
                (a as HTMLAnchorElement).href.match(
                  /^https?:\/\/item\.jd\.com\/(\d+)\.html/,
                )?.[1],
            )
            .filter(Boolean),
        ),
      ],
      pagination: [...document.querySelectorAll("a[href]")]
        .filter((a) => /下一页/.test(a.textContent ?? ""))
        .map((a) => (a as HTMLAnchorElement).href),
    }));
  }
  if (action === "sync-sources") {
    if (c.allowSourceScan !== true)
      fail("NEEDS_INPUT", "全店扫描默认关闭，需单独安排访问预算后启用");
    await withHzTraffic(c, "source-workspace", async () => {
      await ensureSupplierWorkspace(h, c, c.shop, health);
      if ((await h.url()) !== c.listUrl) await h.goto(c.listUrl);
      await health(h, c.shop);
    });
    const store = new Store(args.database);
    const unlock = store.lock("source-scanner");
    try {
      return await syncSources(h, store, c, args.budget);
    } finally {
      unlock();
      store.close();
    }
  }
  if (action === "checkShop") {
    await ensureSupplierWorkspace(h, c, args.shop, health);
    return { ok: true };
  }
  if (action === "list")
    return await withHzTraffic(c, "list", () => listAll(h, c, args.query));
  if (action === "preflight") {
    await ensureSupplierWorkspace(h, c, c.shop, health);
    if (
      !Array.isArray(args.categories) ||
      !args.categories.length ||
      args.categories.length > 12
    )
      fail("NEEDS_INPUT", "每次平台预检需要1至12个明确类目");
    // Hash navigation may leave the previous edit form mounted. Reuse the
    // document proof so a real navigation is not followed by a second reload.
    const marker = String(Date.now()) + ":" + Math.random();
    await h.evaluate(markDocumentForNavigation, marker);
    await h.goto(c.listUrl);
    if (await h.evaluate(didDocumentSurviveNavigation, marker))
      await h.reload();
    try {
      await h.waitForSelector(".ant-table", {
        state: "visible",
        timeout: 15000,
      });
    } catch (error) {
      // A WAF/login page has no table; classify the observed page before
      // reporting a generic UI timeout. This reads only the current document.
      await health(h);
      throw error;
    }
    await health(h, c.shop);
    const modules = await h.evaluate(`(async()=>{
      const read = async path => { const r=await fetch(path); if(!r.ok) throw Error("模块读取失败"); return r.text(); };
      const entry=await (${resolveSourceModule.toString()})([...document.scripts].map(x=>x.src),read);
      const logistics=await (${resolveLogisticsModule.toString()})(performance.getEntriesByType("resource").map(x=>x.name),read);
      (${selectSiteApiClient.toString()})(await import(entry.path));
      return {entry:entry.path,logistics:logistics.path};
    })()`);
    const categories = [];
    for (const category of args.categories) {
      if (category.itemId) await openEdit(h, c, category.itemId);
      else {
        await h.goto(c.newUrl);
        await h.reload();
        await h.waitForSelector("#form_item_categoryName", {
          state: "visible",
          timeout: 15000,
        });
        await health(h, c.shop);
        await chooseCategory(h, category.categoryPath);
      }
      await tab(h, "规格参数");
      const actual = await h.evaluate(
        readCategoryTemplate,
        category.categoryId,
      );
      const controls = await h.evaluate(preflightControls);
      await tab(h, "包装清单");
      const packing = await evaluatePreflightPackingName(
        h,
        category.packingName,
      );
      const issues = [
        ...comparePreflightTemplate(category.template, actual),
        ...controls.issues,
        ...packing.issues,
        ...packing.valueIssues,
      ];
      categories.push({
        categoryId: category.categoryId,
        issues,
        valueIssues: packing.valueIssues,
        packingNameMaxLength: packing.maxLength,
        fields: actual.fields,
      });
    }
    const issues = categories.flatMap((x) =>
      x.issues.map((message) => ({ categoryId: x.categoryId, message })),
    );
    const valueIssues = categories.flatMap((x) =>
      x.valueIssues.map((message: string) => ({
        categoryId: x.categoryId,
        message,
      })),
    );
    if (valueIssues.length)
      fail("VALIDATION_MISSING", "包装名称不符合当前页面限制", valueIssues);
    if (issues.length) fail("UI_CHANGED", "批次平台预检未通过", issues);
    return {
      ready: true,
      checkedAt: new Date().toISOString(),
      modules,
      categories,
    };
  }
  if (action === "catalog-options" || action === "refresh-catalog-options") {
    return withHzTraffic(c, "catalog-options", async () => {
      if (action === "refresh-catalog-options") {
        await ensureSupplierWorkspace(h, c, c.shop, health);
        if ((await h.url()) !== c.listUrl) await h.goto(c.listUrl);
      }
      await health(h, c.shop);
      await h.waitForFunction(
        `(${catalogOptionsReady.toString()})().ready`,
        undefined,
        { timeout: 10000 },
      );
      const result = await h.cdp("Runtime.evaluate", {
        expression: `(${readCatalogOptions.toString()})()`,
        returnByValue: true,
      });
      if (result.exceptionDetails || !result.result?.value)
        fail("UI_CHANGED", "无法读取当前页面目录组件");
      return { ...result.result.value, shop: c.shop };
    });
  }
  if (action === "repair-detail-order") {
    if (!args.write) fail("NEEDS_INPUT", "需要写授权");
    await openEdit(h, c, args.itemId);
    await tab(h, "商品详情");
    await h.waitForFunction(
      (count: number) =>
        (window as any).tinymce?.activeEditor
          ?.getBody()
          ?.querySelectorAll("img").length === count,
      args.before.length,
      { timeout: 15000 },
    );
    const result = await h.evaluate(setDetailOrder, {
      before: args.before,
      urls: args.after,
    });
    await button(h, "保存成功待提交审核");
    await h.waitForURL("**/goods/goods-manage*", { timeout: 30000 });
    return { ...(await locate(h, c, args.itemId)), ...result };
  }
  if (action === "save-prepared") {
    if (!args.write) fail("NEEDS_INPUT", "需要写授权");
    await health(h, c.shop);
    const observed = await h.cdp("Runtime.evaluate", {
      expression: `(async()=>{const resolve=${resolveSourceModule.toString()},read=async path=>{const response=await fetch(path);if(!response.ok)throw Error('Entry source request failed');if(!/javascript|ecmascript/i.test(response.headers.get('content-type')||''))throw Error('Entry source is not JavaScript');return response.text()},scripts=[...document.scripts].map(x=>x.src).filter(Boolean),entry=await resolve(scripts,read);return (${observeNewSave.toString()})(${JSON.stringify(args.sku)},entry.path,${selectSiteApiClient.toString()})})()`,
      awaitPromise: true,
      returnByValue: true,
    });
    if (observed.exceptionDetails)
      fail(
        "UI_CHANGED",
        "无法安装保存回执观察",
        observed.exceptionDetails.text,
      );
    await button(h, "保存成功待提交审核");
    await h.waitForFunction(
      () => !!(window as any).__heziSaveReceipt,
      undefined,
      { timeout: 45000 },
    );
    const receipt = await h.cdp("Runtime.evaluate", {
      expression: "window.__heziSaveReceipt",
      returnByValue: true,
    });
    const itemId = receipt.result?.value?.itemId;
    if (!itemId) fail("UNKNOWN_OUTCOME", "未收到真实保存ID");
    await h.waitForURL("**/goods/goods-manage*", { timeout: 20000 });
    return await savedRecord(h, c, itemId, args.sku);
  }
  if (action === "read") return await snapshot(h, c, args.itemId);
  if (action === "find") {
    const drafts = await listAll(h, c, { title: args.title, draft: true });
    const normal = await listAll(h, c, { title: args.title });
    const all = {
      complete: drafts.complete && normal.complete,
      records: [
        ...new Map(
          [...drafts.records, ...normal.records].map((r) => [r.itemId, r]),
        ).values(),
      ],
    };
    const normalize = (s: string) => s.replace(/[\s*×]/g, "");
    const expected = normalize(args.title);
    const candidates = all.records.filter(
      (r: any) => normalize(r.title) === expected,
    );
    const records = [];
    for (const r of candidates) {
      const itemId = r.itemId;
      if (!itemId) fail("UI_CHANGED", "列表缺少真实 itemId，拒绝用编码代替");
      const snap = await snapshot(h, c, itemId, r);
      if (snap.sku === args.sku) records.push(snap);
    }
    // A complete title scan cannot prove absence for a renamed SKU. Creation needs an explicit reconciled inventory.
    return {
      complete: all.complete && args.inventoryReconciled === true,
      records,
    };
  }
  if (action === "save") {
    if (!args.write) fail("NEEDS_INPUT", "写操作未开启");
    await health(h, c.shop);
    if (args.itemId) await openEdit(h, c, args.itemId);
    else {
      await h.goto(c.newUrl);
      await h.evaluate(() =>
        document.documentElement.setAttribute("data-hezi-new", "old"),
      );
      await h.reload();
      await h.waitForFunction(
        () =>
          !!document.documentElement &&
          !document.documentElement.hasAttribute("data-hezi-new") &&
          !!document.querySelector("#form_item_categoryName") &&
          !document.querySelector(".ant-spin-spinning"),
        undefined,
        { timeout: 45000 },
      );
      await h.waitForSelector("#form_item_categoryName", {
        state: "visible",
        timeout: 15000,
      });
      await health(h, c.shop);
    }
    await tab(h, "基本信息");
    const oldCategory = await h.evaluate(() =>
      (
        document.querySelector("#form_item_categoryName") as HTMLInputElement
      )?.value?.replace(/\s/g, ""),
    );
    if (
      args.itemId &&
      oldCategory !== args.plan.categoryPath.replace(/\s/g, "")
    )
      fail(
        "BUSINESS_BLOCKED",
        "平台变更类目会新建商品，不能作为原记录修改执行",
      );
    if (
      !args.itemId &&
      oldCategory !== args.plan.categoryPath.replace(/\s/g, "")
    ) {
      await chooseCategory(h, args.plan.categoryPath);
    }
    const currentBrand = await h.evaluate(() =>
      document
        .querySelector("#form_item_brandId")
        ?.closest(".ant-select")
        ?.querySelector(".ant-select-selection-item")
        ?.textContent?.trim(),
    );
    if (currentBrand !== args.plan.brand)
      await choose(h, "品牌", args.plan.brand);
    const currentUnit = await h.evaluate(
      () =>
        (document.querySelector("#form_item_skuUnitName") as HTMLInputElement)
          ?.value,
    );
    if (currentUnit !== args.plan.unit)
      await h.fill("#form_item_skuUnitName", args.plan.unit);
    const priceMethod = await h.evaluate(() =>
      document
        .querySelector("#form_item_priceMethod")
        ?.closest(".ant-select")
        ?.querySelector(".ant-select-selection-item")
        ?.textContent?.trim(),
    );
    if (priceMethod !== "电商平台") {
      await h.click("#form_item_priceMethod");
      await h.click('.ant-select-item-option-content:text-is("电商平台")');
      await h.waitForSelector("#form_item_linkList_0_goodsLink", {
        state: "visible",
      });
    }
    const titleControl = await h.evaluate(readTitleControl);
    const generatedTitle = args.plan.titleMode === "platform-generated";
    if ((titleControl.mode === "platform-generated") !== generatedTitle)
      fail("VALIDATION_MISSING", "平台标题命名方式与已核验计划不一致", {
        phase: "title-validation",
        saveDispatched: false,
        sku: args.product.sku,
        shop: args.plan.shop,
      });
    if (c.experimentalBatchForm) {
      const basic = Object.fromEntries(
        Object.entries(args.expected).filter(
          ([key]) =>
            !key.startsWith("after_") &&
            !(generatedTitle && key === "title") &&
            ![
              "brand",
              "unit",
              "category",
              "price",
              "inventory",
              "shippingTemplate",
              "packingName",
              "packingCount",
            ].includes(key),
        ),
      );
      for (const key of args.plan.clearFields ?? []) basic[key] = "";
      await h.evaluate(formBatch, { values: basic });
    } else {
      for (const [key, value] of Object.entries(args.expected))
        if (
          !key.startsWith("after_") &&
          !(generatedTitle && key === "title") &&
          ![
            "brand",
            "unit",
            "category",
            "price",
            "inventory",
            "shippingTemplate",
            "packingName",
            "packingCount",
          ].includes(key)
        )
          await fill(h, key, String(value));
      for (const key of args.plan.clearFields ?? []) await fill(h, key, "");
    }
    // Link-type selector is scoped by its documented form id; no first-option fallback.
    const linkType = await h.evaluate(() => {
      const el = document.querySelector("#form_item_linkList_0_externalId");
      return el
        ? (el
            .closest(".ant-select")
            ?.querySelector(".ant-select-selection-item")
            ?.textContent?.trim() ?? "")
        : null;
    });
    if (linkType !== null && linkType !== "京东") {
      await h.evaluate(() =>
        document
          .querySelector("#form_item_linkList_0_externalId")
          ?.closest(".ant-select")
          ?.setAttribute("data-hezi-linktype", "target"),
      );
      await h.evaluate(() =>
        document
          .querySelector('[data-hezi-linktype="target"]')
          ?.scrollIntoView({ block: "center" }),
      );
      await h.click('[data-hezi-linktype="target"]');
      await h.click('.ant-select-item-option-content:text-is("京东")');
    }
    const mediaReferences: Record<string, string[]> = { main: [], detail: [] };
    for (const role of ["main", "detail"]) {
      await tab(h, role === "main" ? "上传图片" : "商品详情");
      const images = () =>
        h.evaluate((role: string) => {
          if (role === "main")
            return [...document.querySelectorAll(".img-upload-box img")].map(
              (e) => (e as HTMLImageElement).src,
            );
          return [
            ...document.querySelectorAll("iframe.tox-edit-area__iframe"),
          ].flatMap((f) => {
            try {
              return [
                ...((f as HTMLIFrameElement).contentDocument?.querySelectorAll(
                  "img",
                ) ?? []),
              ].map((e) => e.src);
            } catch {
              return [];
            }
          });
        }, role);
      const existing = await images();
      const refs = (args.mediaReferences ?? args.plan.remoteMedia)?.[role];
      if (existing.length) {
        if (!refs || JSON.stringify(existing) !== JSON.stringify(refs))
          fail(
            "NEEDS_INPUT",
            "现有图片与资产映射不一致，需人工核对后更新 remoteMedia",
          );
        if (!args.plan.replaceMedia) {
          mediaReferences[role] = existing;
          continue;
        }
        if (role === "main") {
          for (let i = existing.length; i > 0; i--) {
            await h.hover(".img-upload-box >> nth=0");
            await h.click('.img-upload-box [aria-label="close"] >> nth=0');
            await h.waitForFunction(
              (n: number) =>
                document.querySelectorAll(".img-upload-box img").length === n,
              i - 1,
              { timeout: 5000 },
            );
          }
        } else {
          await h.evaluate(() => {
            const editor = (window as any).tinymce?.activeEditor;
            if (!editor) throw Error("TinyMCE editor unavailable");
            editor.setContent("");
            editor.fire("change");
            editor.save();
          });
        }
      }
      const uploadSelector = async () =>
        await h.evaluate(() => {
          document
            .querySelectorAll("[data-hezi-upload]")
            .forEach((e) => e.removeAttribute("data-hezi-upload"));
          const inputs = [
            ...document.querySelectorAll("input[type=file]"),
          ].filter(
            (e) =>
              e
                .closest(".ant-tabs-tabpane")
                ?.classList.contains("ant-tabs-tabpane-active") &&
              /jpg|png/.test(e.getAttribute("accept") ?? ""),
          );
          if (inputs.length !== 1) return null;
          inputs[0].setAttribute("data-hezi-upload", "target");
          return '[data-hezi-upload="target"]';
        });
      const assets = args.product.assets
        .filter((a: any) => a.role === role)
        .sort((a: any, b: any) => a.order - b.order);
      // Resolve each new URL to its source asset. Upload order does not imply editor order.
      const sourceOrderedUrls: string[] = [];
      for (let i = 0; i < assets.length; i++) {
        const beforeUpload: string[] = await images();
        let afterUpload: string[] | null = null;
        for (let attempt = 0; attempt < MEDIA_UPLOAD_MAX_ATTEMPTS; attempt++) {
          const selector = await uploadSelector();
          if (!selector) fail("UI_CHANGED", "当前图片区上传组件不唯一");
          await h.setInputFiles(selector, [assets[i].path]);
          try {
            await h.waitForFunction(
              ({ role, count }: { role: string; count: number }) => {
                const imgs =
                  role === "main"
                    ? [...document.querySelectorAll(".img-upload-box img")]
                    : [
                        ...document.querySelectorAll(
                          "iframe.tox-edit-area__iframe",
                        ),
                      ].flatMap((f) => {
                        try {
                          return [
                            ...((
                              f as HTMLIFrameElement
                            ).contentDocument?.querySelectorAll("img") ?? []),
                          ];
                        } catch {
                          return [];
                        }
                      });
                if (imgs.length !== count) return false;
                const state = imgs.map((e) => {
                  const image = e as HTMLImageElement;
                  return {
                    src: image.src,
                    complete: image.complete,
                    naturalWidth: image.naturalWidth,
                  };
                });
                return (
                  state.some(
                    (image) =>
                      !/^https?:\/\//i.test(image.src) ||
                      /(?:^|\/)undefined(?:[?#]|$)/i.test(image.src) ||
                      (image.complete && image.naturalWidth <= 0),
                  ) ||
                  state.every(
                    (image) => image.complete && image.naturalWidth > 0,
                  )
                );
              },
              { role, count: i + 1 },
              { timeout: 30000 },
            );
          } catch (error) {
            const message =
              error instanceof Error ? error.message : String(error);
            if (!/(?:timed out|timeout)/iu.test(message)) throw error;
            let images: unknown = [];
            try {
              images = await h.evaluate((uploadRole: string) => {
                const elements =
                  uploadRole === "main"
                    ? [...document.querySelectorAll(".img-upload-box img")]
                    : [
                        ...document.querySelectorAll(
                          "iframe.tox-edit-area__iframe",
                        ),
                      ].flatMap((frame) => [
                        ...(((
                          frame as HTMLIFrameElement
                        ).contentDocument?.querySelectorAll("img") ??
                          []) as any),
                      ]);
                return elements.map((element: any) => ({
                  src: element.src,
                  complete: element.complete,
                  naturalWidth: element.naturalWidth,
                }));
              }, role);
            } catch {}
            fail(
              "UI_CHANGED",
              "平台图片上传等待超时，已在保存前停止",
              mediaUploadFailureDetails(args.product.sku, c.shop, {
                role,
                sourceIndex: i,
                expectedCount: i + 1,
                images,
                timeout: message,
              }),
            );
          }
          const uploadState = await h.evaluate((role: string) => {
            const imgs =
              role === "main"
                ? [...document.querySelectorAll(".img-upload-box img")]
                : [
                    ...document.querySelectorAll(
                      "iframe.tox-edit-area__iframe",
                    ),
                  ].flatMap((f) => {
                    try {
                      return [
                        ...((
                          f as HTMLIFrameElement
                        ).contentDocument?.querySelectorAll("img") ?? []),
                      ];
                    } catch {
                      return [];
                    }
                  });
            return imgs.map((e, index) => {
              const image = e as HTMLImageElement;
              return {
                index,
                src: image.src,
                complete: image.complete,
                naturalWidth: image.naturalWidth,
              };
            });
          }, role);
          if (classifyUploadedMedia(uploadState, i + 1) === "ready") {
            afterUpload = uploadState.map(
              (image: { src: string }) => image.src,
            );
            break;
          }
          const addedIndex = locateSingleAddedMedia(beforeUpload, uploadState);
          const details = mediaUploadFailureDetails(args.product.sku, c.shop, {
            role,
            sourceIndex: i,
            attempt: attempt + 1,
            addedIndex,
            images: uploadState,
          });
          if (attempt === MEDIA_UPLOAD_MAX_ATTEMPTS - 1 || addedIndex === null)
            fail("UI_CHANGED", "平台上传返回无效图片，已在保存前停止", details);
          try {
            if (role === "main") {
              await h.hover(`.img-upload-box >> nth=${addedIndex}`);
              await h.click(
                `.img-upload-box >> nth=${addedIndex} >> [aria-label="close"]`,
              );
            } else
              await h.evaluate((index: number) => {
                const editor = (window as any).tinymce?.activeEditor;
                const image = editor?.getBody()?.querySelectorAll("img")[index];
                if (!editor || !image)
                  throw Error("Invalid upload unavailable");
                image.remove();
                editor.fire("change");
                editor.save();
              }, addedIndex);
            await h.waitForFunction(
              ({ role, count }: { role: string; count: number }) =>
                role === "main"
                  ? document.querySelectorAll(".img-upload-box img").length ===
                    count
                  : [
                      ...document.querySelectorAll(
                        "iframe.tox-edit-area__iframe",
                      ),
                    ].flatMap((f) => {
                      try {
                        return [
                          ...((
                            f as HTMLIFrameElement
                          ).contentDocument?.querySelectorAll("img") ?? []),
                        ];
                      } catch {
                        return [];
                      }
                    }).length === count,
              { role, count: i },
              { timeout: 5000 },
            );
            if (JSON.stringify(await images()) !== JSON.stringify(beforeUpload))
              throw Error("Upload sequence changed during placeholder cleanup");
          } catch (error) {
            fail("UI_CHANGED", "平台上传返回无效图片，已在保存前停止", {
              ...details,
              cleanupError:
                error instanceof Error ? error.message : String(error),
            });
          }
        }
        if (!afterUpload)
          fail(
            "UI_CHANGED",
            "平台上传返回无效图片，已在保存前停止",
            mediaUploadFailureDetails(args.product.sku, c.shop, {
              role,
              sourceIndex: i,
            }),
          );
        const completedUpload = afterUpload!;
        // Compare URL occurrences rather than membership. A platform can return
        // the same CDN URL for two source positions with identical bytes; both
        // positions still belong in the source-ordered mapping.
        const beforeCounts = new Map<string, number>();
        for (const url of beforeUpload)
          beforeCounts.set(url, (beforeCounts.get(url) ?? 0) + 1);
        const added: string[] = [];
        for (const url of completedUpload) {
          const remaining = beforeCounts.get(url) ?? 0;
          if (remaining) beforeCounts.set(url, remaining - 1);
          else added.push(url);
        }
        if (added.length !== 1)
          fail("UI_CHANGED", "无法将新图片唯一映射到源文件");
        sourceOrderedUrls.push(added[0]);
      }
      if (role === "detail") {
        await h.evaluate(setDetailOrder, { urls: sourceOrderedUrls });
      }
      const actual: string[] = await images();
      if (JSON.stringify(actual) !== JSON.stringify(sourceOrderedUrls))
        fail("VALIDATION_MISSING", "图片顺序与源文件清单不一致");
      mediaReferences[role] = sourceOrderedUrls;
    }
    await tab(h, "规格参数");
    for (const [key, fact] of Object.entries(args.plan.specs)) {
      const selector = await h.evaluate((key: string) => {
        document
          .querySelectorAll("[data-hezi-spec]")
          .forEach((e) => e.removeAttribute("data-hezi-spec"));
        const found = [
          ...document.querySelectorAll(".ant-tabs-tabpane-active tr"),
        ].filter((r) => {
          const cells = r.querySelectorAll("td");
          if (cells.length < 2) return false;
          return (
            (
              (cells[0].querySelector("input") as HTMLInputElement)?.value ||
              cells[0].textContent ||
              ""
            )
              .replace(/\*/g, "")
              .trim() === key
          );
        });
        if (found.length !== 1) return null;
        const input = found[0]
          .querySelectorAll("td")[1]
          .querySelector("input,textarea");
        if (!input) return null;
        input.setAttribute("data-hezi-spec", "target");
        return '[data-hezi-spec="target"]';
      }, key);
      if (!selector) fail("UI_CHANGED", "规格字段不能唯一定位：" + key);
      const isSelect = await h.evaluate(
        (selector: string) =>
          !!document.querySelector(selector)?.closest(".ant-select"),
        selector,
      );
      if (isSelect) {
        await h.click(selector);
        const marked = await h.evaluate(
          (value: string) => {
            document
              .querySelectorAll("[data-hezi-spec-option]")
              .forEach((x) => x.removeAttribute("data-hezi-spec-option"));
            const options = [
              ...document.querySelectorAll(".ant-select-item-option"),
            ].filter(
              (x) =>
                x.getBoundingClientRect().height > 0 &&
                x.textContent?.trim() === value,
            );
            if (options.length !== 1) return false;
            options[0].setAttribute("data-hezi-spec-option", "target");
            return true;
          },
          (fact as any).value,
        );
        if (!marked) fail("NEEDS_INPUT", "规格选项不能唯一匹配：" + key);
        await h.click('[data-hezi-spec-option="target"]');
      } else {
        await h.fill(selector, (fact as any).value);
        await h.press(selector, "Tab");
      }
    }
    if (args.expected.packingName) {
      await tab(h, "包装清单");
      const packing = await h.evaluate(() => {
        const inputs = [
          ...document.querySelectorAll('input[placeholder="附件名称"]'),
        ] as HTMLInputElement[];
        const filled = inputs.filter((e) => e.value.trim());
        const chosen =
          filled.length === 1
            ? filled[0]
            : filled.length === 0
              ? inputs[0]
              : null;
        if (!chosen) return null;
        const row = chosen.closest("tr");
        if (
          !row?.querySelector(
            'input[placeholder="附件数量，请输入1-999的整数"]',
          )
        )
          return null;
        document
          .querySelectorAll("[data-hezi-packing]")
          .forEach((e) => e.removeAttribute("data-hezi-packing"));
        row.setAttribute("data-hezi-packing", "target");
        return { maxLength: chosen.maxLength };
      });
      if (!packing) fail("UI_CHANGED", "包装清单不是唯一有效行，需要多行适配");
      if (
        packing.maxLength > 0 &&
        args.expected.packingName.length > packing.maxLength
      )
        fail("VALIDATION_MISSING", "包装名称超过页面长度限制");
      await h.fill(
        '[data-hezi-packing="target"] input[placeholder="附件名称"]',
        args.expected.packingName,
      );
      await h.press(
        '[data-hezi-packing="target"] input[placeholder="附件名称"]',
        "Tab",
      );
      await h.fill(
        '[data-hezi-packing="target"] input[placeholder="附件数量，请输入1-999的整数"]',
        args.expected.packingCount,
      );
      await h.press(
        '[data-hezi-packing="target"] input[placeholder="附件数量，请输入1-999的整数"]',
        "Tab",
      );
    }
    await tab(h, "销售价格");
    await h.evaluate(formBatch, {
      values: {
        price: args.expected.price,
        inventory: args.expected.inventory,
      },
    });
    await tab(h, "物流规则");
    const currentShipping = await h.evaluate(() =>
      [
        ...document.querySelectorAll(
          ".ant-tabs-tabpane-active .ant-select-selection-item",
        ),
      ]
        .map((e) => e.textContent?.trim())
        .find((x) => x?.includes("包邮")),
    );
    if (currentShipping !== args.plan.shippingTemplate)
      await choose(h, "配置运费模板", args.plan.shippingTemplate);
    if (!args.itemId) {
      if (!args.plan.logistics) fail("NEEDS_INPUT", "缺少有来源的配送配置");
      const r = await h.cdp("Runtime.evaluate", {
        expression: `(${applyLogistics.toString()})(${JSON.stringify(args.plan.logistics)})`,
        awaitPromise: true,
        returnByValue: true,
      });
      if (r.exceptionDetails)
        fail("UI_CHANGED", "配送配置未通过", r.exceptionDetails.text);
    }
    if (args.plan.afterSales) {
      await tab(h, "售后服务");
      await h.evaluate(afterSales, args.expected);
    }
    if (generatedTitle) {
      await tab(h, "基本信息");
      const finalTitle = await h.evaluate(readTitleControl);
      if (
        finalTitle.mode !== "platform-generated" ||
        finalTitle.value !== args.expected.title
      )
        fail("VALIDATION_MISSING", "平台自动生成标题与已核验计划不一致", {
          phase: "title-validation",
          saveDispatched: false,
          sku: args.product.sku,
          shop: args.plan.shop,
          expected: args.expected.title,
          actual: finalTitle.value,
        });
    }
    if (args.prepareOnly) return { mediaReferences, prepared: true };
    if (!args.itemId) {
      const observation = await h.cdp("Runtime.evaluate", {
        expression: `(async()=>{const resolve=${resolveSourceModule.toString()},read=async path=>{const response=await fetch(path);if(!response.ok)throw Error('Entry source request failed');if(!/javascript|ecmascript/i.test(response.headers.get('content-type')||''))throw Error('Entry source is not JavaScript');return response.text()},scripts=[...document.scripts].map(x=>x.src).filter(Boolean),entry=await resolve(scripts,read);return (${observeNewSave.toString()})(${JSON.stringify(args.product.sku)},entry.path,${selectSiteApiClient.toString()})})()`,
        awaitPromise: true,
        returnByValue: true,
      });
      if (observation.exceptionDetails) fail("UI_CHANGED", "无法观察新建回执");
    }
    await button(
      h,
      args.plan.saveMode === "ready" ? "保存成功待提交审核" : "保存草稿",
    );
    if (args.itemId) {
      await h.waitForURL("**/goods/goods-manage*", { timeout: 20000 });
      const r = await savedRecord(h, c, args.itemId, args.product.sku);
      return { ...r, mediaReferences };
    }
    try {
      await h.waitForFunction(
        () =>
          !!(window as any).__heziSaveReceipt ||
          !!(window as any).__heziSaveDiagnostic,
        undefined,
        { timeout: 20000 },
      );
    } catch (error) {
      const diagnostic = await h.cdp("Runtime.evaluate", {
        expression: "window.__heziSaveDiagnostic",
        returnByValue: true,
      });
      fail("UNKNOWN_OUTCOME", "保存结果等待超时", {
        error: error instanceof Error ? error.message : String(error),
        saveDiagnostic: diagnostic.result?.value ?? null,
      });
    }
    const observedSave = await h.cdp("Runtime.evaluate", {
      expression:
        "({receipt:window.__heziSaveReceipt,diagnostic:window.__heziSaveDiagnostic})",
      returnByValue: true,
    });
    const itemId = observedSave.result?.value?.receipt?.itemId;
    if (!itemId)
      fail("UNKNOWN_OUTCOME", "保存请求未返回可确认的新建ID", {
        saveDiagnostic: observedSave.result?.value?.diagnostic ?? null,
      });
    try {
      await h.waitForURL("**/goods/goods-manage*", { timeout: 20000 });
    } catch (error) {
      fail("UNKNOWN_OUTCOME", "已取得保存ID但页面未返回商品列表", {
        itemId,
        error: error instanceof Error ? error.message : String(error),
        saveDiagnostic: observedSave.result?.value?.diagnostic ?? null,
      });
    }
    const record = await savedRecord(h, c, itemId, args.product.sku);
    return { ...record, mediaReferences };
  }
  if (action === "withdraw") {
    if (!args.write) fail("NEEDS_INPUT", "写操作未开启");
    const before = await locate(h, c, args.itemId);
    if (!["待审核", "审核中"].includes(before.status))
      fail("BUSINESS_BLOCKED", "原商品已不处于待审核状态", before);
    await h.evaluate((id: string) => {
      const rows = [...document.querySelectorAll("tbody tr")].filter((e) =>
        [...e.querySelectorAll("td")].some(
          (td) => td.textContent?.trim() === id,
        ),
      );
      if (rows.length !== 1) throw Error("无法唯一定位撤回商品");
      const buttons = [...rows[0].querySelectorAll("button")].filter(
        (e) => e.textContent?.trim() === "撤销",
      );
      if (buttons.length !== 1) throw Error("未找到原商品撤销按钮");
      buttons[0].setAttribute("data-hezi-withdraw", "true");
    }, args.itemId);
    await h.click('[data-hezi-withdraw="true"]');
    await h.waitForFunction(
      () =>
        [...document.querySelectorAll('[role="dialog"]')].some((e) =>
          e.textContent?.includes(
            "撤销后，商品会更新为待提交状态，确认要撤销吗？",
          ),
        ),
      undefined,
      { timeout: 10000 },
    );
    await h.evaluate(() => {
      const dialogs = [...document.querySelectorAll('[role="dialog"]')].filter(
        (e) =>
          e.textContent?.includes(
            "撤销后，商品会更新为待提交状态，确认要撤销吗？",
          ),
      );
      if (dialogs.length !== 1) throw Error("撤回确认内容不符");
      const buttons = [...dialogs[0].querySelectorAll("button")].filter(
        (e) => e.textContent?.replace(/\s/g, "") === "确定",
      );
      if (buttons.length !== 1) throw Error("撤回确认按钮不唯一");
      buttons[0].setAttribute("data-hezi-withdraw-confirm", "true");
    });
    await h.waitForFunction(
      () => {
        const b = document.querySelector(
          '[data-hezi-withdraw-confirm="true"]',
        ) as HTMLButtonElement | null;
        if (!b || b.disabled) return false;
        const dialog = b.closest('[role="dialog"]');
        if (
          !dialog ||
          dialog
            .getAnimations({ subtree: true })
            .some((a) => a.playState === "running")
        )
          return false;
        const r = b.getBoundingClientRect();
        const hit = document.elementFromPoint(
          r.x + r.width / 2,
          r.y + r.height / 2,
        );
        return r.width > 0 && r.height > 0 && !!hit && b.contains(hit);
      },
      undefined,
      { timeout: 10000 },
    );
    await h.click('[data-hezi-withdraw-confirm="true"]');
    await h.waitForFunction(
      (id: string) =>
        [...document.querySelectorAll("tbody tr")].some(
          (e) =>
            [...e.querySelectorAll("td")].some(
              (td) => td.textContent?.trim() === id,
            ) && e.textContent?.includes("待提交"),
        ),
      args.itemId,
      { timeout: 30000 },
    );
    const record = await locate(h, c, args.itemId);
    return await snapshot(h, c, args.itemId, record);
  }
  if (action === "submit" || action === "repair-rejected") {
    if (!args.write) fail("NEEDS_INPUT", "写操作未开启");
    if (action === "repair-rejected") {
      const current = await snapshot(h, c, args.itemId);
      const editable = [
        "已驳回",
        "审核不通过",
        ...(args.allowReadyForSale === true ? ["待上架"] : []),
      ];
      if (
        !editable.includes(current.status) ||
        current.sku !== args.sku ||
        current.shop !== c.shop
      )
        fail("BUSINESS_BLOCKED", "修订前商品身份或审核状态已变化");
      if (
        !args.before ||
        digest(rejectionContent(current)) !==
          digest(rejectionContent(args.before))
      )
        fail("VALIDATION_MISSING", "修订前远端内容已变化，需重新核对");
      if (
        typeof args.expected?.title !== "string" ||
        !args.expected.title.trim() ||
        args.plan?.specs?.["规格"]?.value !== "一个装"
      )
        fail("VALIDATION_MISSING", "缺少本次已授权标题与单件装规格修订");
      await tab(h, "基本信息");
      await h.evaluate(formBatch, { values: { title: args.expected.title } });
      await tab(h, "规格参数");
      const selector = await h.evaluate(
        markRejectionSpec,
        current.specs["规格"],
      );
      await h.evaluate(() => {
        document
          .querySelector('[data-hezi-repair-spec="true"]')
          ?.scrollIntoView({ block: "center" });
      });
      await h.fill(selector, "一个装");
      await h.press(selector, "Tab");
      const patched = await h.evaluate(readFields);
      if (patched.specs["规格"] !== "一个装")
        fail("VALIDATION_MISSING", "规格修订尚未应用");
    } else await openEdit(h, c, args.itemId);
    // Observe transient business errors while the submit dialog sequence is running.
    await h.evaluate(() => {
      const w = window as any;
      w.__heziErrors = [];
      w.__heziObserver?.disconnect();
      w.__heziObserver = new MutationObserver(() => {
        for (const e of document.querySelectorAll(
          ".ant-message-error,.ant-form-item-explain-error",
        )) {
          const text = e.textContent?.trim();
          if (text && !w.__heziErrors.includes(text)) w.__heziErrors.push(text);
        }
      });
      w.__heziObserver.observe(document.body, {
        childList: true,
        subtree: true,
      });
    });
    try {
      await button(h, "保存成功并提交审核");
      await completeSubmissionDialogs({
        observe: async () => {
          await h.waitForFunction(
            () =>
              location.href.includes("goods-manage") ||
              (window as any).__heziErrors?.length ||
              [...document.querySelectorAll("[role=dialog]")].some(
                (e) => (e as HTMLElement).getBoundingClientRect().width > 0,
              ),
            undefined,
            { timeout: 15000 },
          );
          const state = await h.evaluate(() => ({
            url: location.href,
            errors: (window as any).__heziErrors as string[],
            modals: [...document.querySelectorAll("[role=dialog]")]
              .filter(
                (e) => (e as HTMLElement).getBoundingClientRect().width > 0,
              )
              .map((e) => e.textContent ?? ""),
          }));
          if (state.errors.length)
            fail(
              /资质|经营范围/.test(state.errors.join(" "))
                ? "BUSINESS_BLOCKED"
                : "VALIDATION_MISSING",
              state.errors.join("; "),
            );
          if (state.url.includes("goods-manage"))
            return { kind: "completed", evidence: state.url };
          if (state.modals.length !== 1)
            fail("UI_CHANGED", "提交确认窗口不唯一", { modals: state.modals });
          return { kind: "dialog", text: state.modals[0] };
        },
        click: async (action) => {
          await button(
            h,
            action === "apply-current-product-name"
              ? "应用目前商品命名"
              : "确定",
          );
        },
        waitChange: async (previous) => {
          if (previous.kind !== "dialog") throw Error("缺少提交弹窗前态");
          await h.waitForFunction(
            (text: string) =>
              location.href.includes("goods-manage") ||
              (window as any).__heziErrors?.length ||
              (() => {
                const modals = [...document.querySelectorAll("[role=dialog]")]
                  .filter(
                    (e) => (e as HTMLElement).getBoundingClientRect().width > 0,
                  )
                  .map((e) => e.textContent ?? "");
                return modals.length !== 1 || modals[0] !== text;
              })(),
            previous.text,
            { timeout: 15000 },
          );
        },
      });
      const r =
        c.snapshotMode === "legacy"
          ? await locate(h, c, args.itemId)
          : undefined;
      const s = await snapshot(h, c, args.itemId, r);
      return s;
    } finally {
      await h
        .evaluate(() => {
          (window as any).__heziObserver?.disconnect();
        })
        .catch(() => {});
    }
  }
  fail("NEEDS_INPUT", "未知浏览器操作：" + action);
}

/** Capture successful-round metrics without changing the operation receipt. */
export async function run(env: any, action: string, args: any): Promise<any> {
  let result;
  try {
    if (
      [
        "collect",
        "collect-regions",
        "refresh-price",
        "discover",
        "discover-source",
      ].includes(action)
    ) {
      const path = args.config?.sourceDatabasePath ?? args.database;
      if (!path) throw Error("缺少京东持久化流量数据库");
      const store = new Store(path);
      try {
        result = await new JdTraffic(store, args.config.shop).exclusive(
          "browser",
          () => runInternal(env, action, args),
        );
      } finally {
        store.close();
      }
    } else result = await runInternal(env, action, args);
  } catch (error: any) {
    if (
      [
        "collect",
        "collect-regions",
        "refresh-price",
        "discover",
        "discover-source",
      ].includes(action) &&
      ["RATE_LIMITED", "AUTH_REQUIRED"].includes(error?.code)
    ) {
      const path = args.config?.sourceDatabasePath ?? args.database;
      if (path) {
        const store = new Store(path);
        try {
          if (error.code === "RATE_LIMITED")
            new JdTraffic(store, args.config.shop).risk(error.message);
          new JdTraffic(store, args.config.shop).pauseAccount(
            error.code,
            error.message,
          );
        } finally {
          store.close();
        }
      }
    }
    throw error;
  }
  if (
    args.config?.requestMetricsPath &&
    !["finish", "handoff", "open", "resume"].includes(action)
  ) {
    const t = await env.taskSpace(args.config.session.spaceId);
    const p = t.page(args.config.session.hzPage);
    const observed = await p.cdp("Runtime.evaluate", {
      expression:
        "JSON.stringify(window.__heziRequests ? {state:window.__heziRequests.queue.snapshot(),records:window.__heziRequests.records} : null)",
      returnByValue: true,
    });
    const metrics = JSON.parse(observed.result?.value ?? "null");
    if (!metrics)
      fail("UNKNOWN_OUTCOME", "操作已执行，但请求队列核验失败；对账后继续");
    const path = args.config.requestMetricsPath;
    await writeFile(
      path + ".tmp",
      JSON.stringify({
        ...metrics,
        checkedAt: new Date().toISOString(),
        scope: "managed-hezi-page-fetch-xhr",
      }),
    );
    await rename(path + ".tmp", path);
  }
  return result;
}
