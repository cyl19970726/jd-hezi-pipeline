#!/usr/bin/env node
import { assertHzRunning } from "./platform-availability.js";
import { jdAssetPolicy } from "./jd-asset-policy.js";
import { discoveryWork } from "./discovery-work.js";
import { PricingTasks } from "./pricing-task.js";
import { MarketDetails, sourceMatch } from "./market-details.js";
import {
  createRecoverySnapshot,
  verifyRecoverySnapshot,
} from "./recovery-snapshot.js";
import { MarketScan } from "./market-scan.js";
import { Discovery } from "./discovery.js";
import { pacedAdapter } from "./traffic.js";
import { SourceIndex } from "./source-index.js";
import { exportDetail } from "./detail-bundle.js";
import { auditKnown } from "./reconcile.js";
import { Planner } from "./planner.js";
import { normalizeProduct } from "./normalization.js";
import { BASE_REQUIRED_FACTS } from "./preparation.js";
import { releaseVersion } from "./release-version.js";
import { freezeAcceptance, reportAcceptance } from "./automation-acceptance.js";
import { Jobs } from "./jobs.js";
import {
  registerFamilyEvidence,
  registerMediaEvidence,
  assessStoredMedia,
} from "./automation-evidence.js";
import { replaceLegacy } from "./replacement.js";
import { parseArgs } from "node:util";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Store } from "./store.js";
import { Catalog } from "./catalog.js";
import { refreshTargetedAuthorization } from "./targeted-authorization.js";
import { Engine } from "./engine.js";
import { EgoAdapter, EgoBridge } from "./browser/bridge.js";
import type { BrowserConfig } from "./browser/runtime.js";
import {
  productSchema,
  planSchema,
  parseSku,
  validate,
  PipelineError,
  expectedFields,
} from "./model.js";
import { downloadAssets, verifyLocalAssets } from "./assets.js";
import { demo } from "./demo.js";

const { positionals, values: o } = parseArgs({
  allowPositionals: true,
  options: {
    dir: { type: "string", default: ".hezi" },
    profile: { type: "string" },
    shop: { type: "string" },
    space: { type: "string" },
    hz: { type: "string", default: "p1" },
    jd: { type: "string", default: "p2" },
    file: { type: "string" },
    through: { type: "string", default: "draft" },
    write: { type: "boolean", default: false },
    "max-pages": { type: "string", default: "20" },
    keep: { type: "boolean", default: false },
    help: { type: "boolean", default: false },
    out: { type: "string" },
    "brand-id": { type: "string" },
    "supplier-id": { type: "string" },
    "request-limit": { type: "string", default: "10" },
    "page-limit": { type: "string", default: "3" },
    "market-run": { type: "string" },
    "own-shop-id": { type: "string" },
    "category-id": { type: "string" },
    policy: { type: "string" },
    unit: { type: "string" },
  },
});
const [command, argument] = positionals;
const root = resolve(o.dir!);
const bridge = new EgoBridge();
const json = async (path: string) =>
  JSON.parse(await readFile(resolve(path), "utf8"));
const print = (v: unknown) => console.log(JSON.stringify(v, null, 2));
const config = async () =>
  ({
    ...(await json(resolve(root, "config.json"))),
    requestMetricsPath: resolve(root, "request-traffic.json"),
    sourceDatabasePath: resolve(root, "state.sqlite"),
  }) as BrowserConfig;
