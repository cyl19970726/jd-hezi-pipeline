import { EgoBridge } from "./browser/bridge.js";
import { OpportunityService } from "./opportunity-service.js";
import { CollectionAdapterError } from "./analytics/collection.js";
import { AnalyticsService } from "./analytics/service.js";
import { AnalyticsOpportunityHandoff } from "./analytics/opportunity-handoff.js";
import { titleAgentInput } from "./text-agent-integration.js";
import { acceptanceBatchProgress } from "./acceptance-batch.js";
import { TextAgentTasks, createCodexLunaRunner } from "./text-agent.js";
import { executionSpeed } from "./execution-speed.js";
import { workbenchPrices } from "./workbench-prices.js";
import { preflightQueue } from "./preflight.js";
import { androidDevices, checkAndroidDevice } from "./android.js";
import { PricingTasks } from "./pricing-task.js";
import { MarketDetails } from "./market-details.js";
import { MarketScan, marketItems } from "./market-scan.js";
import { brandProgress } from "./brand-progress.js";
import { controlledWaveProgress } from "./controlled-wave.js";
import { JdTraffic } from "./jd-traffic.js";
import { discoveryWork, enqueueDiscovery } from "./discovery-work.js";
import { Discovery } from "./discovery.js";
import { BrandInventory, potentiallyActiveBrand } from "./brand-inventory.js";
import { Traffic, pacedAdapter } from "./traffic.js";
import { updateJobFacts, requiredFacts } from "./job-input.js";
import { createServer } from "node:http";
import { readFile, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { Store } from "./store.js";
import { Catalog } from "./catalog.js";
import { refreshTargetedAuthorization } from "./targeted-authorization.js";
import { Jobs } from "./jobs.js";
import { Worker } from "./worker.js";
import { ReleaseGuard } from "./release-version.js";
import { collectAndroid } from "./android.js";
import { Planner } from "./planner.js";
import { Engine } from "./engine.js";
import { EgoAdapter } from "./browser/bridge.js";
import { planSchema, productSchema, validate } from "./model.js";
import { remoteProductState } from "./remote-status.js";
import type { BrowserConfig } from "./browser/runtime.js";
const recipe = z.object({
  source: z.enum(["browser", "android"]).optional(),
  brandId: z.string().min(1),
  categoryId: z.string().min(1),
  policyId: z.string().min(1),
  unit: z.string().min(1),
  through: z.enum(["draft", "submit"]),
});

/** A read-only audit may describe a bound remote item after it was submitted. */
export function currentAuditStatus(
  remoteId: string | null | undefined,
  jobUpdatedAt: string,
  audit: unknown,
): { status: string; checkedAt: string } | null {
  if (!remoteId || !audit || typeof audit !== "object") return null;
  const record = audit as {
    checkedAt?: unknown;
    observation?: { itemId?: unknown; status?: unknown };
  };
  const checkedAt = record.checkedAt,
    observation = record.observation;
  if (
    typeof checkedAt !== "string" ||
    typeof observation?.status !== "string" ||
    !observation.status.trim() ||
    observation.itemId !== remoteId
  )
    return null;
  const observed = Date.parse(checkedAt),
    updated = Date.parse(jobUpdatedAt);
  if (
    !Number.isFinite(observed) ||
    !Number.isFinite(updated) ||
    observed < updated
  )
    return null;
  return { status: observation.status, checkedAt };
}

/** A page-level pause can be lifted only after the current managed HZ page is healthy. */
export async function resumeVerifiedPageRequests(
  bridge: { call(action: string, args: unknown): Promise<unknown> },
  config: BrowserConfig,
) {
  await bridge.call("check-hz", { config });
  return bridge.call("resume-requests", {
    config,
    reasonIds: ["http-403", "auth-redirect"],
  });
}

export async function serve(root: string, port = 4317) {
  const config: BrowserConfig = JSON.parse(
    await readFile(resolve(root, "config.json"), "utf8"),
  );
  config.requestMetricsPath = resolve(root, "request-traffic.json");
  config.sourceDatabasePath = resolve(root, "state.sqlite");
  const store = new Store(resolve(root, "state.sqlite"));
  new Traffic(store, config.shop);
  new Catalog(store);
  const brandInventory = new BrandInventory(store);
  const discovery = new Discovery(store);
  const market = new MarketScan(store);
  const marketDetails = new MarketDetails(store);
  const pricingTasks = new PricingTasks(store);
  new Planner(store);
  store.recoverLocks();
  const release = store.lock("workbench");
  const jobs = new Jobs(store, config.shop);
  jobs.recover();
  const textTasks = new TextAgentTasks(store);
  textTasks.recoverRunning();
  const runningRelease = await ReleaseGuard.create();
  const worker = new Worker(store, jobs, config, root, undefined, {
    collectAndroid,
    release: runningRelease,
    textAgentTasks: textTasks,
  });
  const workbenchJob = (j: ReturnType<typeof jobs.get>) => {
    const p = j.productId ? store.get(j.productId) : null;
    const audited = currentAuditStatus(
      p?.remoteId,
      j.updatedAt,
      p?.remoteId ? store.meta("audit:" + p.id) : null,
    );
    const observedRemoteState = audited?.status ?? p?.state;
    const remoteState = observedRemoteState
      ? (remoteProductState(observedRemoteState) ?? observedRemoteState)
      : undefined;
    const remoteReason =
      p?.state === "REJECTED" && p.error
        ? (() => {
            try {
              const detail = JSON.parse(p.error);
              return typeof detail?.message === "string"
                ? detail.message
                : null;
            } catch {
              return p.error;
            }
          })()
        : null;
    return {
      ...j,
      title: p?.plan?.displayTitle?.value ?? p?.product?.title.value,
      specification: p?.product?.specs["京东销售规格"]?.value,
      priceComparison: workbenchPrices(store, p),
      remoteId: p?.remoteId,
      remoteState,
      remoteStatus: audited?.status ?? null,
      remoteReason,
      remoteObservedAt: audited?.checkedAt ?? null,
      platformWarning: p?.remoteId
        ? store.meta("platform-warning:" + p.remoteId)
        : null,
    };
  };
  const analytics = new AnalyticsService(root, config.shop, store, () =>
    jobs.list().map(workbenchJob),
  );
  await analytics.initialize();
  const opportunityExecution = new OpportunityService(
    store,
    jobs,
    root,
    config.shop,
  );
  await opportunityExecution.initialize();
  analytics.connectOpportunityHandoff(
    new AnalyticsOpportunityHandoff(
      analytics.store,
      opportunityExecution.ledger,
      config.shop,
      () => opportunityExecution.read(),
    ),
  );
  const analyticsBridge = new EgoBridge("ego-browser", 45000);
  analytics.connectCollector(
    {
      readPage: async (request) => {
        let session: BrowserConfig["session"];
        try {
          session = JSON.parse(
            await readFile(resolve(root, "analytics-session.json"), "utf8"),
          );
        } catch {
          throw new CollectionAdapterError(
            "unavailable",
            "尚未绑定市场采集浏览器",
          );
        }
        try {
          return await analyticsBridge.call("analytics-shop-page", {
            config: { ...config, session },
            shopId: request.shopId,
            page: request.page,
            pageSize: request.limit,
          });
        } catch (e: any) {
          throw new CollectionAdapterError(
            e.code === "CONTROL_REQUIRED"
              ? "user_control"
              : e.code === "AUTH_REQUIRED"
                ? "auth"
                : e.code === "RATE_LIMITED"
                  ? "rate_limit"
                  : e.code === "UNKNOWN_OUTCOME"
                    ? "timeout"
                    : "unavailable",
            e.message,
          );
        }
      },
    },
    {
      acquire: async () => {
        if (
          worker.busy ||
          worker.stopping ||
          store.meta("pause:all") ||
          store.meta("pause:" + config.shop)
        )
          return null;
        const unlock = store.lock("publisher");
        worker.busy = true;
        return {
          release: () => {
            worker.busy = false;
            unlock();
          },
        };
      },
    },
  );

  const token = randomBytes(32).toString("hex");
  const server = createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; img-src 'self' https:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'",
    );
    const send = (status: number, data: unknown) => {
      res.writeHead(status, {
        "content-type": "application/json; charset=utf-8",
      });
      res.end(JSON.stringify(data));
    };
    try {
      const host = `127.0.0.1:${(server.address() as any)?.port}`;
      if (req.headers.host !== host)
        return send(403, { error: "仅允许本机工作台地址" });
      const url = new URL(req.url ?? "/", `http://${host}`);
      if (req.headers.origin && req.headers.origin !== url.origin)
        return send(403, { error: "来源不匹配" });
      if (
        req.method === "GET" &&
        [
          "/",
          "/app.js",
          "/style.css",
          "/analytics",
          "/analytics.html",
          "/analytics.js",
          "/analytics.css",
          "/opportunity-execution",
          "/opportunity-execution.html",
          "/opportunity-execution.js",
          "/opportunity-execution.css",
        ].includes(url.pathname)
      ) {
        const filename =
          url.pathname === "/"
            ? "index.html"
            : url.pathname === "/analytics"
              ? "analytics.html"
              : url.pathname === "/opportunity-execution"
                ? "opportunity-execution.html"
                : url.pathname.slice(1);
        res.writeHead(200, {
          "content-type": filename.endsWith(".html")
            ? "text/html; charset=utf-8"
            : filename.endsWith(".js")
              ? "text/javascript; charset=utf-8"
              : "text/css; charset=utf-8",
        });
        res.end(await readFile(new URL("../web/" + filename, import.meta.url)));
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/health")
        return send(200, { ready: true, releaseId: runningRelease.releaseId });
      if (req.method === "GET" && url.pathname === "/api/analytics/session")
        return send(200, { token, shop: config.shop });
      if (req.method === "GET" && url.pathname === "/api/opportunity-execution")
        return send(
          200,
          opportunityExecution.read(
            url.searchParams.get("cohortId") ?? undefined,
          ),
        );
      if (req.method === "GET" && url.pathname.startsWith("/api/analytics/")) {
        const result = analytics.read(url.pathname.slice(15), url.searchParams);
        return send(
          result === undefined ? 404 : 200,
          result ?? { error: "分析接口不存在" },
        );
      }
      if (req.method === "GET" && url.pathname === "/api/state") {
        return send(200, {
          token,
          releaseId: runningRelease.releaseId,
          listingPrice:
            store.meta("listing-price:" + config.shop) ?? "jd-source",
          shop: config.shop,
          paused:
            store.meta("pause:all") ||
            store.meta("pause:" + config.shop) ||
            store.meta("pause:jd-account:" + config.shop) ||
            store.meta("pause:jd:" + config.shop),
          jdPaused:
            store.meta("pause:jd-account:" + config.shop) ||
            store.meta("pause:jd:" + config.shop),
          hzPaused: store.meta("pause:hz:" + config.shop),
          android: {
            serial: store.meta("android-serial"),
            last: store.meta("android-last:" + config.shop),
            progress: store.meta("android-progress:" + config.shop),
            paused: store.meta("pause:jd-android:" + config.shop),
          },
          busy: worker.busy,
          preflight: store.meta("preflight:" + config.shop),
          sourceIndex: store.meta("source-index-progress"),
          discovery: discovery.list(config.shop),
          brandSync: brandProgress(store, config.shop),
          controlledWave:
            acceptanceBatchProgress(store, config.shop) ??
            controlledWaveProgress(store, config.shop),
          pricingTasks: pricingTasks.list(config.shop),
          marketScans: market.list(config.shop).map((r) => {
            const rows = marketItems(market.pages(r.id));
            const freshDetails = rows.filter((row) => {
              const d = marketDetails.fresh(config.shop, row.itemId);
              return (
                d &&
                d.shopId === row.shopId &&
                row.skus.every((s) => d.skus.some((x) => x.id === s.skuId))
              );
            }).length;
            return {
              ...r,
              freshDetails,
              pendingDetails: rows.length - freshDetails,
            };
          }),
          brandInventory: (() => {
            const progress = brandInventory.latest(config.shop);
            return progress
              ? {
                  progress,
                  activation: store.meta(
                    "brand-inventory-activation:" + config.shop,
                  ),
                  rows: brandInventory.rows(progress.id).map((r) => {
                    const d = r.detail ?? r.list;
                    return {
                      brandId: r.brand_id,
                      grantId: r.grant_id,
                      name: d.brandName,
                      platformStatus: d.supplierBrandStatus,
                      potentiallyActive: potentiallyActiveBrand(d),
                      validFrom: d.validTimeBegin,
                      validUntil:
                        d.validStatus === 1 ? "长期有效" : d.validTimeEnd,
                      detailChecked: !!r.detail,
                      checkedAt: r.checked_at,
                      inactiveCategories:
                        r.detail?.supplierBrandCatVos
                          ?.filter((c: any) => c.status !== 1)
                          .map((c: any) => c.brandCatInfo) ?? [],
                      categories:
                        r.detail?.supplierBrandCatVos
                          ?.filter((c: any) => c.status === 1)
                          .map((c: any) => c.brandCatInfo) ?? [],
                    };
                  }),
                }
              : null;
          })(),
          traffic: {
            jd: new JdTraffic(store, config.shop).state(),
            requestsPerSecond: 3,
            maxConcurrent: 1,
            lastObservation: await readFile(config.requestMetricsPath!, "utf8")
              .then(JSON.parse)
              .catch((e) => {
                if (e.code === "ENOENT") return null;
                throw e;
              }),
            used: Number(
              store.db
                .prepare(
                  "SELECT COUNT(*) AS n FROM traffic_log WHERE started_at>?",
                )
                .get(Date.now() - 3600000)?.n,
            ),
            scope: "managed-hezi-page-fetch-xhr",
            usedScope: "controlled-operations-last-hour",
          },
          jobs: jobs.list().map(workbenchJob),
          brands: store.db
            .prepare(
              "SELECT DISTINCT b.id,b.name FROM catalog_brands b JOIN catalog_grants g ON g.shop=b.shop AND g.brand_id=b.id WHERE b.shop=? AND g.status='approved' ORDER BY b.name",
            )
            .all(config.shop),
          categories: store.db
            .prepare(
              "SELECT c.id,c.path FROM catalog_categories c JOIN category_templates t ON t.shop=c.shop AND t.category_id=c.id WHERE c.shop=?",
            )
            .all(config.shop),
          policies: store.db
            .prepare("SELECT id FROM shop_policies WHERE shop=?")
            .all(config.shop),
        });
      }
      const image = url.pathname.match(/^\/api\/assets\/([a-f0-9-]+)\/(\d+)$/);
      if (req.method === "GET" && image) {
        const j = jobs.get(image[1]);
        const a = j.productId
          ? store.get(j.productId).product?.assets[Number(image[2])]
          : null;
        if (!a?.path) return send(404, { error: "图片尚未下载" });
        const base = await realpath(resolve(root, "assets")),
          path = await realpath(a.path);
        if (!path.startsWith(base + "/"))
          return send(403, { error: "图片不属于本地素材库" });
        res.writeHead(200, { "content-type": "image/jpeg" });
        res.end(await readFile(path));
        return;
      }
      const discoveryMatch = url.pathname.match(
        /^\/api\/discovery\/([a-f0-9-]+)\/work$/,
      );
      if (req.method === "GET" && discoveryMatch)
        return send(200, discoveryWork(store, config.shop, discoveryMatch[1]));
      const match = url.pathname.match(
        /^\/api\/jobs\/([a-f0-9-]+)(?:\/(retry|reconcile|cancel|data|facts|source))?$/,
      );
      if (req.method === "GET" && match) {
        const j = jobs.get(match[1]);
        return send(200, {
          job: workbenchJob(j),
          events: jobs.events(j.id),
          executionSpeed: executionSpeed(store, j.productId),
          row: j.productId ? store.get(j.productId) : null,
          priceComparison: workbenchPrices(
            store,
            j.productId ? store.get(j.productId) : null,
          ),
          requiredFacts: requiredFacts(jobs, j.id),
          agentTasks: textTasks.list({ jobId: j.id }),
          workflowTiming: {
            startedAt: j.createdAt,
            elapsedMs: Math.max(
              0,
              Date.parse(
                j.status === "DONE" ? j.updatedAt : new Date().toISOString(),
              ) - Date.parse(j.createdAt),
            ),
            complete: j.status === "DONE",
            agentCalls: textTasks
              .list({ jobId: j.id })
              .reduce((n, t) => n + t.attempts, 0),
            agentMs: textTasks
              .list({ jobId: j.id })
              .reduce((n, t) => n + (t.durationMs ?? 0), 0),
            cached: textTasks
              .list({ jobId: j.id })
              .filter((t) => t.status === "cached").length,
          },
        });
      }
      if (req.method !== "POST") return send(404, { error: "接口不存在" });
      if (req.headers["x-hezi-token"] !== token)
        return send(403, { error: "请刷新工作台后重试" });
      let body = "";
      for await (const chunk of req) {
        body += chunk;
        if (Buffer.byteLength(body) > 1_000_000) {
          send(413, { error: "请求过大" });
          return;
        }
      }
      const data = JSON.parse(body || "{}");
      if (url.pathname === "/api/opportunity-execution/authorization") {
        if (worker.busy || worker.stopping)
          return send(409, { error: "当前执行步骤未结束，请稍后重试" });
        await runningRelease.assertCurrent();
        const row = opportunityExecution.ledger.row(
          z.string().min(1).parse(data.rowId),
        );
        if (row.shop !== config.shop || row.jobId)
          throw Error("仅可刷新本店尚未进入任务的机会授权");
        const source = opportunityExecution.ledger
          .evidence(row.id)
          .filter((entry) => entry.kind === "source-match")
          .at(-1)?.payload;
        if (!source?.brandId || !source?.categoryId)
          throw Error("缺少已经核对的供应商品牌与发布类目");
        worker.busy = true;
        try {
          const result = await refreshTargetedAuthorization(
            store,
            config,
            {
              brandId: String(source.brandId),
              categoryId: String(source.categoryId),
            },
            worker.bridge,
          );
          opportunityExecution.recheck({ cohortId: row.cohortKey });
          return send(200, result);
        } finally {
          worker.busy = false;
        }
      }
      if (
        [
          "/api/opportunity-execution/candidates",
          "/api/opportunity-execution/candidate-source",
        ].includes(url.pathname)
      ) {
        if (worker.busy || worker.stopping)
          return send(409, { error: "当前执行步骤未结束，请稍后重试" });
        await runningRelease.assertCurrent();
        worker.busy = true;
        try {
          const result = url.pathname.endsWith("/candidates")
            ? await opportunityExecution.discoverCandidates(
                data,
                config,
                worker.bridge,
              )
            : await opportunityExecution.collectCandidate(
                data,
                config,
                worker.bridge,
              );
          return send(200, result);
        } finally {
          worker.busy = false;
        }
      }
      if (url.pathname === "/api/opportunity-execution/recheck")
        return send(200, opportunityExecution.recheck(data));
      if (url.pathname === "/api/opportunity-execution/source") {
        if (worker.busy || worker.stopping)
          return send(409, { error: "当前执行步骤未结束，请稍后重试" });
        worker.busy = true;
        try {
          return send(
            200,
            await opportunityExecution.collectSource(
              data,
              config,
              worker.bridge,
            ),
          );
        } finally {
          worker.busy = false;
        }
      }
      if (url.pathname === "/api/opportunity-execution/hydrate") {
        if (worker.busy || worker.stopping)
          return send(409, { error: "当前执行步骤未结束，请稍后重试" });
        worker.busy = true;
        try {
          return send(
            200,
            await opportunityExecution.hydrate(data, config, worker.bridge),
          );
        } finally {
          worker.busy = false;
        }
      }
      if (url.pathname === "/api/opportunity-execution/prepare") {
        if (worker.busy || worker.stopping)
          return send(409, { error: "当前执行步骤未结束，请稍后重试" });
        const unlock = store.lock("publisher");
        try {
          return send(201, opportunityExecution.prepare(data));
        } finally {
          unlock();
        }
      }
      if (url.pathname.startsWith("/api/analytics/")) {
        const result = await analytics.write(url.pathname.slice(15), data);
        return send(
          result === undefined ? 404 : 200,
          result ?? { error: "分析接口不存在" },
        );
      }
      if (url.pathname === "/api/preflight") {
        if (worker.busy)
          return send(409, { error: "当前任务尚未结束，请稍后检查" });
        const selection = z
          .object({ jobIds: z.array(z.string().uuid()).max(200).optional() })
          .parse(data);
        const inputs =
          selection.jobIds?.map((id) => jobs.get(id)) ??
          jobs
            .list()
            .filter((j) =>
              ["QUEUED", "NEEDS_INPUT", "UNKNOWN_OUTCOME"].includes(j.status),
            );
        worker.busy = true;
        try {
          const local = preflightQueue(store, jobs, inputs);
          const platform: any[] = [];
          const seen = new Set<string>();
          for (const item of local.items.filter((x) => x.ready)) {
            const row = store.get(item.productId!);
            const key =
              row.plan!.catalogBinding!.categoryId +
              ":" +
              Object.keys(row.plan!.specs).sort().join(",");
            if (seen.has(key)) continue;
            seen.add(key);
            try {
              await worker.platformPreflight(row.plan!);
              platform.push({
                categoryId: row.plan!.catalogBinding!.categoryId,
                ready: true,
              });
            } catch (e: any) {
              platform.push({
                categoryId: row.plan!.catalogBinding!.categoryId,
                ready: false,
                message: e.message,
                details: e.details,
              });
              break;
            }
          }
          const report = {
            ...local,
            platform,
            ready: local.ready && platform.every((x) => x.ready),
            checkedAt: new Date().toISOString(),
          };
          store.setMeta("preflight:" + config.shop, report);
          return send(200, report);
        } finally {
          worker.busy = false;
        }
      }
      if (url.pathname === "/api/android/resume") {
        if (worker.busy) return send(409, { error: "当前任务尚未结束" });
        const unlock = store.lock("publisher");
        try {
          await checkAndroidDevice(String(store.meta("android-serial") ?? ""));
          new JdTraffic(
            store,
            config.shop,
            undefined,
            "android",
          ).resumeAccountChannel();
          store.resume("jd-android:" + config.shop);
          return send(200, { ready: true });
        } finally {
          unlock();
        }
      }
      if (url.pathname === "/api/android/devices")
        return send(200, { devices: await androidDevices() });
      if (url.pathname === "/api/android/select") {
        const input = z.object({ serial: z.string().min(1) }).parse(data);
        if (
          !(await androidDevices()).some(
            (d) => d.serial === input.serial && d.status === "device",
          )
        )
          return send(400, { error: "手机未连接或未授权" });
        store.setMeta("android-serial", input.serial);
        return send(200, { selected: input.serial });
      }
      const assignMatch = url.pathname.match(
        /^\/api\/discovery\/([a-f0-9-]+)\/enqueue$/,
      );
      if (assignMatch) {
        const input = z
          .object({ skus: z.array(z.string()).min(1).max(200), recipe })
          .parse(data);
        return send(
          201,
          enqueueDiscovery(
            store,
            config.shop,
            assignMatch[1],
            input.skus,
            input.recipe,
          ),
        );
      }
      if (url.pathname === "/api/batches") {
        const input = z
          .object({ links: z.array(z.string()).min(1).max(200), recipe })
          .parse(data);
        return send(201, jobs.enqueue(input.links, input.recipe));
      }
      if (url.pathname === "/api/pause") {
        store.pause(config.shop, "工作台暂停，当前安全步骤完成后停止");
        return send(200, { ok: true });
      }
      if (url.pathname === "/api/resume") {
        if (worker.busy)
          return send(409, { error: "当前步骤尚未结束，请稍后恢复" });
        const unlock = store.lock("publisher");
        try {
          if (
            store.meta("pause:jd-account:" + config.shop) ||
            store.meta("pause:jd:" + config.shop)
          )
            await worker.bridge.call("check-jd", { config });
          await resumeVerifiedPageRequests(worker.bridge, config);
          store.resume("jd:" + config.shop);
          new JdTraffic(store, config.shop).resumeAccountChannel();
          store.resume(config.shop);
          store.resume("all");
        } finally {
          unlock();
        }
        return send(200, { ok: true });
      }
      if (match) {
        const j = jobs.get(match[1]);
        if (match[2] === "source")
          return send(
            200,
            jobs.source(
              j.id,
              z.object({ source: z.enum(["browser", "android"]) }).parse(data)
                .source,
            ),
          );
        if (match[2] === "facts")
          return send(200, updateJobFacts(jobs, j.id, data));
        if (match[2] === "retry") {
          if (
            j.stage === "agent-title" &&
            j.productId &&
            ["NEEDS_INPUT", "CANCELLED"].includes(j.status)
          ) {
            const product = store.get(j.productId).product;
            if (product) {
              const task = textTasks.enqueue(
                titleAgentInput(j, config.shop, product),
                {
                  taskType: "normalize_title",
                  version: "title-v1",
                  model: "gpt-5.6-luna",
                },
              );
              if (task.status === "failed") textTasks.retry(task.id);
            }
          }
          jobs.retry(j.id);
          return send(200, { ok: true });
        }
        if (match[2] === "cancel") {
          if (j.status === "RUNNING")
            return send(409, {
              error: "执行中请先暂停队列，不能中断正在保存的商品",
            });
          jobs.update(j.id, "CANCELLED", j.stage);
          return send(200, { ok: true });
        }
        if (match[2] === "data") {
          if (
            j.status === "RUNNING" ||
            j.status === "DONE" ||
            j.status === "UNKNOWN_OUTCOME" ||
            !j.productId
          )
            return send(409, { error: "当前状态不可修改" });
          const p = productSchema.parse(data.product),
            plan = planSchema.parse(data.plan);
          if (p.sku !== j.sku || plan.shop !== config.shop)
            return send(400, { error: "身份不匹配" });
          new Catalog(store).authorize(plan);
          store.put(config.shop, p);
          store.setPlan(j.productId, plan);
          jobs.event(j.id, "manual", "data-updated", null, {
            actor: "operator",
          });
          return send(200, { ok: true });
        }
        if (match[2] === "reconcile") {
          if (worker.busy || !j.productId)
            return send(409, { error: "请等待当前任务结束" });
          worker.busy = true;
          try {
            const r = await new Engine(
              store,
              pacedAdapter(
                store,
                config.shop,
                new EgoAdapter(worker.bridge, config),
              ),
            ).reconcile(j.productId);
            const errors =
              r.product && r.plan
                ? validate(r.product, r.plan)
                : ["缺少商品资料"];
            jobs.update(
              j.id,
              !errors.length &&
                r.verifiedHash === r.dataHash &&
                ["SUBMITTED", "APPROVED", "ON_SALE"].includes(r.state)
                ? "DONE"
                : "NEEDS_INPUT",
              "reconcile",
              errors.length ? errors.join("；") : r.error,
            );
            return send(200, { state: r.state });
          } finally {
            worker.busy = false;
          }
        }
      }
      send(404, { error: "接口不存在" });
    } catch (e) {
      send(400, { error: e instanceof Error ? e.message : String(e) });
    }
  });
  let analyticsBusy = false;
  const analyticsInterval = setInterval(() => {
    if (analyticsBusy || worker.busy || worker.stopping) return;
    analyticsBusy = true;
    void analytics.collection
      .tick()
      .catch((e) => console.error("分析采集：", String(e)))
      .finally(() => {
        analyticsBusy = false;
      });
  }, 15000);
  let agentBusy = false;
  const textRunner = config.textAgent?.enabled
    ? createCodexLunaRunner({
        codexPath: config.textAgent.codexPath,
        timeoutMs: config.textAgent.timeoutMs ?? 90000,
      })
    : null;
  const agentInterval = setInterval(() => {
    if (
      !textRunner ||
      agentBusy ||
      worker.stopping ||
      store.meta("pause:" + config.shop) ||
      store.meta("pause:all")
    )
      return;
    agentBusy = true;
    void (async () => {
      await runningRelease.assertCurrent();
      const completed = await textTasks.runOne(textRunner);
      if (!completed) return;
      const j = jobs.get(completed.jobId);
      jobs.event(j.id, "agent-title", completed.status, completed.durationMs, {
        taskId: completed.id,
        model: completed.model,
        error: completed.error,
      });
      if (j.status === "NEEDS_INPUT" && j.stage === "agent-title") {
        if (["complete", "cached"].includes(completed.status))
          jobs.update(j.id, "QUEUED", "queued", null);
        else jobs.update(j.id, "NEEDS_INPUT", "agent-title", completed.error);
      }
    })()
      .catch((e) => console.error("文本任务执行器：", String(e)))
      .finally(() => {
        agentBusy = false;
      });
  }, 1000);
  const interval = setInterval(
    () =>
      void worker.tick().catch((e) => {
        store.pause(config.shop, { message: String(e) });
        console.error(String(e));
      }),
    1000,
  );
  await new Promise<void>((ok, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", ok);
  });
  const stop = async () => {
    worker.stopping = true;
    clearInterval(interval);
    clearInterval(agentInterval);
    clearInterval(analyticsInterval);
    await new Promise<void>((ok) => server.close(() => ok()));
    while (worker.busy || agentBusy || analyticsBusy)
      await new Promise((ok) => setTimeout(ok, 100));
    release();
    analytics.close();
    store.close();
  };
  return {
    server,
    stop,
    url: `http://127.0.0.1:${(server.address() as any).port}`,
  };
}
if (
  process.argv[1] &&
  import.meta.url === new URL("file://" + process.argv[1]).href
) {
  const app = await serve(
    resolve(process.env.HEZI_DIR ?? ".hezi"),
    Number(process.env.HEZI_PORT ?? 4317),
  );
  console.log("赫兹工作台 " + app.url);
  for (const signal of ["SIGTERM", "SIGINT"] as const)
    process.once(signal, () => void app.stop().then(() => process.exit(0)));
}
