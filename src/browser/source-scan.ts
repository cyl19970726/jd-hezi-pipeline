import { resolveLogisticsModule } from "./logistics-client.js";
import { resolveSourceModule } from "./source-client.js";

type SourceClients = {
  source: { path: string; exports: { list: string; links: string } };
  logistics: { path: string; exports: { item: string } };
};

export type SourceScanBudget = { maxRequests: number; intervalMs: number };
export class SourceBudgetReached extends Error {}
export function sourceScanBudget(
  input?: Partial<SourceScanBudget>,
): SourceScanBudget {
  const budget = {
    maxRequests: input?.maxRequests ?? 150,
    intervalMs: input?.intervalMs ?? 1000,
  };
  if (
    !Number.isInteger(budget.maxRequests) ||
    budget.maxRequests < 1 ||
    budget.maxRequests > 500 ||
    !Number.isFinite(budget.intervalMs) ||
    budget.intervalMs < 334
  )
    throw Error("无效来源扫描预算");
  return budget;
}
export function reserveSourceRequest(used: number, budget: SourceScanBudget) {
  if (used >= budget.maxRequests)
    throw new SourceBudgetReached("来源扫描预算已用完");
  return used + 1;
}
export function validSourcePagination(data: any, requestedPage: number) {
  if (
    !Number.isInteger(data?.total) ||
    data.total < 0 ||
    !Number.isInteger(data?.pages) ||
    data.pages < 0
  )
    return false;
  if (data.page === requestedPage) return true;
  return (
    requestedPage === 1 &&
    data.page === 0 &&
    data.total === 0 &&
    data.pages === 0 &&
    Array.isArray(data.items) &&
    data.items.length === 0
  );
}

export function storeFreshSource(
  index: SourceIndex,
  scan: number,
  shop: string,
  item: any,
  links: { skus: string[]; resolved: boolean; unresolvedUrls?: string[] },
) {
  index.put(
    scan,
    shop,
    {
      ...item,
      sku: "",
      sourceIssues: links.unresolvedUrls ?? [],
    },
    item.revision,
    links.skus,
    links.resolved,
  );
}

