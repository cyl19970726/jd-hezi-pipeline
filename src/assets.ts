import sharp from "sharp";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { PipelineError, type Product } from "./model.js";

export interface AssetNetworkContext {
  sku: string;
  role: "main" | "detail";
  order: number;
  url: string;
}
export type AssetDownloadMetric = AssetNetworkContext &
  (
    | { kind: "cache-hit"; source: "provided" | "url-cache"; bytes: 0 }
    | { kind: "download"; source: "network"; bytes: number }
  );
export interface AssetDownloadPolicy {
  /** Wraps fetch plus complete response-body consumption in a caller-owned gate. */
  runNetwork?<T>(
    context: AssetNetworkContext,
    operation: () => Promise<T>,
  ): Promise<T>;
  onMetric?(metric: AssetDownloadMetric): void | Promise<void>;
}

export async function downloadAssets(
  product: Product,
  root: string,
  policy: AssetDownloadPolicy = {},
): Promise<Product> {
  const assets: Product["assets"] = [];
  for (const asset of product.assets) {
    if (asset.origin === "android-album") {
      const u = new URL(asset.url);
      if (
        u.origin !== "https://item.jd.com" ||
        u.pathname !== `/${product.sku}.html` ||
        !u.hash.startsWith("#android-")
      )
        throw new PipelineError(
          "VALIDATION_MISSING",
          "手机原图与商品SKU不一致",
        );
      if (!asset.originalPath || !asset.originalSha256 || !asset.path)
        throw new PipelineError("VALIDATION_MISSING", "手机原文件证据不完整");
      const bytes = await readFile(asset.originalPath);
      if (
        createHash("sha256").update(bytes).digest("hex") !==
        asset.originalSha256
      )
        throw new PipelineError("VALIDATION_MISSING", "手机原文件已变化");
      await verifyLocalAssets({ ...product, assets: [asset] });
      assets.push(asset);
      await policy.onMetric?.({
        kind: "cache-hit",
        source: "provided",
        bytes: 0,
        sku: product.sku,
        role: asset.role,
        order: asset.order,
        url: asset.url,
      });
      continue;
    }
    const url = new URL(asset.url);
    if (
      url.protocol !== "https:" ||
      !/(^|\.)(360buyimg\.com|jd\.com)$/.test(url.hostname)
    )
      throw new PipelineError(
        "NEEDS_INPUT",
        "图片 URL 不是已支持的京东 HTTPS 图片域名",
      );
    const cacheDir = resolve(root, ".url-cache");
    await mkdir(cacheDir, { recursive: true, mode: 0o700 });
    const cacheFile = resolve(
      cacheDir,
      createHash("sha256").update(url.href).digest("hex") + ".json",
    );
    const remember = async (value: Product["assets"][number]) => {
      const tmp = cacheFile + "." + randomUUID() + ".tmp";
      await writeFile(tmp, JSON.stringify(value), { mode: 0o600 });
      await rename(tmp, cacheFile);
    };
    if (asset.path && asset.sha256 && asset.width && asset.height) {
      await verifyLocalAssets({ ...product, assets: [asset] });
      await remember(asset);
      assets.push(asset);
      await policy.onMetric?.({
        kind: "cache-hit",
        source: "provided",
        bytes: 0,
        sku: product.sku,
        role: asset.role,
        order: asset.order,
        url: asset.url,
      });
      continue;
    }
    const cached = await readFile(cacheFile, "utf8")
      .then((x) => JSON.parse(x))
      .catch((e) => {
        if (e.code === "ENOENT") return null;
        throw e;
      });
    if (cached?.url === asset.url) {
      await verifyLocalAssets({
        ...product,
        assets: [{ ...cached, role: asset.role, order: asset.order }],
      });
      assets.push({ ...cached, role: asset.role, order: asset.order });
      await policy.onMetric?.({
        kind: "cache-hit",
        source: "url-cache",
        bytes: 0,
        sku: product.sku,
        role: asset.role,
        order: asset.order,
        url: asset.url,
      });
      continue;
    }
    const context: AssetNetworkContext = {
      sku: product.sku,
      role: asset.role,
      order: asset.order,
      url: asset.url,
    };
    const readNetwork = async () => {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(30000),
        redirect: "error",
      });
      if (!response.ok)
        throw new PipelineError(
          "NEEDS_INPUT",
          `图片下载失败：HTTP ${response.status}`,
          {
            httpStatus: response.status,
            retryAfter: response.headers.get("Retry-After"),
          },
        );
      if (Number(response.headers.get("content-length")) > 30 * 1024 * 1024)
        throw new PipelineError("NEEDS_INPUT", "图片超过30MB下载保护限额");
      if (!response.body)
        throw new PipelineError("NEEDS_INPUT", "图片下载响应缺少内容");
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 30 * 1024 * 1024) {
          await reader.cancel();
          throw new PipelineError("NEEDS_INPUT", "图片超过30MB下载保护限额");
        }
        chunks.push(value);
      }
      return Buffer.concat(chunks);
    };
    const original = policy.runNetwork
      ? await policy.runNetwork(context, readNetwork)
      : await readNetwork();
    const saved = await importOriginalAsset(product.sku, asset, original, root);
    await remember(saved);
    await policy.onMetric?.({
      ...context,
      kind: "download",
      source: "network",
      bytes: original.length,
    });
    assets.push(saved);
  }
  return { ...product, assets };
}
export async function verifyLocalAssets(product: Product) {
  for (const a of product.assets) {
    if (!a.path || !a.sha256)
      throw new PipelineError("VALIDATION_MISSING", "缺少图片文件或校验值");
    const bytes = await readFile(a.path);
    if (bytes.length > 5 * 1024 * 1024)
      throw new PipelineError("VALIDATION_MISSING", "图片超过平台5MB限制");
    if (createHash("sha256").update(bytes).digest("hex") !== a.sha256)
      throw new PipelineError(
        "VALIDATION_MISSING",
        "本地图片内容已变化：" + a.path,
      );
    const m = await sharp(bytes).metadata();
    assertAssetDimensions(a.role, m.width, m.height);
    if (m.width !== a.width || m.height !== a.height)
      throw new PipelineError("VALIDATION_MISSING", "本地图片尺寸与清单不一致");
  }
}

