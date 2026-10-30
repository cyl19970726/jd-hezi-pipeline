import { enrichAndroidImageFacts } from "./android-image-facts.js";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { AndroidSession, atomicReceipt } from "./android-session.js";
import { androidNodes, parseAndroidProduct } from "./android.js";
import {
  detailImageNodes,
  bounds,
  androidMissing,
} from "./android-structure.js";
import { readOfferPrice } from "./android-ocr.js";
import { money, PipelineError, type Product } from "./model.js";
import { verifyLocalAssets } from "./assets.js";
import { Store } from "./store.js";
import { JdTraffic } from "./jd-traffic.js";
import {
  freshCheckpointTime,
  reusableAndroidShopFact,
  type AndroidShopFact,
} from "./android-checkpoints.js";
import { mainGalleryViewerReady } from "./android-gallery.js";
import { JD_CAPTURE_PARSER } from "./jd-capture.js";
type Capture = {
  version: 1;
  sku: string;
  variant: string;
  at: string;
  main: Product["assets"];
  detail: Product["assets"];
  mainCount?: number;
  detailCount?: number;
  complete?: boolean;
};
export type AndroidCollectOptions = {
  priceOnly?: boolean;
  factsOnly?: boolean;
};

export function validateAndroidCollectOptions(options: AndroidCollectOptions) {
  if (options.priceOnly && options.factsOnly)
    throw new PipelineError(
      "NEEDS_INPUT",
      "手机局部采集不能同时请求核价与补参数",
    );
}

export function requireAndroidPriceOnlyProduct(product: Product): Product {
  if (!product.price || !product.price.basis || !money(product.price.value))
    throw new PipelineError(
      "NEEDS_INPUT",
      "手机核价未读取到明确补贴价或京东价",
    );
  return { ...product, assets: [] };
}

