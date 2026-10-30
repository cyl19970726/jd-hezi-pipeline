import { readFreshAndroidXml } from "./android-ui-dump.js";
import { navigateKnownVariant } from "./android-navigation.js";
import type { AndroidVariantProof } from "./android-variant-proof.js";
import {
  completeAndroid,
  type AndroidCollectOptions,
  validateAndroidCollectOptions,
} from "./android-complete.js";
import { AndroidSession } from "./android-session.js";
import { androidMissing } from "./android-structure.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { Store } from "./store.js";
import { JdTraffic } from "./jd-traffic.js";
import { PipelineError, type Product, parseSku } from "./model.js";
const exec = promisify(execFile);
export async function adb(args: string[]) {
  try {
    return (await exec("adb", args, { timeout: 30000, maxBuffer: 8_000_000 }))
      .stdout;
  } catch (e) {
    throw new PipelineError(
      "NEEDS_INPUT",
      "安卓设备命令未完成：" +
        (e instanceof Error ? e.message : String(e)).split("\n")[0],
    );
  }
}
export async function androidDevices() {
  return (await adb(["devices", "-l"]))
    .split("\n")
    .slice(1)
    .filter((l) => /^\S+\s+(device|unauthorized|offline)\b/.test(l))
    .map((l) => {
      const [serial, status] = l.trim().split(/\s+/);
      return { serial, status, model: l.match(/model:(\S+)/)?.[1] ?? serial };
    });
}
export async function checkAndroidDevice(serial: string) {
  if (
    !(await androidDevices()).some(
      (d) => d.serial === serial && d.status === "device",
    )
  )
    throw new PipelineError("NEEDS_INPUT", "所选安卓手机未连接或未授权");
  const activity = await adb([
    "-s",
    serial,
    "shell",
    "dumpsys",
    "activity",
    "activities",
  ]);
  if (
    !activity
      .split("\n")
      .some(
        (l) =>
          /mResumedActivity|topResumedActivity/.test(l) &&
          l.includes("com.jingdong.app.mall/"),
      )
  )
    throw new PipelineError("NEEDS_INPUT", "请先让手机京东显示在前台");
  const xml = await readFreshAndroidXml((args) => adb(["-s", serial, ...args]));
  checkAndroid(xml);
  if (!androidNodes(xml).some((n) => n.text || n["content-desc"]))
    throw new PipelineError("NEEDS_INPUT", "手机京东页面尚未加载");
  return { ready: true };
}
const decode = (s: string) =>
  s
    .replace(/&#x([a-f\d]+);/gi, (_, n) =>
      String.fromCodePoint(parseInt(n, 16)),
    )
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/[\u200b-\u200f\ufeff]/g, "")
    .trim();
export function androidNodes(xml: string) {
  return [...xml.matchAll(/<node\s+([^>]*?)(?:\/?>)/g)].map((m) =>
    Object.fromEntries(
      [...m[1].matchAll(/([\w-]+)="([^"]*)"/g)].map((a) => [
        a[1],
        decode(a[2]),
      ]),
    ),
  );
}

