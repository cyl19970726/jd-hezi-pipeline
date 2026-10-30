import { TextAgentTasks } from "./text-agent.js";
import { brandEquivalent } from "./brand-identity.js";
import { requestTitle } from "./text-agent-integration.js";
import { listingTitle } from "./listing-title.js";
import { assertHzRunning } from "./platform-availability.js";
import { listingPrice } from "./listing-price.js";
import { CompetitivePricing } from "./competitive-pricing.js";
import { collectionNeed, mergeFreshPrice } from "./collection-needs.js";
import { Preparation, preparationRequirements } from "./preparation.js";
import {
  TargetedCaptures,
  targetedPlan,
  mergeProductPatch,
  productPatchSchema,
  fieldRegion,
} from "./targeted-collection.js";
import type { ReleaseGuard } from "./release-version.js";
import { jdAssetPolicy } from "./jd-asset-policy.js";
import { androidMissing } from "./android-structure.js";
import { collectAndroid } from "./android.js";
import { pacedAdapter, Traffic } from "./traffic.js";
import { replaceLegacy } from "./replacement.js";
import { SourceIndex } from "./source-index.js";
import { resolve } from "node:path";
import { Jobs, type Job } from "./jobs.js";
import { Store } from "./store.js";
import { Catalog } from "./catalog.js";
import { Planner } from "./planner.js";
import { Engine } from "./engine.js";
import { EgoAdapter, EgoBridge } from "./browser/bridge.js";
import type { BrowserConfig } from "./browser/runtime.js";
import { identity, productSchema, validate, PipelineError } from "./model.js";
import { downloadAssets, verifyLocalAssets } from "./assets.js";
import {
  collectionGateIssues,
  preflightJob,
  preflightMessage,
} from "./preflight.js";
import { JdCaptureStore, JD_CAPTURE_PARSER } from "./jd-capture.js";
import {
  bindCanonicalBrowserSource,
  canonicalSourceBinding,
  requireCollectedSku,
  unsupportedMediaFallback,
} from "./jd-source-fallback.js";