export async function completeAndroid(
  store: Store,
  shop: string,
  root: string,
  session: AndroidSession,
  initial: Product,
  mainXml: string,
  options: AndroidCollectOptions = {},
  detailXml?: string,
) {
  validateAndroidCollectOptions(options);
  let p = structuredClone(initial);
  const checkpointPath = resolve(
    root,
    "android",
    p.sku,
    "media-checkpoint.json",
  );
  const variant = p.specs["京东销售规格"].value;
  let cp: Capture = {
    version: 1,
    sku: p.sku,
    variant,
    at: p.capturedAt,
    main: [],
    detail: [],
  };
  const checkpointKey = "android-capture:" + shop + ":" + p.sku;
  if (!options.priceOnly && !options.factsOnly) {
    const old =
      store.meta(checkpointKey) ??
      (await readFile(checkpointPath, "utf8")
        .then((x) => JSON.parse(x) as Capture)
        .catch((e) => {
          if (e.code === "ENOENT") return null;
          throw e;
        }));
    if (
      old?.version === 1 &&
      old.sku === p.sku &&
      old.variant === variant &&
      freshCheckpointTime(old.at)
    ) {
      await verifyLocalAssets({ ...p, assets: [...old.main, ...old.detail] });
      cp = old;
    }
  }
  const fact = (value: string, evidence: string) => ({
    value,
    sourceUrl: p.url,
    capturedAt: p.capturedAt,
    evidence: "安卓京东：" + evidence,
  });
  const save = async () => {
    store.setMeta(checkpointKey, cp);
    await atomicReceipt(checkpointPath, cp);
    store.setMeta("android-progress:" + shop, {
      sku: p.sku,
      at: new Date().toISOString(),
      main: cp.main.length,
      mainCount: cp.mainCount,
      detail: cp.detail.length,
      detailCount: cp.detailCount,
      complete: cp.complete ?? false,
    });
  };
  const nodes = (xml: string) => androidNodes(xml);
  const top = async () => {
    let xml = await session.dump("before-top");
    const n = nodes(xml).find((n) => n["content-desc"] === "返回顶部");
    if (n) {
      await session.tap(n);
      xml = await session.wait("at-top", (x) =>
        nodes(x).some((n) => /^已选中款式 /.test(n["content-desc"] || "")),
      );
    }
    return xml;
  };
  const checkVariant = (xml: string) => {
    const selected = nodes(xml).find((n) =>
      /^已选中款式 /.test(n["content-desc"] || ""),
    );
    if (selected?.["content-desc"] !== "已选中款式 " + variant)
      throw new PipelineError(
        "NEEDS_INPUT",
        "手机所选规格已改变，原文件保留待核验",
      );
  };
  checkVariant(mainXml);
  const readExpandedFacts = async (xml: string) => {
    await session.tap(nodes(xml).find((n) => n["content-desc"] === "目录"));
    const menu = await session.wait("directory", (x) =>
      nodes(x).some(
        (n) =>
          n.text === "规格参数" &&
          n["resource-id"] === "com.jd.lib.productdetail.feature:id/nd",
      ),
    );
    await session.tap(nodes(menu).find((n) => n.text === "规格参数"));
    await session.dump("directory-jump");
    await session.run(["shell", "input", "keyevent", "4"]);
    xml = await session.dump("specification");
    const expand = nodes(xml).find(
      (n) =>
        n["resource-id"] === "btn-showFullSpecification" && n.text === "展开",
    );
    if (expand && bounds(expand)) {
      await session.tap(expand);
      xml = await session.dump("specification-expanded");
    }
    const texts = nodes(xml)
        .map((n) => n.text)
        .filter(Boolean),
      start = texts.indexOf("商品编号"),
      end = texts.indexOf("店内优选", start);
    if (start < 0 || texts[start + 1] !== p.sku)
      throw new PipelineError(
        "NEEDS_INPUT",
        "展开规格参数的商品编号与任务SKU不符",
      );
    const params = texts.slice(
      Math.max(0, start - 2),
      end < 0 ? undefined : end,
    );
    for (const key of [
      "商品毛重",
      "规格",
      "总净含量",
      "香型",
      "包装形式",
      "适用场景",
      "保质期",
      "农药登记证号",
      "国产/进口",
    ]) {
      const index = params.indexOf(key);
      if (index >= 0 && params[index + 1])
        p.specs[key] = fact(params[index + 1], "展开规格参数 " + key);
    }
    const pack = p.specs["包装清单"]?.value.match(
      /^[【\[]?(.+?)[x×*]\s*(\d+)[】\]]?$/,
    );
    if (pack) {
      p.specs["包装名称"] = fact(pack[1], "包装清单明确品名");
      p.specs["包装数量"] = fact(pack[2], "包装清单明确数量");
    }
    const volume = variant.match(/(\d+(?:\.\d+)?)\s*m[lL]\s*(\d+)瓶/);
    if (volume) {
      p.specs["规格"] = fact(volume[2] + "瓶装", "已选中款式 " + variant);
      p.specs["总净含量"] = fact(
        String(Number(volume[1]) * Number(volume[2])) + "mL",
        "已选中款式 " + variant + "；单瓶净含量×瓶数",
      );
    }
    return xml;
  };

  if (options.factsOnly) {
    if (!detailXml)
      throw new PipelineError("NEEDS_INPUT", "手机补参数缺少已核验详情页");
    const detailTexts = nodes(detailXml).map((n) => n.text);
    const detailSku = detailTexts.indexOf("商品编号");
    if (detailSku < 0 || detailTexts[detailSku + 1] !== p.sku)
      throw new PipelineError("NEEDS_INPUT", "手机详情商品编号与任务SKU不符");
    const xml = await readExpandedFacts(detailXml);
    const finalMain = await top();
    checkVariant(finalMain);
    const verified = parseAndroidProduct(p.sku, finalMain, xml);
    if (verified.title.value !== p.title.value)
      throw new PipelineError("NEEDS_INPUT", "手机采集前后商品标题发生变化");
    p.price = null;
    p.assets = [];
    return p;
  }
  // Read the actual price explanation; an unlabelled crossed-out number is never a price fact.
  if (!p.price) {
    const promo = nodes(mainXml).find((n) =>
      /^已享受：/.test(n["content-desc"] || ""),
    );
    if (promo) {
      const b = bounds(promo)!;
      await session.tap({
        ...promo,
        bounds: `[${Math.max(b.x, b.right - 120)},${b.y}][${b.right},${b.bottom}]`,
      });
      await session.wait(
        "offer",
        (x) => !x.includes("已选中款式") && x.includes("com.jingdong.app.mall"),
      );
      const screenshot = await session.screenshot("offer-evidence");
      const quote = await readOfferPrice(screenshot);
      const bare = nodes(mainXml)
        .filter((n) => /^¥\d+(?:\.\d{1,2})?$/.test(n.text || ""))
        .map((n) => Number(n.text.slice(1)));
      if (quote && bare.includes(Number(quote.value)))
        p.price = {
          ...fact(
            quote.value,
            "优惠说明明确" +
              quote.label +
              "；OCR标签定位并与主页面金额交叉核验；" +
              screenshot,
          ),
          basis: quote.basis,
        };
      await session.run(["shell", "input", "keyevent", "4"]);
      mainXml = await session.wait("offer-closed", (x) =>
        nodes(x).some((n) => /^已选中款式 /.test(n["content-desc"] || "")),
      );
      checkVariant(mainXml);
    }
  }
  if (options.priceOnly) return requireAndroidPriceOnlyProduct(p);
  const shopFactKey = "android-shop-fact:" + shop + ":" + p.sku;
  let shopFact = reusableAndroidShopFact(store.meta(shopFactKey), {
    shop,
    sku: p.sku,
    variant,
    sourceUrl: p.url,
  });
  if (!shopFact) {
    // Only a shop opened through the current product is accepted as the source shop.
    const shopButton = nodes(mainXml).find(
      (n) => n["resource-id"] === "com.jd.lib.productdetail.feature:id/awi",
    );
    await new JdTraffic(store, shop, undefined, "android").navigate(p.url, () =>
      session.tap(shopButton),
    );
    const shopXml = await session.wait("source-shop", (x) =>
      nodes(x).some(
        (n) => n["resource-id"] === "com.jd.lib.jshop.feature:id/jz",
      ),
    );
    const shopName = nodes(shopXml).find(
      (n) => n["resource-id"] === "com.jd.lib.jshop.feature:id/jz",
    )!.text;
    const brand = p.specs["品牌"]?.value.replace(/（.*?）|\(.*?\)/g, "");
    if (
      !brand ||
      !shopName.includes(brand) ||
      !/京东自营旗舰店|官方旗舰店/.test(shopName)
    )
      throw new PipelineError(
        "NEEDS_INPUT",
        "手机来源店铺未确认为本品牌自营或官方旗舰店",
      );
    const observedAt = new Date().toISOString();
    shopFact = {
      version: 1,
      shop,
      sku: p.sku,
      variant,
      shopName,
      sourceUrl: p.url,
      observedAt,
      evidence: "当前商品店铺入口，店铺页名称核验",
    } satisfies AndroidShopFact;
    // Persist immediately after the real observation, before navigating away.
    store.setMeta(shopFactKey, shopFact);
    await session.run(["shell", "input", "keyevent", "4"]);
    mainXml = await session.wait("shop-return", (x) =>
      nodes(x).some((n) => /^已选中款式 /.test(n["content-desc"] || "")),
    );
    checkVariant(mainXml);
  }
  p.specs["来源店铺"] = {
    value: shopFact.shopName,
    sourceUrl: shopFact.sourceUrl,
    capturedAt: shopFact.observedAt,
    evidence: "安卓京东：" + shopFact.evidence,
  };
  if (!cp.complete) {
    const counter = nodes(mainXml).find((n) =>
      /^图集\d+\/\d+$/.test(n.text || ""),
    );
    const count = Number(counter?.text.split("/")[1]);
    if (!count || count > 10)
      throw new PipelineError("NEEDS_INPUT", "手机主图数量不可核验或超过10张");
    if (cp.mainCount && cp.mainCount !== count)
      throw new PipelineError(
        "NEEDS_INPUT",
        "手机主图数量已改变，需复核原断点",
      );
    cp.mainCount = count;
    await save();
    await session.tap(
      nodes(mainXml).find(
        (n) => n["resource-id"] === "com.jingdong.app.mall:id/d9w",
      ),
    );
    for (let i = 0; i < count; i++) {
      await session.wait("main-gallery", (x) =>
        mainGalleryViewerReady(x, i + 1, count, {
          sku: p.sku,
          variant,
          parserVersion: JD_CAPTURE_PARSER,
        }),
      );
      if (!cp.main[i]) {
        cp.main[i] = await session.saveViewer(p.sku, "main", i, root);
        await save();
      }
      if (i + 1 < count)
        await session.run([
          "shell",
          "input",
          "swipe",
          "930",
          "1100",
          "150",
          "1100",
          "500",
        ]);
    }
    await session.run(["shell", "input", "keyevent", "4"]);
    mainXml = await session.wait("main-gallery-closed", (x) =>
      nodes(x).some((n) => /^已选中款式 /.test(n["content-desc"] || "")),
    );
    checkVariant(mainXml);
  }
  await session.run([
    "shell",
    "input",
    "swipe",
    "540",
    "1992",
    "540",
    "1080",
    "600",
  ]);
  let xml = await session.wait("detail-tab", (x) =>
    nodes(x).some(
      (n) => n["resource-id"] === "com.jd.lib.productdetail.feature:id/aod",
    ),
  );
  await session.tap(
    nodes(xml).find(
      (n) => n["resource-id"] === "com.jd.lib.productdetail.feature:id/aod",
    ),
  );
  xml = await session.wait(
    "detail-ready",
    (x) =>
      x.includes("IntroductionModule") &&
      nodes(x).some((n) => n.text === p.sku),
  );
  const detailCount = detailImageNodes(xml).length;
  if (!detailCount || detailCount > 60)
    throw new PipelineError("NEEDS_INPUT", "手机详情图片数量不可核验");
  if (cp.detailCount && cp.detailCount !== detailCount)
    throw new PipelineError(
      "NEEDS_INPUT",
      "手机详情图片数量已变化，需复核断点",
    );
  cp.detailCount = detailCount;
  await save();
  if (!cp.complete) {
    let scrolls = 0;
    for (let i = 0; i < detailCount; i++) {
      if (cp.detail[i]) continue;
      let image = detailImageNodes(xml)[i],
        b = bounds(image);
      while (!b || b.bottom <= 500 || b.bottom - b.y < 120) {
        if (++scrolls > 90)
          throw new PipelineError(
            "NEEDS_INPUT",
            "手机详情滚动达到上限，原图断点已保存",
          );
        await session.run([
          "shell",
          "input",
          "swipe",
          "500",
          "1850",
          "500",
          "1150",
          "600",
        ]);
        xml = await session.dump("detail-scroll");
        image = detailImageNodes(xml)[i];
        b = bounds(image);
      }
      // A TextView leaf represents the image; open it before using the app's original-file export.
      await session.tap({
        ...image,
        bounds: `[${b.x},${Math.max(420, b.y)}][${b.right},${Math.min(2190, b.bottom)}]`,
      });
      await session.wait(
        "detail-viewer",
        (x) =>
          !x.includes("IntroductionModule") &&
          x.includes("com.jingdong.app.mall:id/"),
      );
      cp.detail[i] = await session.saveViewer(p.sku, "detail", i, root);
      await save();
      await session.run(["shell", "input", "keyevent", "4"]);
      xml = await session.wait(
        "detail-return",
        (x) =>
          x.includes("IntroductionModule") &&
          nodes(x).some((n) => n.text === p.sku),
      );
    }
  }
  // Expand the actual parameter section, not recommendation cards.
  xml = await readExpandedFacts(xml);
  const finalMain = await top();
  checkVariant(finalMain);
  const verified = parseAndroidProduct(p.sku, finalMain, xml);
  if (verified.title.value !== p.title.value)
    throw new PipelineError("NEEDS_INPUT", "手机采集前后商品标题发生变化");
  cp.complete =
    cp.main.length === cp.mainCount && cp.detail.length === cp.detailCount;
  await save();
  p.assets = [...cp.main, ...cp.detail];
  p = await enrichAndroidImageFacts(p);
  if (cp.complete)
    p.specs["手机原图完整性"] = fact(
      `主图${cp.mainCount}张；详情${cp.detailCount}张`,
      "App图集计数及商品介绍图片节点逐一对应，保存原文件；" + checkpointPath,
    );
  await atomicReceipt(resolve(session.dir, "complete-receipt.json"), {
    product: p,
    missing: androidMissing(p),
    checkpoint: checkpointPath,
  });
  return p;
}