async function main() {
  if (
    !Number.isInteger(Number(o["max-pages"])) ||
    Number(o["max-pages"]) < 1 ||
    Number(o["max-pages"]) > 10000
  )
    throw new PipelineError("NEEDS_INPUT", "max-pages 需为1至10000的整数");
  if (o.help || !command) {
    console.log(`hezi-pipeline — Ego Browser 京东→赫兹

init --profile <profile-id> --shop <店铺全名>  创建新任务空间
attach --space <space-id> --profile <profile-id> --shop <店铺全名> [--hz p1 --jd p2]
inspect | schema                       只读查看登录状态/当前表单
audit-known                            只读对账已验证绑定商品
snapshot [--out 新目录]                一致性数据库与已下载原图本地备份
verify-snapshot <目录>                 校验备份数据库、记录数量及素材
plan-auto ID --brand-id ID --category-id ID --policy ID --unit 件 [--out JSON]
normalize --file product.json [--out report.json]  纯离线资料转换，不打开状态库、不访问网站
release-version                       显示当前可执行版本指纹
acceptance-freeze --file batch.json    冻结全新批次、版本与验收分母
acceptance-report <验收ID>             核对实际回执、版本及人工介入
family-evidence --file proof.json      注册有来源的产品族字段适用证据
media-evidence <记录ID> --file JSON    注册逐图适用性证据与判定来源
media-report <记录ID>                  查看逐图适用性及缺失证据
template-import CATEGORY --file JSON | policy-import ID --file JSON
template-read CATEGORY                 读取当前赫兹规格参数页并校验保存模板
replace-legacy ID --write              隔离无订单的脏草稿并建立可审计替代记录
catalog | catalog-import --file JSON   查询/导入带平台ID和来源的目录子集
sync-brands --supplier-id ID           续跑当前品牌库核对（每轮最多十个请求）
sync-catalog                          从已打开的商品列表读取类目树和品牌选项
sync-sources                          同步全店京东来源索引（增量缓存）
sync-inventory                        只读同步草稿与其他商品（记录覆盖范围）
handoff | take-over                    交还用户/用户完成后恢复
import --file product.json             导入有来源的商品记录
collect <京东URL或SKU>                  采集单品（未知价格不伪造）
market-start <关键词>                 建立商城查询批次（只建立本地记录）
scan-market <批次ID>                  续读商城分页，最多五页/轮
market-status                        查看搜索覆盖及重复SKU情况
market-details <批次ID>               缓存候选详情，最多三个商品/轮，不自动定价
market-match <记录ID> --market-run ID  本地读取候选来源SKU证据，不访问两站
review-start <记录ID> --market-run IDs --own-shop-id ID 建立可恢复比价审查
review-update <审查ID> --file FILE      逐候选保存同款/不同款判断与证据
review-status [审查ID]                 查看比价审查进度与未决候选
review-finalize <审查ID>                核验完整证据并生成持久化价格决策
discovery-status                      查看店铺分页与规格发现进度
discovery-work <批次ID>                本地核对逐规格已有商品、任务和待安排项
discover-source <批次ID>               从已保存断点继续核对京东商品与独立规格
discover <京东店铺页URL>                旧式临时链接发现（不代表完整品牌覆盖）
export-detail <记录ID> [--out 目录]    用本地原图资产生成完整离线详情页
assets <记录ID>                        下载、转码并验证图片
plan <记录ID> --file plan.json         设置有来源的发布规则
validate <记录ID>                      只读发布前校验
run [记录ID] --write [--through draft|submit]
reconcile <记录ID>                     写入中断后的远端对账
withdraw <记录ID> --write              按有效修正计划撤回原待审核商品
status | events                       分离展示草稿/提交/在售/未知
pause [店铺名] | resume [店铺名]        暂停/恢复调度（恢复不解除未知结果）
recover-locks                          只回收已退出进程的锁
finish [--keep]                        结束空间；必要时保留工作页
demo                                  离线模拟单品提交与重跑去重

所有命令支持 --dir <本地状态目录>。npm run build 后执行 node dist/cli.js。
默认不写网站。新建查重须由数据库记录证明近期完整同步且所有来源身份已解析。
未知来源或部分同步不能证明远端不存在；旧脏记录替代使用单独的可审计流程。`);
    return;
  }
  if (command === "demo") {
    print(await demo());
    return;
  }
  if (command === "release-version") {
    print({ releaseId: await releaseVersion() });
    return;
  }
  if (command === "normalize") {
    if (!o.file) throw new PipelineError("NEEDS_INPUT", "需要 --file 商品JSON");
    const report = normalizeProduct(
      productSchema.parse(await json(o.file)),
      BASE_REQUIRED_FACTS,
    );
    if (o.out)
      await writeFile(resolve(o.out), JSON.stringify(report, null, 2), {
        mode: 0o600,
        flag: "wx",
      });
    else print(report);
    return;
  }
  await mkdir(root, { recursive: true, mode: 0o700 });
  const store = new Store(resolve(root, "state.sqlite"));
  const catalog = new Catalog(store);
  const markManual = (shop: string, sku: string) => {
    const jobs = new Jobs(store, shop);
    for (const job of jobs.list().filter((job) => job.sku === sku))
      jobs.event(job.id, "manual", "data-updated", null, {
        actor: "operator",
        command,
      });
  };
  try {
    if (command === "acceptance-freeze") {
      if (!o.file)
        throw new PipelineError("NEEDS_INPUT", "需要 --file 批次JSON");
      const c = await config();
      const input = await json(o.file);
      const current = await releaseVersion();
      if (input.releaseId && input.releaseId !== current)
        throw new PipelineError(
          "NEEDS_INPUT",
          "批次版本与当前可执行版本不一致",
        );
      print(
        freezeAcceptance(store, new Jobs(store, c.shop), {
          ...input,
          releaseId: current,
        }),
      );
      return;
    }
    if (command === "acceptance-report") {
      print(reportAcceptance(store, argument));
      return;
    }
    if (command === "family-evidence") {
      if (!o.file)
        throw new PipelineError("NEEDS_INPUT", "需要 --file 产品族证据JSON");
      print(
        registerFamilyEvidence(
          store,
          (await config()).shop,
          await json(o.file),
        ),
      );
      return;
    }
    if (command === "media-evidence") {
      if (!o.file)
        throw new PipelineError("NEEDS_INPUT", "需要 --file 逐图证据JSON");
      print(
        registerMediaEvidence(
          store,
          (await config()).shop,
          argument,
          await json(o.file),
        ),
      );
      const jobs = new Jobs(store, (await config()).shop);
      for (const j of jobs.list().filter((j) => j.productId === argument))
        jobs.event(j.id, "manual", "evidence-added", null, {
          actor: "operator",
        });
      return;
    }
    if (command === "media-report") {
      const c = await config();
      const row = store.get(argument);
      if (row.shop !== c.shop || !row.product)
        throw new PipelineError("NEEDS_INPUT", "商品范围不符");
      print(assessStoredMedia(store, c.shop, row.product));
      return;
    }
    if (command === "snapshot") {
      await mkdir(resolve(root, "backups"), { recursive: true, mode: 0o700 });
      print(
        await createRecoverySnapshot(
          store,
          o.out
            ? resolve(o.out)
            : resolve(
                root,
                "backups",
                new Date().toISOString().replaceAll(":", "-"),
              ),
        ),
      );
      return;
    }
    if (command === "verify-snapshot") {
      if (!argument) throw new PipelineError("NEEDS_INPUT", "缺少备份目录");
      print(await verifyRecoverySnapshot(argument));
      return;
    }
    if (command === "audit-known") {
      const c = await config();
      print(await auditKnown(store, new EgoAdapter(bridge, c), c.shop));
      return;
    }
    if (command === "template-read") {
      if (!argument) throw new PipelineError("NEEDS_INPUT", "需要类目ID");
      const c = await config(),
        release = store.lock("publisher");
      try {
        assertHzRunning(store, c.shop);
        const template = await bridge.call(command, {
          config: c,
          categoryId: argument,
        });
        new Planner(store).importTemplate(c.shop, argument, template);
        print({ imported: argument, template });
      } finally {
        release();
      }
      return;
    }
    if (command === "template-import" || command === "policy-import") {
      if (!o.file || !argument)
        throw new PipelineError("NEEDS_INPUT", "需要ID和 --file");
      const c = await config(),
        data = await json(o.file),
        planner = new Planner(store);
      if (command === "template-import")
        planner.importTemplate(c.shop, argument, data);
      else planner.importPolicy(c.shop, argument, data);
      print({ imported: argument });
      return;
    }
    if (command === "plan-auto") {
      if (
        !argument ||
        !o["brand-id"] ||
        !o["category-id"] ||
        !o.policy ||
        !o.unit
      )
        throw new PipelineError(
          "NEEDS_INPUT",
          "需要商品ID、brand-id、category-id、policy、unit",
        );
      const row = store.get(argument);
      if (!row.product) throw new PipelineError("NEEDS_INPUT", "缺商品事实");
      const plan = new Planner(store).build(
        row.shop,
        row.product,
        o["brand-id"],
        o["category-id"],
        o.policy,
        o.unit,
      );
      if (o.out)
        await writeFile(resolve(o.out), JSON.stringify(plan, null, 2), {
          mode: 0o600,
        });
      else print(plan);
      return;
    }
    if (command === "replace-legacy") {
      if (!o.write || !argument)
        throw new PipelineError("NEEDS_INPUT", "需要记录ID和 --write");
      const r = await replaceLegacy(store, bridge, await config(), argument);
      print({ id: r.id, remoteId: r.remoteId, state: r.state });
      return;
    }
    if (command === "sync-brands") {
      if (!o["supplier-id"])
        throw new PipelineError("NEEDS_INPUT", "缺少已经核验的供应商 ID");
      print(
        await bridge.call("sync-brands", {
          config: await config(),
          database: resolve(root, "state.sqlite"),
          supplierId: o["supplier-id"],
          limit: Number(o["request-limit"]),
        }),
      );
      return;
    }
    if (command === "sync-catalog") {
      const c = await config();
      const unlock = store.lock("publisher");
      try {
        print(
          catalog.import(await bridge.call("catalog-options", { config: c })),
        );
      } finally {
        unlock();
      }
      return;
    }
    if (command === "catalog") {
      print(catalog.summary(o.shop ?? (await config()).shop));
      return;
    }
    if (command === "catalog-import") {
      if (!o.file) throw new PipelineError("NEEDS_INPUT", "需要 --file");
      const data = await json(o.file);
      if (data.shop !== (o.shop ?? (await config()).shop))
        throw new PipelineError("ACCOUNT_CHANGED", "目录店铺不符");
      print(catalog.import(data));
      return;
    }
    if (command === "sync-sources") {
      const c = await config(),
        unlock = store.lock("publisher");
      try {
        const result = await new EgoBridge("ego-browser", 3600000).call(
          "sync-sources",
          {
            config: c,
            database: resolve(root, "state.sqlite"),
            budget: {
              maxRequests: Number(o["request-limit"] ?? 25),
              intervalMs: 1000,
            },
          },
        );
        print(result);
        if (!result.complete) process.exitCode = 2;
      } finally {
        unlock();
      }
      return;
    }
    if (command === "refresh-authorization") {
      if (!o["brand-id"] || !o["category-id"])
        throw new PipelineError("NEEDS_INPUT", "需要明确的品牌和类目 ID");
      print(
        await refreshTargetedAuthorization(
          store,
          await config(),
          {
            brandId: o["brand-id"],
            categoryId: o["category-id"],
          },
          bridge,
        ),
      );
      return;
    }
    if (command === "sync-inventory") {
      const c = await config();
      const unlock = store.lock("publisher");
      try {
        const results = [];
        for (const partition of ["draft", "normal"] as const) {
          const id = catalog.beginSync(c.shop, partition);
          try {
            const result = await bridge.call("list", {
              config: c,
              query: { draft: partition === "draft" },
            });
            results.push(
              catalog.finishSync(id, result.records, result.complete),
            );
          } catch (e) {
            catalog.finishSync(id, [], false, String(e));
            throw e;
          }
        }
        print(results);
        if (results.some((r) => !r.complete)) process.exitCode = 2;
      } finally {
        unlock();
      }
      return;
    }
    if (["init", "attach"].includes(command)) {
      if (!o.profile || !o.shop)
        throw new PipelineError("NEEDS_INPUT", "需要 --profile 与 --shop");
      const existing = await readFile(
        resolve(root, "config.json"),
        "utf8",
      ).catch(() => null);
      if (existing)
        throw new PipelineError(
          "NEEDS_INPUT",
          "此目录已有浏览器绑定，请复用 inspect/take-over，避免新建空间",
        );
      const session =
        command === "attach"
          ? {
              spaceId: Number(o.space),
              hzPage: o.hz!,
              jdPage: o.jd!,
              profileId: o.profile,
            }
          : await bridge.call("open", { profile: o.profile });
      if (!Number.isInteger(session.spaceId) || session.spaceId < 1)
        throw new PipelineError("NEEDS_INPUT", "--space 必须是有效空间ID");
      const c: BrowserConfig = {
        session,
        shop: o.shop,
        listUrl:
          "https://b.csgmall.com.cn/shop-view/#/shop-view/goods/goods-manage",
        newUrl:
          "https://b.csgmall.com.cn/shop-view/#/shop-view/goods/publish?new=1",
        editUrl:
          "https://b.csgmall.com.cn/shop-view/#/shop-view/goods/publish?itemId={itemId}&status=99",
        maxPages: Number(o["max-pages"]),
      };
      await writeFile(
        resolve(root, "config.json"),
        JSON.stringify(c, null, 2),
        { mode: 0o600 },
      );
      print({ attached: session, shop: c.shop });
      return;
    }
    if (
      ["inspect", "schema", "handoff", "finish", "take-over"].includes(command)
    ) {
      const c = await config();
      print(
        await bridge.call(
          command === "take-over" ? "resume" : command,
          command === "take-over"
            ? { spaceId: c.session.spaceId }
            : { config: c, keep: o.keep },
        ),
      );
      return;
    }
    if (command === "status") {
      print(
        store.list().map((r) => ({
          id: r.id,
          sku: r.sku,
          state: r.state,
          remoteId: r.remoteId,
          revision: r.revision,
          error: r.error ? JSON.parse(r.error) : null,
        })),
      );
      return;
    }
    if (command === "events") {
      print(store.events());
      return;
    }
    if (command === "recover-locks") {
      print({ recovered: store.recoverLocks() });
      return;
    }
    if (command === "pause" || command === "resume") {
      const scope = argument ?? "all";
      if (command === "pause") store.pause(scope, "用户暂停");
      else store.resume(scope);
      print({ scope, action: command });
      return;
    }
    if (command === "import") {
      if (!o.file) throw new PipelineError("NEEDS_INPUT", "需要 --file");
      const shop = o.shop ?? (await config()).shop;
      const p = productSchema.parse(await json(o.file));
      markManual(shop, p.sku);
      print(store.put(shop, p));
      return;
    }
    if (command === "collect") {
      const c = await config();
      const sku = parseSku(argument);
      markManual(c.shop, sku);
      store.assertRunning(c.shop);
      const release = store.lock("publisher");
      let raw;
      try {
        raw = await bridge.call("collect", {
          config: c,
          url: `https://item.jd.com/${sku}.html`,
        });
      } finally {
        release();
      }
      if (raw.sku !== sku || !raw.title?.value || raw.title.value === sku)
        throw new PipelineError(
          "NEEDS_INPUT",
          "未采到目标商品，禁止导入风控页",
        );
      const row = store.put(c.shop, productSchema.parse(raw));
      print({
        id: row.id,
        sku,
        price: raw.price,
        priceCandidates: raw.priceCandidates,
        images: raw.assets.length,
      });
      return;
    }
    if (
      [
        "market-start",
        "scan-market",
        "market-status",
        "market-details",
      ].includes(command)
    ) {
      const c = await config(),
        market = new MarketScan(store);
      if (command === "market-status") print(market.list(c.shop));
      else if (!argument)
        throw new PipelineError("NEEDS_INPUT", "缺少查询词或批次ID");
      else if (command === "market-start")
        print({ id: market.start(c.shop, argument) });
      else
        print(
          await bridge.call(
            command === "market-details" ? "market-details" : "scan-market",
            {
              config: c,
              database: resolve(root, "state.sqlite"),
              runId: argument,
              limit: Number(o["page-limit"]),
            },
          ),
        );
      return;
    }
    if (
      [
        "review-start",
        "review-update",
        "review-status",
        "review-finalize",
      ].includes(command)
    ) {
      const c = await config(),
        tasks = new PricingTasks(store);
      if (command === "review-start") {
        if (!o["market-run"] || !o["own-shop-id"])
          throw new PipelineError("NEEDS_INPUT", "需要market-run和own-shop-id");
        print({
          id: tasks.start(
            c.shop,
            argument,
            o["own-shop-id"],
            o["market-run"].split(","),
          ),
        });
      } else if (command === "review-status")
        print(
          argument
            ? {
                ...tasks.status(argument),
                candidates: tasks.candidates(argument),
              }
            : tasks.list(c.shop),
        );
      else {
        if (tasks.status(argument).shop !== c.shop)
          throw new PipelineError("NEEDS_INPUT", "比价任务店铺不符");
        if (command === "review-finalize") print(tasks.finalize(argument));
        else {
          if (!o.file)
            throw new PipelineError("NEEDS_INPUT", "需要候选判断file");
          const input = await json(o.file);
          if (!Array.isArray(input) || input.length > 1000)
            throw Error("候选判断必须是最多1000项的数组");
          for (const row of input)
            tasks.update(argument, row.offerId, row.judgment);
          print(tasks.status(argument));
        }
      }
      return;
    }
    if (command === "market-match") {
      const c = await config(),
        product = store.get(argument).product;
      if (!product || !o["market-run"])
        throw new PipelineError("NEEDS_INPUT", "缺少商品记录或market-run");
      const market = new MarketScan(store),
        run = market.get(o["market-run"]);
      if (run.shop !== c.shop)
        throw new PipelineError("NEEDS_INPUT", "商城批次店铺不符");
      const details = new MarketDetails(store);
      const rows = [
        ...new Map(
          market
            .pages(o["market-run"])
            .flatMap((p) =>
              p.rows.flatMap((r) =>
                r.skus.map((sku) => [sku.skuId, { ...r, sku }]),
              ),
            ),
        ).values(),
      ];
      print(
        rows.map((r) => {
          const d = details.fresh(c.shop, r.itemId);
          return {
            itemId: r.itemId,
            sku: r.sku.skuId,
            title: r.sku.title,
            shopId: r.shopId,
            minimum: r.minimum,
            free: r.free,
            ...(d
              ? sourceMatch(product, d, r.sku.skuId)
              : { source: "needs-detail", reviewRequired: true }),
          };
        }),
      );
      return;
    }
    if (command === "discovery-work") {
      if (!argument) throw new PipelineError("NEEDS_INPUT", "需要来源批次ID");
      print(discoveryWork(store, (await config()).shop, argument));
      return;
    }
    if (command === "discovery-status") {
      print(new Discovery(store).list((await config()).shop));
      return;
    }
    if (command === "discover-source") {
      if (!argument)
        throw new PipelineError("NEEDS_INPUT", "缺少已登记来源批次ID");
      print(
        await bridge.call("discover-source", {
          config: await config(),
          database: resolve(root, "state.sqlite"),
          runId: argument,
          limit: Number(o["page-limit"]),
        }),
      );
      return;
    }
    if (command === "discover") {
      const c = await config();
      const start = new URL(argument);
      if (!/(^|\.)jd\.com$/.test(start.hostname))
        throw new PipelineError("NEEDS_INPUT", "只支持京东店铺 URL");
      const seen = new Set<string>();
      const skus = new Set<string>();
      const queue = [start.href];
      let complete = true;
      try {
        while (queue.length && seen.size < Number(o["max-pages"])) {
          const url = queue.shift()!;
          if (seen.has(url)) continue;
          seen.add(url);
          const data = await bridge.call("discover", { config: c, url });
          for (const s of data.skus) skus.add(s);
          for (const next of data.pagination) {
            const u = new URL(next, url);
            if (/(^|\.)jd\.com$/.test(u.hostname) && !seen.has(u.href))
              queue.push(u.href);
          }
        }
      } catch (e) {
        complete = false;
        store.pause(c.shop, { error: String(e) });
        throw e;
      } finally {
        await writeFile(
          resolve(root, "discovery.json"),
          JSON.stringify(
            {
              skus: [...skus],
              pages: [...seen],
              remaining: queue,
              complete: complete && !queue.length,
            },
            null,
            2,
          ),
        );
      }
      print({
        skus: [...skus],
        pages: seen.size,
        complete: !queue.length,
        note: "仅覆盖页面暴露的 SKU 链接；销售变体需单独采集",
      });
      return;
    }
    if (command === "export-detail") {
      const row = store.get(argument);
      if (!row.product) throw new PipelineError("NEEDS_INPUT", "缺少商品");
      print(
        await exportDetail(
          row.product,
          resolve(o.out ?? resolve(root, "details", row.sku)),
        ),
      );
      return;
    }
    if (command === "assets") {
      const row = store.get(argument);
      markManual(row.shop, row.sku);
      if (!row.product) throw new PipelineError("NEEDS_INPUT", "缺来源");
      const p = await downloadAssets(
        row.product,
        resolve(root, "assets"),
        jdAssetPolicy(store, {
          shop: row.shop,
          sku: row.sku,
          source: row.product.assets.some((a) => a.origin === "android-album")
            ? "android"
            : "browser",
        }),
      );
      print({ id: store.put(row.shop, p).id, assets: p.assets.length });
      return;
    }
    if (command === "plan") {
      if (!o.file) throw new PipelineError("NEEDS_INPUT", "需要 --file");
      const row = store.get(argument);
      markManual(row.shop, row.sku);
      print(store.setPlan(argument, planSchema.parse(await json(o.file))));
      return;
    }
    if (command === "validate") {
      const row = store.get(argument);
      if (!row.product || !row.plan)
        throw new PipelineError("NEEDS_INPUT", "缺商品或规则");
      await verifyLocalAssets(row.product);
      const issues = validate(row.product, row.plan);
      try {
        catalog.authorize(row.plan);
      } catch (e) {
        issues.push(String(e));
      }
      print({
        valid: issues.length === 0,
        issues,
        expected: expectedFields(row.product, row.plan),
        dataHash: row.dataHash,
      });
      if (issues.length) process.exitCode = 2;
      return;
    }
    if (
      command === "run" ||
      command === "reconcile" ||
      command === "withdraw"
    ) {
      if ((command === "run" || command === "withdraw") && !o.write)
        throw new PipelineError(
          "NEEDS_INPUT",
          "run 需要 --write；只读检查请使用 validate",
        );
      if (!["draft", "submit"].includes(o.through!))
        throw new PipelineError(
          "NEEDS_INPUT",
          "through 必须为 draft 或 submit",
        );
      const c = await config();
      const engine = new Engine(
        store,
        pacedAdapter(
          store,
          c.shop,
          new EgoAdapter(bridge, c, o.write, false, new SourceIndex(store)),
        ),
      );
      const ids = argument
        ? [argument]
        : store
            .list()
            .filter((r) => r.shop === c.shop)
            .map((r) => r.id);
      if ((command === "reconcile" || command === "withdraw") && !argument)
        throw new PipelineError("NEEDS_INPUT", "reconcile 必须指定记录ID");
      const results = [];
      for (const id of ids) {
        const row = store.get(id);
        if (row.shop !== c.shop)
          throw new PipelineError(
            "ACCOUNT_CHANGED",
            "商品所属店铺与浏览器配置不符",
          );
        try {
          if (command === "run" || command === "withdraw") {
            markManual(row.shop, row.sku);
            if (!row.plan)
              throw new PipelineError("NEEDS_INPUT", "缺少上架计划");
            catalog.authorize(row.plan);
            await verifyLocalAssets(row.product!);
            const result =
              command === "withdraw"
                ? await engine.withdraw(id)
                : await engine.run(id, o.through as "draft" | "submit");
            results.push({ id, state: result.state });
          } else {
            const result = await engine.reconcile(id);
            results.push({ id, state: result.state });
          }
        } catch (e) {
          results.push({ id, error: String(e), state: store.get(id).state });
          process.exitCode = 2;
          if (store.meta("pause:" + c.shop) || store.meta("pause:all")) break;
        }
      }
      print(results);
      return;
    }
    throw new PipelineError("NEEDS_INPUT", "未知命令：" + command);
  } finally {
    store.close();
  }
}
main().catch((e) => {
  print({
    error: e instanceof PipelineError ? e.code : "ERROR",
    message: e.message,
    details: e.details ?? null,
  });
  process.exitCode = 1;
});
