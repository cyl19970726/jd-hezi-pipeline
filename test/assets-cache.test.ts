import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { example } from "../src/demo.js";
import { downloadAssets } from "../src/assets.js";
test("a fresh extraction reuses URL cache and original download bytes are preserved", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hezi-cache-"));
  const originalFetch = globalThis.fetch;
  let requests = 0;
  try {
    const bytes = await sharp({
      create: { width: 120, height: 120, channels: 3, background: "#ff5500" },
    })
      .png()
      .toBuffer();
    globalThis.fetch = (async () => {
      requests++;
      return new Response(bytes, { headers: { "content-type": "image/png" } });
    }) as typeof fetch;
    const p = {
      ...example().product,
      assets: [
        {
          role: "detail" as const,
          url: "https://img.360buyimg.com/test.png",
          order: 0,
        },
      ],
    };
    const first = await downloadAssets(p, dir);
    assert.deepEqual(await readFile(first.assets[0].originalPath!), bytes);
    const second = await downloadAssets(
      { ...p, assets: [{ ...p.assets[0], order: 7 }] },
      dir,
    );
    assert.equal(requests, 1);
    assert.equal(second.assets[0].sha256, first.assets[0].sha256);
    assert.equal(second.assets[0].order, 7);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(dir, { recursive: true, force: true });
  }
});

test("asset HTTP failures preserve Retry-After for the traffic gate", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hezi-cache-retry-"));
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () =>
      new Response("limited", {
        status: 429,
        headers: { "Retry-After": "17" },
      })) as typeof fetch;
    const p = {
      ...example().product,
      assets: [
        {
          role: "detail" as const,
          url: "https://img.360buyimg.com/retry.png",
          order: 0,
        },
      ],
    };
    await assert.rejects(
      () => downloadAssets(p, dir),
      (error: any) =>
        error.details.httpStatus === 429 && error.details.retryAfter === "17",
    );
  } finally {
    globalThis.fetch = originalFetch;
    await rm(dir, { recursive: true, force: true });
  }
});

test("Android album originals are imported locally, verified on resume and never fetched as page URLs", async () => {
  const { importOriginalAsset } = await import("../src/assets.js");
  const { writeFile } = await import("node:fs/promises");
  const dir = await mkdtemp(join(tmpdir(), "hezi-android-assets-"));
  const oldFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () => {
      throw Error("must not fetch");
    }) as typeof fetch;
    const p = example().product;
    const bytes = await sharp({
      create: { width: 750, height: 750, channels: 3, background: "#ffee22" },
    })
      .png()
      .toBuffer();
    const asset = await importOriginalAsset(
      p.sku,
      {
        role: "main",
        order: 0,
        origin: "android-album",
        url: p.url + "#android-main-0-test",
      },
      bytes,
      dir,
    );
    const result = await downloadAssets({ ...p, assets: [asset] }, dir);
    assert.deepEqual(await readFile(result.assets[0].originalPath!), bytes);
    await assert.rejects(
      () => downloadAssets({ ...p, sku: "999", assets: [asset] }, dir),
      /SKU/,
    );
    await writeFile(asset.originalPath!, "tampered");
    await assert.rejects(
      () => downloadAssets({ ...p, assets: [asset] }, dir),
      /已变化/,
    );
  } finally {
    globalThis.fetch = oldFetch;
    await rm(dir, { recursive: true, force: true });
  }
});

test("short detail banners preserve dimensions and original bytes while tiny assets and short main images fail", async () => {
  const { importOriginalAsset } = await import("../src/assets.js");
  const dir = await mkdtemp(join(tmpdir(), "hezi-detail-banner-"));
  try {
    const bytes = await sharp({
      create: { width: 790, height: 84, channels: 3, background: "#ffee22" },
    })
      .png()
      .toBuffer();
    const source = {
      role: "detail" as const,
      order: 3,
      url: "https://img.360buyimg.com/banner.png",
    };
    const asset = await importOriginalAsset("123456", source, bytes, dir);
    assert.equal(asset.width, 790);
    assert.equal(asset.height, 84);
    assert.equal(asset.order, 3);
    const product = { ...example().product, assets: [asset] };
    await downloadAssets(product, dir);
    await assert.rejects(
      () =>
        downloadAssets(
          { ...product, assets: [{ ...asset, role: "main" }] },
          dir,
        ),
      /图片尺寸过小/,
    );
    await assert.rejects(
      () =>
        downloadAssets(
          { ...product, assets: [{ ...source, role: "main" }] },
          dir,
        ),
      /图片尺寸过小/,
    );
    assert.deepEqual(await readFile(asset.originalPath!), bytes);
    await assert.rejects(
      () =>
        importOriginalAsset("123456", { ...source, role: "main" }, bytes, dir),
      /图片尺寸过小/,
    );
    const tiny = await sharp({
      create: { width: 1, height: 1, channels: 3, background: "#fff" },
    })
      .png()
      .toBuffer();
    await assert.rejects(
      () => importOriginalAsset("123456", source, tiny, dir),
      /图片尺寸过小/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