/** Page-side read calls observed in the supplier list and its expanded SKU rows. */
export async function sourceList(args: {
  page: number;
  draft: boolean;
  hidden: boolean;
  shopId: string;
  shop: string;
  clients: SourceClients;
}) {
  const m = await import(/* @vite-ignore */ args.clients.source.path);
  const read = m[args.clients.source.exports.list];
  if (typeof read !== "function") throw Error("Source list export missing");
  const r = await read(
    {
      pageNum: args.page,
      pageSize: 100,
      shopId: args.shopId,
      hideStatus: args.hidden ? 1 : 0,
      ...(args.draft ? { itemStatusList: ["99"] } : {}),
    },
    "none",
  );
  if (r.totalCount === 0 && r.result === null && r.totalPageCount === 0)
    r.result = [];
  if (!Array.isArray(r.result) || !Number.isFinite(r.totalCount))
    throw Error("Invalid list response");
  if (
    r.result.some(
      (x: any) => String(x.shopId) !== args.shopId || x.shopName !== args.shop,
    )
  )
    throw Error("Shop differs");
  return {
    total: r.totalCount,
    pages: r.totalPageCount,
    page: r.pageNum,
    items: r.result.map((x: any) => ({
      itemId: String(x.id),
      code: String(x.id),
      title: x.itemName,
      shop: x.shopName,
      status: x.saleStatusView,
      revision: String(x.modified ?? x.modifyItemTime ?? ""),
      hasLinks: x.isHasExternalLink,
    })),
  };
}
export async function sourceLinks(args: {
  itemId: string;
  draft: boolean;
  clients: SourceClients;
}) {
  let rows: any[],
    resolved = true;
  if (args.draft) {
    const d = await import(args.clients.logistics.path),
      read = d[args.clients.logistics.exports.item];
    if (typeof read !== "function") throw Error("Draft item export missing");
    const r = await read({ itemId: args.itemId }, "none");
    if (!r || typeof r !== "object") throw Error("Invalid draft item response");
    if (String(r.id) !== args.itemId) throw Error("Draft identity differs");
    rows = r.itemTmplSkuVoList;
  } else {
    const m = await import(args.clients.source.path),
      read = m[args.clients.source.exports.links];
    if (typeof read !== "function") throw Error("Source links export missing");
    const r = await read(
      { pageNum: 1, pageSize: 100, itemId: args.itemId },
      "none",
    );
    if (!Array.isArray(r.result)) throw Error("Invalid SKU response");
    rows = r.result;
    resolved = rows.length === r.totalCount && rows.length > 0;
  }
  if (!Array.isArray(rows)) throw Error("Missing SKU rows");
  const skus: string[] = [],
    unresolvedUrls: string[] = [];
  for (const sku of rows) {
    if (!args.draft && String(sku.itemId) !== args.itemId)
      throw Error("Item identity differs");
    for (const link of sku.skuPicUrls ?? []) {
      if (link.externalId === 1 || link.name === "京东") {
        const match = link.url
          ?.trim()
          .match(
            /^(?:\d+\s+)?(?:https?|ttps):\/\/(?:(?:i|ic)-)?item\.jd\.com\/(\d+)(?:\.h(?:tml)?)?(?:[?#].*)?$/,
          );
        if (match) skus.push(match[1]);
        else {
          resolved = false;
          unresolvedUrls.push(String(link.url));
        }
      }
    }
  }
  return { skus: [...new Set(skus)], resolved, unresolvedUrls };
}
export async function sourceLinksBatch(args: {
  items: { itemId: string; draft: boolean }[];
  reader: string;
}) {
  const read = (0, eval)("(" + args.reader + ")"),
    results: any[] = [];
  if (args.items.length > 1)
    throw Error("批量详情读取已禁用；必须逐请求经过流量控制");
  for (const item of args.items)
    results.push({ itemId: item.itemId, ...(await read(item)) });
  return results;
}

import { Traffic } from "../traffic.js";
import { Store } from "../store.js";
import { SourceIndex, type SourceScanCheckpoint } from "../source-index.js";
import type { BrowserConfig } from "./runtime.js";
export async function syncSources(
  p: any,
  store: Store,
  c: BrowserConfig,
  inputBudget?: Partial<SourceScanBudget>,
) {
  store.assertRunning(c.shop);
  const budget = sourceScanBudget(inputBudget),
    traffic = new Traffic(store, c.shop, undefined, {
      intervalMs: budget.intervalMs,
      hourlyLimit: null,
    });
  const index = new SourceIndex(store),
    scanState = index.beginOrResume(c.shop),
    scan = scanState.scan,
    coverage: { partition: string; expected: number; seen: number }[] = [];
  let requests = 0;
  try {
    const candidatesResult = await p.cdp("Runtime.evaluate", {
      expression: `({scripts:[...document.scripts].map(x=>x.src).filter(Boolean),resources:performance.getEntriesByType('resource').map(x=>x.name)})`,
      awaitPromise: true,
      returnByValue: true,
    });
    if (candidatesResult.exceptionDetails)
      throw Error(
        candidatesResult.exceptionDetails.exception?.description ??
          candidatesResult.exceptionDetails.text,
      );
    const candidates = candidatesResult.result.value;
    if (
      !Array.isArray(candidates?.scripts) ||
      !Array.isArray(candidates?.resources)
    )
      throw Error("Source client candidates missing");
    let swallowedStop: unknown = null;
    const readModule = async (path: string) => {
      try {
        requests = reserveSourceRequest(requests, budget);
      } catch (error) {
        if (
          error instanceof SourceBudgetReached ||
          (error as any)?.code === "PAUSED"
        )
          swallowedStop = error;
        throw error;
      }
      let result: any;
      try {
        result = await traffic.run<any>("source-client-module", () =>
          p.cdp("Runtime.evaluate", {
            expression: `(async()=>{const response=await fetch(${JSON.stringify(path)});if(!response.ok)throw Error('Client source request failed');if(!/javascript|ecmascript/i.test(response.headers.get('content-type')||''))throw Error('Client source is not JavaScript');return response.text()})()`,
            awaitPromise: true,
            returnByValue: true,
          }),
        );
      } catch (error) {
        if ((error as any)?.code === "PAUSED") swallowedStop = error;
        throw error;
      }
      if (result.exceptionDetails)
        throw Error(
          result.exceptionDetails.exception?.description ??
            result.exceptionDetails.text,
        );
      return String(result.result.value);
    };
    let clients: SourceClients;
    try {
      clients = {
        source: await resolveSourceModule(candidates.scripts, readModule),
        logistics: await resolveLogisticsModule(
          candidates.resources,
          readModule,
        ),
      };
    } catch (error) {
      if (swallowedStop) throw swallowedStop;
      throw error;
    }
    if (!clients?.source?.path || !clients?.logistics?.path)
      throw Error("Source clients could not be resolved");
    requests = reserveSourceRequest(requests, budget);
    const shopId = await traffic.run<any>("source-shop", () =>
      p.cdp("Runtime.evaluate", {
        expression: `(async()=>{const client=${JSON.stringify(clients.source)};const m=await import(client.path),read=m[client.exports.list];if(typeof read!=='function')throw Error('Source list export missing');const r=await read({pageNum:1,pageSize:1},'none'),row=r.result?.[0];if(!row||row.shopName!==${JSON.stringify(c.shop)})throw Error('Shop identity differs');return String(row.shopId)})()`,
        awaitPromise: true,
        returnByValue: true,
      }),
    );
    if (shopId.exceptionDetails) throw Error("Cannot identify shop");
    const call = async (fn: Function, arg: unknown) => {
      requests = reserveSourceRequest(requests, budget);
      const r = await traffic.run("source-" + fn.name, async () => {
        const result = await p.cdp("Runtime.evaluate", {
          expression: `(${fn.toString()})(${JSON.stringify(arg)})`,
          awaitPromise: true,
          returnByValue: true,
        });
        if (result.exceptionDetails)
          throw Error(
            result.exceptionDetails.exception?.description ??
              result.exceptionDetails.text,
          );
        return result;
      });
      if (r.exceptionDetails)
        throw Error(
          r.exceptionDetails.exception?.description ?? r.exceptionDetails.text,
        );
      return r.result.value;
    };
    let fetched = 0,
      cached = 0;
    for (const hidden of [false, true])
      for (const draft of [false, true]) {
        const partition =
            (hidden ? "hidden" : "visible") +
            "-" +
            (draft ? "draft" : "normal"),
          existing = index.checkpoint(scan, partition),
          checkpoint: SourceScanCheckpoint = existing ?? {
            partition,
            expected: null,
            pages: null,
            nextPage: 1,
            seen: [],
            page: null,
            complete: false,
          },
          seen = new Set<string>(checkpoint.seen);
        if (checkpoint.complete) {
          coverage.push({
            partition,
            expected: checkpoint.expected!,
            seen: seen.size,
          });
          continue;
        }
        for (let page = checkpoint.nextPage; page <= 1000; page++) {
          const data = await call(sourceList, {
            page,
            draft,
            hidden,
            shopId: shopId.result.value,
            shop: c.shop,
            clients,
          });
          if (!validSourcePagination(data, page))
            throw Error(
              "Invalid inventory pagination: " +
                JSON.stringify({
                  requestedPage: page,
                  returnedPage: data.page,
                  total: data.total,
                  pages: data.pages,
                }),
            );
          if (checkpoint.expected === null) {
            checkpoint.expected = data.total;
            checkpoint.pages = data.pages;
          } else if (
            checkpoint.expected !== data.total ||
            checkpoint.pages !== data.pages
          )
            throw Error(
              "Inventory changed during scan, retry from persisted cache",
            );
          const ids = data.items.map((item: any) => item.itemId);
          if (new Set(ids).size !== ids.length)
            throw Error("Repeated inventory page");
          if (checkpoint.page) {
            if (
              checkpoint.page.number !== page ||
              JSON.stringify(checkpoint.page.items) !==
                JSON.stringify(data.items)
            )
              throw Error("Inventory page changed during resumed detail scan");
          } else {
            if (ids.some((id: string) => seen.has(id)))
              throw Error("Repeated inventory page");
            checkpoint.page = {
              number: page,
              total: data.total,
              pages: data.pages,
              items: data.items,
              nextDetail: 0,
            };
            index.saveCheckpoint(scan, checkpoint);
          }
          for (
            let offset = checkpoint.page.nextDetail;
            offset < data.items.length;
            offset++
          ) {
            const item = data.items[offset];
            let skus = index.cached(c.shop, item.itemId, item.revision),
              resolved = true,
              sourceIssues: string[] = [];
            if (skus !== null) cached++;
            else if (item.hasLinks === false && !draft) skus = [];
            else {
              const [links] = await call(sourceLinksBatch, {
                items: [{ itemId: item.itemId, draft, clients }],
                reader: sourceLinks.toString(),
              });
              skus = links.skus;
              resolved = links.resolved;
              sourceIssues = links.unresolvedUrls ?? [];
              fetched++;
            }
            index.put(
              scan,
              c.shop,
              {
                ...item,
                sku: "",
                sourceIssues,
              },
              item.revision,
              skus!,
              resolved,
            );
            checkpoint.page.nextDetail = offset + 1;
            index.saveCheckpoint(scan, checkpoint);
          }
          for (const id of ids) seen.add(id);
          checkpoint.seen = [...seen];
          checkpoint.nextPage = page + 1;
          checkpoint.page = null;
          store.setMeta("source-index-progress", {
            scan,
            resumed: scanState.resumed,
            partition,
            seen: seen.size,
            total: checkpoint.expected,
            fetched,
            cached,
            at: new Date().toISOString(),
          });
          index.saveCheckpoint(scan, checkpoint);
          if (page >= data.pages) {
            checkpoint.complete = true;
            index.saveCheckpoint(scan, checkpoint);
            coverage.push({
              partition,
              expected: checkpoint.expected!,
              seen: seen.size,
            });
            break;
          }
        }
      }
    const complete = index.finish(scan, coverage);
    store.setMeta("source-index-progress", {
      scan,
      resumed: scanState.resumed,
      complete,
      fetched,
      cached,
      coverage,
      at: new Date().toISOString(),
    });
    return {
      scan,
      resumed: scanState.resumed,
      complete,
      fetched,
      cached,
      requests,
      maxRequests: budget.maxRequests,
      coverage,
    };
  } catch (e) {
    if (e instanceof SourceBudgetReached)
      return {
        complete: false,
        scan,
        resumed: scanState.resumed,
        budgetExhausted: true,
        requests,
        maxRequests: budget.maxRequests,
        coverage,
      };
    if ((e as any)?.code === "PAUSED") throw e;
    index.finish(scan, coverage, true);
    throw e;
  }
}