/** A loaded product shell is enough to open the SKU panel; it is not SKU proof. */
export function androidProductMainReady(xml: string) {
  const nodes = androidNodes(xml);
  return (
    nodes.some((node) => /^共\d+款$/.test(node["content-desc"] || "")) &&
    nodes.some((node) => /^已选中款式\s+/.test(node["content-desc"] || ""))
  );
}
export function checkAndroid(xml: string) {
  const text = androidNodes(xml)
    .map((n) => n.text || n["content-desc"] || "")
    .join("\n");
  if (/京东验证|检测到安全风险|完成安全验证|拖动.*拼图/.test(text))
    throw new PipelineError(
      "RATE_LIMITED",
      "手机京东需要完成安全验证，已保留任务",
    );
  if (/短信验证码登录|账号密码登录|手机号登录/.test(text))
    throw new PipelineError("AUTH_REQUIRED", "手机京东需要登录");
}
export function parseAndroidProduct(
  sku: string,
  mainXml: string,
  detailXml: string,
  at = new Date().toISOString(),
): Product {
  checkAndroid(mainXml);
  checkAndroid(detailXml);
  const main = androidNodes(mainXml),
    detail = androidNodes(detailXml),
    texts = detail.map((n) => n.text).filter(Boolean);
  const index = texts.indexOf("商品编号");
  if (index < 0 || texts[index + 1] !== sku)
    throw new PipelineError("NEEDS_INPUT", "手机商品编号未核验或与任务SKU不符");
  const selected = main.find((n) =>
    /^已选中款式 /.test(n["content-desc"] || n.text || ""),
  );
  const variant = (selected?.["content-desc"] || selected?.text || "").replace(
    /^已选中款式 /,
    "",
  );
  const titleCandidates = main.filter(
    (n) =>
      n.clickable === "true" &&
      !n["resource-id"] &&
      n.text?.length >= 20 &&
      !/已享受|可再享|信用|人民币|价格说明/.test(n.text),
  );
  // Current JD exposes the product title in both text and accessibility label.
  // Membership offers can also be long clickable text; they lack this title evidence.
  const labelledTitles = titleCandidates.filter(
    (n) =>
      n["content-desc"] === n.text || n["content-desc"] === "京东超市" + n.text,
  );
  const titles = labelledTitles.length ? labelledTitles : titleCandidates;
  if (!variant || titles.length !== 1)
    throw new PipelineError(
      "NEEDS_INPUT",
      "手机标题或所选规格不唯一，不能猜测商品",
    );
  const url = `https://item.jd.com/${sku}.html`,
    fact = (value: string, evidence: string) => ({
      value,
      sourceUrl: url,
      capturedAt: at,
      evidence: "安卓京东原生页面：" + evidence,
    });
  const specs: Product["specs"] = { 京东销售规格: fact(variant, "已选中款式") };
  const end = texts.indexOf("店内优选", index);
  const params = texts.slice(Math.max(0, index - 2), end < 0 ? undefined : end);
  for (const key of [
    "品牌",
    "农药登记证号",
    "保质期",
    "适用场景",
    "形态",
    "国产/进口",
    "商品毛重",
    "规格",
    "总净含量",
    "香型",
  ]) {
    const i = params.indexOf(key);
    if (i >= 0 && params[i + 1])
      specs[key] = fact(params[i + 1], "规格参数 " + key);
  }
  const pack = texts.indexOf("包装清单");
  if (pack >= 0 && texts[pack + 1])
    specs["包装清单"] = fact(texts[pack + 1], "包装清单");
  const priceNodes = main.slice(
    main.indexOf(selected!),
    main.indexOf(titles[0]),
  );
  type NativeQuote = {
    value: string;
    basis: "subsidy" | "jd-price";
    label: "日常价" | "京东价" | "补贴价";
  };
  const labelledValues = (label: NativeQuote["label"]) => [
    ...new Set(
      priceNodes.flatMap((n) => {
        const text = n.text || n["content-desc"] || "";
        const m =
          text.match(
            new RegExp(
              "^" + label + "\\s*[¥￥]?\\s*(\\d+(?:\\.\\d{1,2})?)\\s*元?$",
            ),
          ) ||
          text.match(
            new RegExp(
              "^[¥￥]?\\s*(\\d+(?:\\.\\d{1,2})?)\\s*元?\\s*" + label + "$",
            ),
          );
        return m && Number(m[1]) > 0 ? [m[1]] : [];
      }),
    ),
  ];
  const tierQuote = (
    entries: ReadonlyArray<
      readonly [NativeQuote["label"], NativeQuote["basis"]]
    >,
  ): { present: boolean; quote: NativeQuote | null } => {
    const present = entries.some(([label]) =>
      priceNodes.some((node) => {
        const text = node.text || node["content-desc"] || "";
        return text.startsWith(label) || text.endsWith(label);
      }),
    );
    const candidates = entries.flatMap(([label, basis]) =>
      labelledValues(label).map((value) => ({ value, basis, label })),
    );
    if (!candidates.length) return { present, quote: null };
    const values = new Set(
      candidates.map((candidate) => String(Number(candidate.value))),
    );
    return {
      present: true,
      quote: values.size === 1 ? candidates[0] : null,
    };
  };
  const regular = tierQuote([
    ["日常价", "jd-price"],
    ["京东价", "jd-price"],
  ]);
  const quote = regular.present
    ? regular.quote
    : tierQuote([["补贴价", "subsidy"]]).quote;
  // Only an explicit label and amount in the target's price area; never infer from bare numbers.
  return {
    sku,
    url,
    variant: "",
    title: fact(titles[0].text, "商品标题"),
    price: quote
      ? {
          ...fact(quote.value, "价格明确标签与金额：" + quote.label),
          basis: quote.basis,
        }
      : null,
    specs,
    assets: [],
    capturedAt: at,
  };
}
async function collectAndroidInternal(
  store: Store,
  shop: string,
  root: string,
  serial: string,
  sku: string,
  options: AndroidCollectOptions = {},
) {
  validateAndroidCollectOptions(options);
  parseSku(sku);
  try {
    const device = (await androidDevices()).find((d) => d.serial === serial);
    if (!device || device.status !== "device")
      throw new PipelineError(
        "NEEDS_INPUT",
        "所选安卓手机未连接、未授权或离线",
      );
  } catch (e) {
    store.pause("jd-android:" + shop, {
      code: "DEVICE_UNAVAILABLE",
      message: e instanceof Error ? e.message : String(e),
    });
    throw e;
  }
  const dir = resolve(root, "android", sku, randomUUID());
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const run = (args: string[]) => {
    new JdTraffic(store, shop, undefined, "android").assertRunning();
    return adb(["-s", serial, ...args]);
  };
  const dimensions = await run(["shell", "wm", "size"]);
  const size =
    dimensions.match(/Override size: (\d+x\d+)/)?.[1] ??
    dimensions.match(/Physical size: (\d+x\d+)/)?.[1];
  if (size !== "1080x2400")
    throw new PipelineError(
      "NEEDS_INPUT",
      "当前手机屏幕尺寸尚未适配：" + (size ?? "未知"),
    );
  const dump = async (name: string) => {
    const xml = await readFreshAndroidXml(run);
    await writeFile(resolve(dir, name + ".xml"), xml, { mode: 0o600 });
    return xml;
  };
  const tap = async (n: Record<string, string> | undefined) => {
    const b = n?.bounds?.match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
    if (!b || +b[3] <= +b[1] || +b[4] <= +b[2])
      throw new PipelineError("NEEDS_INPUT", "手机页面控件位置不可用");
    await run([
      "shell",
      "input",
      "tap",
      String(Math.round((+b[1] + +b[3]) / 2)),
      String(Math.round((+b[2] + +b[4]) / 2)),
    ]);
  };
  try {
    const current = await dump("initial");
    checkAndroid(current);
    const pending = store.meta("android-open:" + shop);
    const currentTexts = androidNodes(current).map((n) => n.text);
    const currentIndex = currentTexts.indexOf("商品编号");
    let reuse =
      pending?.sku === sku &&
      Date.now() - Date.parse(pending.at) >= 0 &&
      Date.now() - Date.parse(pending.at) < 3600000 &&
      (androidNodes(current).some((n) =>
        /^已选中款式 /.test(n["content-desc"] || ""),
      ) ||
        (currentIndex >= 0 && currentTexts[currentIndex + 1] === sku));
    const navigationSession = new AndroidSession(serial, dir, () =>
      new JdTraffic(store, shop, undefined, "android").assertRunning(),
    );
    let variantProof: AndroidVariantProof | undefined;
    const receiveVariantProof = (proof: AndroidVariantProof) => {
      variantProof = proof;
    };
    if (!reuse)
      reuse = await navigateKnownVariant(
        store,
        shop,
        sku,
        navigationSession,
        current,
        receiveVariantProof,
      );
    let navigated = false;
    if (!reuse) {
      store.setMeta("android-open:" + shop, {
        sku,
        at: new Date().toISOString(),
      });
      await new JdTraffic(store, shop, undefined, "android").navigate(
        `https://item.jd.com/${sku}.html`,
        () =>
          run([
            "shell",
            "am",
            "start",
            "-a",
            "android.intent.action.VIEW",
            "-d",
            `https://item.jd.com/${sku}.html`,
            "-p",
            "com.jingdong.app.mall",
          ]),
      );
      navigated = true;
    }
    let main = navigated
      ? await navigationSession.wait("main", androidProductMainReady, {
          timeoutMs: 15000,
          maxObservations: 30,
        })
      : await dump("main");
    if (!variantProof) {
      const proven = await navigateKnownVariant(
        store,
        shop,
        sku,
        navigationSession,
        main,
        receiveVariantProof,
      );
      if (!proven || !variantProof)
        throw new PipelineError(
          "NEEDS_INPUT",
          "手机规格面板未能绑定任务SKU与完整已选规格",
        );
      main = await dump("main");
      checkAndroid(main);
    }
    // An existing product activity may retain its scroll; use its observed return-to-top control.
    const top = androidNodes(main).find((n) =>
      /返回顶部/.test(n["content-desc"] || n.text || ""),
    );
    if (top) {
      await tap(top);
      main = await dump("main");
      checkAndroid(main);
    }
    let nodes = androidNodes(main);
    const screen = nodes
      .find(
        (n) =>
          n.bounds?.startsWith("[0,0]") &&
          +n.bounds.match(/\[(\d+),(\d+)\]$/)![2] > 1000,
      )
      ?.bounds.match(/\[(\d+),(\d+)\]$/);
    if (!screen) throw new PipelineError("NEEDS_INPUT", "手机屏幕尺寸未读取");
    await run([
      "shell",
      "input",
      "swipe",
      String(Math.round(+screen[1] / 2)),
      String(Math.round(+screen[2] * 0.83)),
      String(Math.round(+screen[1] / 2)),
      String(Math.round(+screen[2] * 0.45)),
      "600",
    ]);
    const scrolled = await dump("scrolled");
    checkAndroid(scrolled);
    nodes = androidNodes(scrolled);
    await tap(
      nodes.find(
        (n) => n["resource-id"] === "com.jd.lib.productdetail.feature:id/aod",
      ),
    );
    const details = await navigationSession.wait("details", (xml) => {
      const texts = androidNodes(xml).map((node) => node.text);
      const index = texts.indexOf("商品编号");
      return index >= 0 && texts[index + 1] === sku;
    });
    if (options.factsOnly) {
      let product = parseAndroidProduct(sku, main, details);
      const firstVariant = androidNodes(main).find((n) =>
        /^已选中款式 /.test(n["content-desc"] || n.text || ""),
      );
      if (
        (firstVariant?.["content-desc"] || firstVariant?.text || "").replace(
          /^已选中款式 /,
          "",
        ) !== product.specs["京东销售规格"].value
      )
        throw new PipelineError(
          "NEEDS_INPUT",
          "采集期间手机规格发生变化，保留证据待重新核验",
        );
      if (variantProof.caption !== product.specs["京东销售规格"].value)
        throw new PipelineError(
          "NEEDS_INPUT",
          "规格面板证明与商品页所选规格不一致",
        );
      product = await completeAndroid(
        store,
        shop,
        root,
        navigationSession,
        product,
        main,
        options,
        details,
      );
      product.specs["京东销售规格"] = {
        value: variantProof.caption,
        sourceUrl: product.url,
        capturedAt: product.capturedAt,
        evidence: `安卓京东原生规格面板：编号 ${variantProof.sku}；唯一已选规格`,
      };
      const receiptPath = resolve(dir, "facts-only-receipt.json");
      await writeFile(
        receiptPath,
        JSON.stringify(
          {
            source: "android",
            mode: "facts-only",
            serial,
            sku,
            at: product.capturedAt,
            product,
          },
          null,
          2,
        ),
        { mode: 0o600 },
      );
      return product;
    }
    const returnTop = androidNodes(details).find((n) =>
      /返回顶部/.test(n["content-desc"] || n.text || ""),
    );
    await tap(returnTop);
    const finalMain = await dump("final-main");
    let product = parseAndroidProduct(sku, finalMain, details);
    const firstVariant = androidNodes(main).find((n) =>
      /^已选中款式 /.test(n["content-desc"] || n.text || ""),
    );
    if (
      (firstVariant?.["content-desc"] || firstVariant?.text || "").replace(
        /^已选中款式 /,
        "",
      ) !== product.specs["京东销售规格"].value
    )
      throw new PipelineError(
        "NEEDS_INPUT",
        "采集期间手机规格发生变化，保留证据待重新核验",
      );
    product = await completeAndroid(
      store,
      shop,
      root,
      new AndroidSession(serial, dir, () =>
        new JdTraffic(store, shop, undefined, "android").assertRunning(),
      ),
      product,
      finalMain,
      options,
    );
    product.specs["京东销售规格"] = {
      value: variantProof.caption,
      sourceUrl: product.url,
      capturedAt: product.capturedAt,
      evidence: `安卓京东原生规格面板：编号 ${variantProof.sku}；唯一已选规格`,
    };
    const priceOnly = options.priceOnly === true;
    const receiptPath = resolve(
      dir,
      priceOnly ? "price-only-receipt.json" : "receipt.json",
    );
    const receipt = priceOnly
      ? {
          source: "android",
          mode: "price-only",
          serial,
          sku,
          at: product.capturedAt,
          product,
        }
      : {
          source: "android",
          serial,
          sku,
          at: product.capturedAt,
          product,
          missing: androidMissing(product),
        };
    await writeFile(receiptPath, JSON.stringify(receipt, null, 2), {
      mode: 0o600,
    });
    if (priceOnly) return product;
    store.setMeta("android-last:" + shop, {
      sku,
      at: product.capturedAt,
      receipt: receiptPath,
      status: androidMissing(product).length ? "partial" : "ready",
    });
    store.setMeta("android-open:" + shop, null);
    return product;
  } catch (e) {
    if (
      e instanceof PipelineError &&
      ["RATE_LIMITED", "AUTH_REQUIRED"].includes(e.code)
    ) {
      new JdTraffic(store, shop, undefined, "android").pauseAccount(
        e.code as "RATE_LIMITED" | "AUTH_REQUIRED",
        e.message,
      );
      if (e.code === "RATE_LIMITED")
        new JdTraffic(store, shop, undefined, "android").risk(e.message);
    }
    if (!options.factsOnly)
      store.setMeta("android-last:" + shop, {
        sku,
        at: new Date().toISOString(),
        status: "blocked",
        error: e instanceof Error ? e.message : String(e),
        evidence: dir,
      });
    throw e;
  }
}

export async function collectAndroid(
  store: Store,
  shop: string,
  root: string,
  serial: string,
  sku: string,
  options: AndroidCollectOptions = {},
) {
  validateAndroidCollectOptions(options);
  return new JdTraffic(store, shop, undefined, "android").exclusive(
    "android",
    () => collectAndroidInternal(store, shop, root, serial, sku, options),
  );
}