export async function importOriginalAsset(
  sku: string,
  asset: Product["assets"][number],
  original: Buffer,
  root: string,
): Promise<Product["assets"][number]> {
  if (original.length > 30 * 1024 * 1024)
    throw new PipelineError("NEEDS_INPUT", "图片超过30MB保护限额");
  const meta = await sharp(original, {
    limitInputPixels: 100_000_000,
  }).metadata();
  assertAssetDimensions(asset.role, meta.width, meta.height);
  const originalSha256 = createHash("sha256").update(original).digest("hex");
  const originalDir = resolve(root, sku, "originals");
  await mkdir(originalDir, { recursive: true, mode: 0o700 });
  const originalPath = resolve(originalDir, originalSha256 + "." + meta.format);
  await writeFile(originalPath, original, { mode: 0o600 });
  const buffer = await sharp(original, { limitInputPixels: 100_000_000 })
    .rotate()
    .flatten({ background: "#fff" })
    .jpeg({ quality: 95, mozjpeg: true })
    .toBuffer();
  if (buffer.length > 5 * 1024 * 1024)
    throw new PipelineError(
      "NEEDS_INPUT",
      "转换后图片超过平台5MB限制，需要审核后压缩或拆分",
    );
  const converted = await sharp(buffer).metadata();
  const sha256 = createHash("sha256").update(buffer).digest("hex");
  const dir = resolve(root, sku, asset.role);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const path = resolve(
    dir,
    `${String(asset.order).padStart(3, "0")}-${sha256.slice(0, 12)}.jpg`,
  );
  await writeFile(path, buffer, { mode: 0o600 });
  return {
    ...asset,
    path,
    originalPath,
    originalSha256,
    sha256,
    width: converted.width,
    height: converted.height,
  };
}

function assertAssetDimensions(
  role: Product["assets"][number]["role"],
  width?: number,
  height?: number,
) {
  // Detail pages legitimately contain wide, short banners; preserve their source geometry.
  if (!width || !height || width < 100 || (role !== "detail" && height < 100))
    throw new PipelineError("NEEDS_INPUT", "图片尺寸过小，可能误采图标");
}