type WorkerSources = {
  collectAndroid: typeof collectAndroid;
  downloadAssets?: typeof downloadAssets;
  release?: ReleaseGuard;
  textAgentTasks?: TextAgentTasks;
};
export class Worker {
  busy = false;
  stopping = false;
  private platformPreflightCache = new Map<string, number>();
  constructor(
    readonly store: Store,
    readonly jobs: Jobs,
    readonly config: BrowserConfig,
    readonly root: string,
    readonly bridge = new EgoBridge(),
    readonly sources: WorkerSources = { collectAndroid },
  ) {}
  async platformPreflight(plan: NonNullable<ReturnType<Store["get"]>["plan"]>) {
    assertHzRunning(this.store, this.config.shop);
    const categoryId = plan.catalogBinding?.categoryId;
    if (!categoryId)
      throw new PipelineError(
        "VALIDATION_MISSING",
        "计划缺少类目 ID，无法执行平台适配预检",
      );
    const templateRow = this.store.db
      .prepare(
        "SELECT template,checked_at FROM category_templates WHERE shop=? AND category_id=?",
      )
      .get(this.config.shop, categoryId);
    if (!templateRow)
      throw new PipelineError(
        "VALIDATION_MISSING",
        "类目模板缺失，无法执行平台适配预检",
      );
    const template = JSON.parse(String(templateRow.template));
    const usedSpecs = Object.keys(plan.specs).sort();
    const packingName = plan.fields.packingName?.value;
    if (!packingName)
      throw new PipelineError(
        "VALIDATION_MISSING",
        "计划缺少包装名称，无法执行平台适配预检",
      );
    const key = JSON.stringify({
      config: this.config,
      categoryId,
      checkedAt: String(templateRow.checked_at),
      template,
      usedSpecs,
      packingName,
    });
    const cachedAt = this.platformPreflightCache.get(key);
    if (cachedAt && Date.now() - cachedAt < 5 * 60000) return;
    this.platformPreflightCache.delete(key);
    const representative = this.store
      .list()
      .find(
        (row) =>
          row.shop === this.config.shop &&
          row.remoteId &&
          row.plan?.catalogBinding?.categoryId === categoryId,
      );
    const unlock = this.store.lock("publisher");
    try {
      const result = await new Traffic(this.store, this.config.shop).run(
        "preflight",
        () =>
          this.bridge.call("preflight", {
            config: this.config,
            categories: [
              {
                categoryId,
                categoryPath: plan.categoryPath,
                template: {
                  fields: template.fields,
                  specs: template.specs,
                  usedSpecs,
                },
                packingName,
                ...(representative?.remoteId
                  ? { itemId: representative.remoteId }
                  : {}),
              },
            ],
          }),
      );
      if (
        !result ||
        result.ready !== true ||
        typeof result.checkedAt !== "string" ||
        !result.modules ||
        typeof result.modules.entry !== "string" ||
        typeof result.modules.logistics !== "string" ||
        !Array.isArray(result.categories)
      )
        throw new PipelineError("UI_CHANGED", "平台预检返回结构无效");
      this.platformPreflightCache.set(key, Date.now());
      this.store.setMeta("preflight-platform:" + this.config.shop, result);
    } catch (error) {
      this.platformPreflightCache.delete(key);
      this.store.setMeta("preflight-platform:" + this.config.shop, {
        ready: false,
        checkedAt: new Date().toISOString(),
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      unlock();
    }
  }
  async tick() {
    if (
      this.busy ||
      this.stopping ||
      this.store.meta("pause:all") ||
      this.store.meta("pause:" + this.config.shop) ||
      this.store.meta("pause:jd-account:" + this.config.shop)
    )
      return;
    this.busy = true;
    try {
      try {
        await this.sources.release?.assertCurrent();
      } catch (error) {
        if (!(error instanceof PipelineError) || error.code !== "PAUSED")
          throw error;
        this.store.pause(
          this.config.shop,
          { code: "RELEASE_CHANGED", message: String(error) },
          "release:changed",
        );
        return;
      }
      const job = this.jobs.claim(
        (j) =>
          !this.store.meta("pause:jd-account:" + this.config.shop) &&
          !this.store.meta(
            (j.recipe.source === "android"
              ? "pause:jd-android:"
              : "pause:jd:") + this.config.shop,
          ),
      );
      if (job) await this.run(job);
    } finally {
      this.busy = false;
    }
  }
  async run(job: Job) {
    const stage = <T>(name: string, fn: () => Promise<T>) =>
      this.jobs.stage(job.id, name, async () => {
        await this.sources.release?.assertCurrent();
        return fn();
      });
    const requestedSource: "android" | "browser" =
      job.recipe.source === "android" ? "android" : "browser";
    let effectiveSource = requestedSource;
    try {
      await this.sources.release?.assertCurrent();
      this.jobs.event(job.id, "release", "release-start", null, {
        releaseId: this.sources.release?.releaseId ?? null,
      });
      const id = identity(this.config.shop, job.sku);
      let row = this.store.list().find((r) => r.id === id);
      const sourceBindingKey = `jd-product-source:${this.config.shop}:${job.sku}`;
      if (
        requestedSource === "android" &&
        row?.product &&
        canonicalSourceBinding(this.store.meta(sourceBindingKey), {
          sku: row.product.sku,
          url: row.product.url,
          dataHash: row.dataHash,
        })
      )
        effectiveSource = "browser";
      const capture = new JdCaptureStore(this.store);
      const captureContext = (source: "android" | "browser") =>
        ({
          shop: this.config.shop,
          sku: job.sku,
          source,
          parserVersion: JD_CAPTURE_PARSER,
          accountContext: String(
            this.store.meta("jd-context:" + this.config.shop)?.account ?? "",
          ),
          regionContext: String(
            this.store.meta("jd-context:" + this.config.shop)?.region ?? "",
          ),
        }) as const;
      let context = captureContext(effectiveSource);
      const rememberEffectiveSource = (saved: NonNullable<typeof row>) => {
        if (requestedSource === "android" && effectiveSource === "browser")
          this.store.setMeta(
            sourceBindingKey,
            bindCanonicalBrowserSource({
              sku: saved.product!.sku,
              url: saved.product!.url,
              dataHash: saved.dataHash,
            }),
          );
      };
      const canCollect =
        !row || (!row.remoteId && !row.plan && !this.store.pending(row.id));
      let need = collectionNeed(
        row?.product ?? null,
        effectiveSource,
        Date.now(),
        {
          previouslyObserved:
            !!row?.product && capture.observedProduct(context, row.product),
        },
      );
      // Stored facts are reusable, but an unknown/different account or region is
      // not permission to reuse its quote, even when captured seconds ago.
      if (
        row?.product &&
        need === "none" &&
        !capture.price(context, {}, row.product.price)
      )
        need = "price";
      const canRefreshPrice =
        !row?.remoteId &&
        !this.store.pending(id) &&
        need !== "local" &&
        need !== "none" &&
        Boolean(row?.product) &&
        (effectiveSource !== "android" ||
          androidMissing(row!.product!).every(
            (entry) => entry === "明确补贴价或京东价",
          ));
      if ((canCollect && need === "full") || canRefreshPrice) {
        const gateIssues = collectionGateIssues(
          preflightJob(this.store, this.jobs, {
            ...job,
            productId: row?.id ?? null,
          }),
        );
        if (gateIssues.length)
          throw new PipelineError(
            gateIssues.some((entry) => entry.code === "PENDING_OPERATION")
              ? "UNKNOWN_OUTCOME"
              : "VALIDATION_MISSING",
            gateIssues.map((entry) => entry.message).join("；"),
            gateIssues.map((entry) => entry.message),
          );
      }
      if (canCollect && need === "full") {
        const p = await stage("collect", async () => {
          const unlock = this.store.lock("publisher");
          try {
            let collected: unknown;
            if (requestedSource === "android") {
              try {
                collected = await this.sources.collectAndroid(
                  this.store,
                  this.config.shop,
                  this.root,
                  String(this.store.meta("android-serial") ?? ""),
                  job.sku,
                );
              } catch (error) {
                const unsupported = unsupportedMediaFallback(error, {
                  sku: job.sku,
                  parserVersion: JD_CAPTURE_PARSER,
                });
                if (!unsupported) throw error;
                capture.metric(captureContext("android"), {
                  stage: "collect",
                  reason: "unsupported-media",
                });
                this.jobs.event(job.id, "collect", "source-fallback", null, {
                  requestedSource,
                  effectiveSource: "browser",
                  ...unsupported,
                });
                this.store.setMeta(
                  `jd-source-outcome:${this.config.shop}:${job.sku}:android`,
                  {
                    outcome: "unsupported-media",
                    ...unsupported,
                  },
                );
                // A capability fallback remains subject to every shared and
                // browser-channel pause; it must never become a risk bypass.
                this.store.assertRunning(this.config.shop);
                this.store.assertRunning("jd-account:" + this.config.shop);
                this.store.assertRunning("jd:" + this.config.shop);
                effectiveSource = "browser";
                context = captureContext(effectiveSource);
                collected = await this.bridge.call("collect", {
                  config: this.config,
                  url: `https://item.jd.com/${job.sku}.html`,
                });
              }
            } else {
              collected = await this.bridge.call("collect", {
                config: this.config,
                url: `https://item.jd.com/${job.sku}.html`,
              });
            }
            const metrics = (collected as any).captureMetrics;
            capture.metric(context, {
              stage: "collect",
              reason:
                requestedSource !== effectiveSource
                  ? "unsupported-media-fallback"
                  : metrics?.samePageReused
                    ? "validated-same-page"
                    : "source-collection",
              navigations: metrics?.navigations,
              observableRequests: metrics?.observableRequests,
            });
            return requireCollectedSku(productSchema.parse(collected), job.sku);
          } finally {
            unlock();
          }
        });
        capture.saveProduct(context, p, "facts");
        capture.observePage(context, p.url, p.sku, p.capturedAt);
        row = this.store.put(this.config.shop, p);
        rememberEffectiveSource(row);
      } else if (canRefreshPrice && row?.product) {
        // No verified account/region producer exists yet: observe a fresh quote for
        // stored inputs instead of treating a timestamp as permission to reuse it.
        const existing = row.product;
        const refreshed = await stage("price", async () => {
          const unlock = this.store.lock("publisher");
          try {
            const raw =
              effectiveSource === "android"
                ? await this.sources.collectAndroid(
                    this.store,
                    this.config.shop,
                    this.root,
                    String(this.store.meta("android-serial") ?? ""),
                    job.sku,
                    { priceOnly: true },
                  )
                : await this.bridge.call("refresh-price", {
                    config: this.config,
                    url: existing.url,
                  });
            const quote = productSchema.parse(raw);
            return {
              quote,
              product: mergeFreshPrice(existing, quote),
              metrics: (raw as any).captureMetrics,
            };
          } finally {
            unlock();
          }
        });
        this.store.tx(() => {
          capture.metric(context, {
            stage: "price",
            reason: "fresh-quote-only",
            navigations: refreshed.metrics?.navigations,
            observableRequests: refreshed.metrics?.observableRequests,
          });
          capture.saveProduct(context, refreshed.product, "price");
          if (row!.plan?.competitivePricingReviewId) {
            const rebuilt = new CompetitivePricing(
              this.store,
            ).refreshUnpublishedSamePrice(
              this.config.shop,
              existing,
              refreshed.product,
              refreshed.quote,
              row!.plan!,
            );
            row = this.store.put(this.config.shop, refreshed.product);
            row = this.store.setPlan(id, { ...row.plan!, ...rebuilt });
          } else {
            row = this.store.put(this.config.shop, refreshed.product);
            if (row.plan)
              row = this.store.setPlan(id, {
                ...row.plan,
                ...listingPrice(
                  this.store,
                  this.config.shop,
                  refreshed.product,
                ),
              });
          }
        });
        rememberEffectiveSource(row);
      }
      if (!row) throw new PipelineError("NEEDS_INPUT", "缺商品来源记录");
      this.jobs.update(job.id, "RUNNING", "facts", null, id);
      if (
        row.product &&
        !row.plan &&
        !row.remoteId &&
        !this.store.pending(id) &&
        !["SUBMITTED", "APPROVED", "ON_SALE"].includes(row.state)
      ) {
        let prepared = await stage("normalize", async () =>
          new Preparation(this.store).apply(
            id,
            preparationRequirements(
              this.store,
              this.config.shop,
              job.recipe.categoryId,
            ),
            { categoryId: job.recipe.categoryId },
          ),
        );
        row = this.store.get(id);
        rememberEffectiveSource(row);
        if (prepared.issues.length) {
          const required = preparationRequirements(
            this.store,
            this.config.shop,
            job.recipe.categoryId,
          );
          const captures = new TargetedCaptures(this.store);
          const request = targetedPlan(
            prepared,
            required,
            captures.attempted(
              this.config.shop,
              row.product!,
              effectiveSource,
              required,
            ),
          );
          const hasTemplate =
            this.store.db
              .prepare(
                "SELECT name FROM sqlite_master WHERE type='table' AND name='category_templates'",
              )
              .get() &&
            this.store.db
              .prepare(
                "SELECT 1 FROM category_templates WHERE shop=? AND category_id=?",
              )
              .get(this.config.shop, job.recipe.categoryId);
          if (request.regions.length && hasTemplate) {
            const gateIssues = collectionGateIssues(
              preflightJob(this.store, this.jobs, { ...job, productId: id }),
            );
            if (gateIssues.length)
              throw new PipelineError(
                "VALIDATION_MISSING",
                gateIssues.map((x) => x.message).join("；"),
              );
            const existing = row.product!;
            await stage("collect-targeted", async () => {
              const unlock = this.store.lock("publisher");
              try {
                this.store.assertRunning(this.config.shop);
                this.store.assertRunning("jd-account:" + this.config.shop);
                this.store.assertRunning(
                  (effectiveSource === "android" ? "jd-android:" : "jd:") +
                    this.config.shop,
                );
                captures.begin(
                  this.config.shop,
                  existing,
                  effectiveSource,
                  required,
                  request.regions,
                );
                let raw: unknown;
                if (effectiveSource === "android") {
                  const facts = productSchema.parse(
                    await this.sources.collectAndroid(
                      this.store,
                      this.config.shop,
                      this.root,
                      String(this.store.meta("android-serial") ?? ""),
                      job.sku,
                      { factsOnly: true },
                    ),
                  );
                  const allowed = new Set([
                    ...request.fields,
                    "京东销售规格",
                    ...(request.regions.includes("summarySpecs")
                      ? ["毛重", "包装毛重", "含包装重量"]
                      : []),
                    ...(request.regions.includes("packaging")
                      ? ["包装清单", "销售数量", "装数", "加热器个数"]
                      : []),
                  ]);
                  raw = {
                    sku: facts.sku,
                    url: facts.url,
                    variant: facts.variant,
                    selectedVariant: facts.specs["京东销售规格"]?.value,
                    specs: Object.fromEntries(
                      Object.entries(facts.specs).filter(([name]) =>
                        allowed.has(name),
                      ),
                    ),
                    observedAt: facts.capturedAt,
                    regions: request.regions,
                    completeRegions: request.regions.filter(
                      (region) =>
                        request.fields.some(
                          (field) =>
                            fieldRegion(field) === region &&
                            !!facts.specs[field],
                        ) ||
                        (region === "packaging" && !!facts.specs["包装清单"]),
                    ),
                  };
                } else
                  raw = await this.bridge.call("collect-regions", {
                    config: this.config,
                    url: existing.url,
                    fields: request.fields,
                    regions: request.regions,
                  });
                const patch = productPatchSchema.parse(raw);
                const updated = mergeProductPatch(existing, patch, request);
                this.store.tx(() => {
                  capture.saveProduct(
                    context,
                    updated,
                    "targeted:" + request.regions.join(","),
                  );
                  row = this.store.put(this.config.shop, updated);
                  rememberEffectiveSource(row);
                  captures.finish(
                    this.config.shop,
                    existing,
                    effectiveSource,
                    required,
                    patch,
                  );
                });
              } finally {
                unlock();
              }
            });
            prepared = await stage("normalize", async () =>
              new Preparation(this.store).apply(id, required, {
                categoryId: job.recipe.categoryId,
              }),
            );
            row = this.store.get(id);
            rememberEffectiveSource(row);
          }
        }
        if (prepared.issues.length)
          throw new PipelineError(
            "VALIDATION_MISSING",
            "本地资料整理尚未就绪",
            prepared.issues,
          );
        if (need === "local" && effectiveSource === "browser") {
          // Finish the offline pass here. The next claim may refresh a quote
          // against the enriched record; this pass never downloads asset URLs.
          this.jobs.update(job.id, "QUEUED", "queued", null, id);
          this.jobs.event(job.id, "normalize", "prepared-locally", null, {
            rulesVersion: prepared.rulesVersion,
          });
          return;
        }
      }
      this.jobs.update(job.id, "RUNNING", "facts", null, id);
      if (
        effectiveSource === "android" &&
        row.product &&
        androidMissing(row.product).length
      )
        throw new PipelineError(
          "NEEDS_INPUT",
          "手机资料已保存；尚缺：" + androidMissing(row.product!).join("、"),
        );
      if (!row.product) throw new PipelineError("NEEDS_INPUT", "缺商品来源");
      if (need === "local")
        throw new PipelineError(
          "NEEDS_INPUT",
          "本地资料已保留，采集入口仍有未完成证据；不自动重复整件采集",
        );
      this.jobs.update(job.id, "RUNNING", "assets", null, id);
      // A completed item is checked against the remote again without re-importing its source or destroying receipts.
      if (
        row.verifiedHash === row.dataHash &&
        ["SUBMITTED", "APPROVED", "ON_SALE"].includes(row.state)
      ) {
        const errors = row.plan
          ? validate(row.product, row.plan)
          : ["缺少计划"];
        if (errors.length)
          throw new PipelineError("VALIDATION_MISSING", errors.join("；"));
        await stage("reconcile", () =>
          new Engine(
            this.store,
            pacedAdapter(
              this.store,
              this.config.shop,
              new EgoAdapter(this.bridge, this.config),
            ),
          ).reconcile(id),
        );
        const fresh = this.store.get(id);
        if (
          fresh.verifiedHash !== fresh.dataHash ||
          fresh.state === "NEEDS_INPUT"
        )
          throw new PipelineError("VALIDATION_MISSING", "远端内容已发生变化");
        this.jobs.update(job.id, "DONE", "done");
        return;
      }
      // Reject an explicit source-brand mismatch before media download. Missing
      // brand evidence remains eligible for the existing targeted fact flow and
      // Planner validation, and already-bound remote work keeps its old path.
      if (!row.remoteId && !row.plan) {
        const sourceBrand = row.product.specs["品牌"]?.value;
        const authorizedBrand = this.store.db
          .prepare("SELECT name FROM catalog_brands WHERE shop=? AND id=?")
          .get(this.config.shop, job.recipe.brandId);
        const expectedBrand = authorizedBrand?.name
          ? String(authorizedBrand.name)
          : "";
        if (
          sourceBrand &&
          expectedBrand &&
          !brandEquivalent(sourceBrand, expectedBrand)
        )
          throw new PipelineError(
            "NEEDS_INPUT",
            "来源品牌与所选授权品牌不一致",
          );
        const selectedSpec = row.product.specs["京东销售规格"]?.value.trim();
        const scent = row.product.specs["香型"]?.value.trim();
        const explicitlyNoScent =
          selectedSpec &&
          /无香(?:型)?(?!料)/.test(selectedSpec) &&
          !/(?:有香|清香|薄荷|茉莉|花香|果香|随机|任选|或|可选|二选|三选)/.test(
            selectedSpec,
          );
        if (explicitlyNoScent && (scent === "有香型" || scent === "清香型"))
          throw new PipelineError(
            "NEEDS_INPUT",
            "所选销售规格明确无香，与香型字段不一致",
          );
      }
      const factsPreflight = preflightJob(
        this.store,
        this.jobs,
        {
          ...job,
          productId: id,
        },
        Date.now(),
        { phase: "facts" },
      );
      const factsIssues = factsPreflight.issues.filter(
        (x) => x.code !== "PLAN_REQUIRED",
      );
      if (factsIssues.length)
        throw new PipelineError(
          factsIssues.some((x) => x.code === "PENDING_OPERATION")
            ? "UNKNOWN_OUTCOME"
            : "VALIDATION_MISSING",
          factsIssues.map((x) => x.message).join("；"),
          factsIssues.map((x) => x.message),
        );
      const p = await stage("assets", () =>
        (this.sources.downloadAssets ?? downloadAssets)(
          row!.product!,
          resolve(this.root, "assets"),
          jdAssetPolicy(this.store, context),
        ),
      );
      capture.saveProduct(context, p, "media");
      row = this.store.put(this.config.shop, p);
      rememberEffectiveSource(row);
      let agentTitle = null;
      if (
        !row.plan &&
        this.config.textAgent?.enabled &&
        this.sources.textAgentTasks
      ) {
        const brand = this.store.db
          .prepare("SELECT name FROM catalog_brands WHERE shop=? AND id=?")
          .get(this.config.shop, job.recipe.brandId);
        const category = this.store.db
          .prepare("SELECT path FROM catalog_categories WHERE shop=? AND id=?")
          .get(this.config.shop, job.recipe.categoryId);
        const titleTemplate = this.store.db
          .prepare(
            "SELECT template FROM category_templates WHERE shop=? AND category_id=?",
          )
          .get(this.config.shop, job.recipe.categoryId);
        const platformNamed =
          titleTemplate &&
          JSON.parse(String(titleTemplate.template)).titleRule?.mode ===
            "platform-generated";
        if (
          !platformNamed &&
          !listingTitle(
            p,
            String(brand?.name ?? ""),
            String(category?.path ?? ""),
          )
        ) {
          const decision = requestTitle(
            this.sources.textAgentTasks,
            job,
            this.config.shop,
            p,
          );
          if (!decision.title) {
            this.jobs.update(
              job.id,
              "NEEDS_INPUT",
              "agent-title",
              "Luna正在整理标题，完成后自动继续",
              id,
            );
            this.jobs.event(job.id, "agent-title", "requested", null, {
              taskId: decision.task.id,
              model: decision.task.model,
            });
            return;
          }
          agentTitle = decision.title;
          this.jobs.event(
            job.id,
            "agent-title",
            "accepted",
            decision.task.durationMs,
            {
              taskId: decision.task.id,
              cached: decision.task.status === "cached",
            },
          );
        }
      }
      if (!row.plan) {
        const plan = await stage("plan", async () =>
          new Planner(this.store).build(
            this.config.shop,
            p,
            job.recipe.brandId,
            job.recipe.categoryId,
            job.recipe.policyId,
            job.recipe.unit,
          ),
        );
        if (agentTitle) plan.displayTitle = agentTitle;
        row = this.store.setPlan(id, plan);
      }
      this.jobs.event(job.id, "assets", "source-order-policy", null, {
        policy: "selected-sku-full-detail-v1",
        contentReview: false,
        assets: p.assets.map(({ role, order, url }) => ({ role, order, url })),
      });
      const localPreflight = preflightJob(this.store, this.jobs, {
        ...job,
        productId: id,
      });
      if (!localPreflight.ready)
        throw new PipelineError(
          "VALIDATION_MISSING",
          preflightMessage(localPreflight),
          localPreflight.issues.map((x) => x.message),
        );
      await stage("validate", async () => {
        new Catalog(this.store).authorize(row!.plan!);
        await verifyLocalAssets(p);
        const errors = validate(p, row!.plan!);
        if (errors.length)
          throw new PipelineError("VALIDATION_MISSING", errors.join("；"));
      });
      await stage("preflight", () => this.platformPreflight(row!.plan!));
      new SourceIndex(this.store);
      if (!row.remoteId) {
        const scan = this.store.db
          .prepare(
            "SELECT * FROM source_scans WHERE shop=? ORDER BY id DESC LIMIT 1",
          )
          .get(this.config.shop);
        if (
          !scan ||
          Date.now() - Date.parse(String(scan.started_at)) > 86400000
        ) {
          throw new PipelineError(
            "NEEDS_INPUT",
            "来源索引缺失或过期；自动全店扫描已关闭，需先安排有预算的来源核验",
          );
        }
      }
      const adapter = pacedAdapter(
        this.store,
        this.config.shop,
        new EgoAdapter(
          this.bridge,
          this.config,
          true,
          false,
          new SourceIndex(this.store),
        ),
      );
      // Instrument browser stages without replacing the engine's durable write intent and identity checks.
      const timed = {
        checkShop: (s: string) => stage("account", () => adapter.checkShop(s)),
        find: (...a: Parameters<EgoAdapter["find"]>) =>
          stage("deduplicate", () => adapter.find(...a)),
        save: (...a: Parameters<EgoAdapter["save"]>) =>
          stage("save", () => adapter.save(...a)),
        read: (...a: Parameters<EgoAdapter["read"]>) =>
          stage("verify", () => adapter.read(...a)),
        submit: (...a: Parameters<EgoAdapter["submit"]>) =>
          stage("submit", () => adapter.submit(...a)),
      };
      const priorError = row.error ? JSON.parse(row.error) : null;
      if (
        priorError?.code === "VALIDATION_MISSING" &&
        Array.isArray(priorError.details) &&
        priorError.details.length &&
        priorError.details.every(
          (x: unknown) =>
            typeof x === "string" &&
            /^字段 (origin|model|length|width|height) 应清空但仍有继承值$/.test(
              x,
            ),
        ) &&
        !this.store.replacement(id)
      ) {
        await stage("repairLegacy", () =>
          replaceLegacy(this.store, this.bridge, this.config, id),
        );
      }
      try {
        await new Engine(this.store, timed).run(id, job.recipe.through);
      } catch (e) {
        if (
          e instanceof PipelineError &&
          e.code === "VALIDATION_MISSING" &&
          Array.isArray(e.details) &&
          e.details.length &&
          e.details.every(
            (x) =>
              typeof x === "string" &&
              /^字段 (origin|model|length|width|height) 应清空但仍有继承值$/.test(
                x,
              ),
          )
        ) {
          await stage("repairLegacy", () =>
            replaceLegacy(this.store, this.bridge, this.config, id),
          );
          await new Engine(this.store, timed).run(id, job.recipe.through);
        } else throw e;
      }
      this.jobs.update(job.id, "DONE", "done");
    } catch (e) {
      const j = this.jobs.get(job.id);
      const code = e instanceof PipelineError ? e.code : "ERROR";
      if (
        [
          "AUTH_REQUIRED",
          "RATE_LIMITED",
          "ACCOUNT_CHANGED",
          "CONTROL_REQUIRED",
          ...(j.stage === "preflight" ? ["UI_CHANGED"] : []),
        ].includes(code)
      )
        this.store.pause(
          ["collect", "price", "collect-targeted"].includes(j.stage) &&
            ["AUTH_REQUIRED", "RATE_LIMITED"].includes(code)
            ? (effectiveSource === "android" ? "jd-android:" : "jd:") +
                this.config.shop
            : code === "CONTROL_REQUIRED"
              ? this.config.shop
              : "hz:" + this.config.shop,
          { code, message: String(e) },
          `worker:${code}`,
        );
      const unknown = j.productId && this.store.pending(j.productId);
      this.jobs.update(
        job.id,
        unknown ? "UNKNOWN_OUTCOME" : "NEEDS_INPUT",
        j.stage,
        (e instanceof Error ? e.message : String(e)).split("\n")[0] +
          (e instanceof PipelineError &&
          Array.isArray(e.details) &&
          e.details.every((x) => typeof x === "string")
            ? "：" + e.details.join("；")
            : ""),
      );
    }
  }
}
