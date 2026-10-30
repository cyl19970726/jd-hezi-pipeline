import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import sharp from "sharp";
import { readOfferPrice } from "../src/android-ocr.js";
import type { OcrLine } from "../src/android-structure.js";

const line = (
  text: string,
  confidence: number,
  x: number,
  y: number,
  width = 0.1,
  height = 0.02,
): OcrLine => ({ text, confidence, x, y, width, height });

test("anchored refinements recover only a confidence-qualified labelled JD price", async () => {
  const dir = await mkdtemp(resolve(tmpdir(), "hezi-offer-ocr-"));
  try {
    const image = resolve(dir, "offer.png");
    await sharp({
      create: { width: 1080, height: 2400, channels: 3, background: "white" },
    })
      .png()
      .toFile(image);
    const visited: string[] = [];
    const result = await readOfferPrice(image, async (path) => {
      visited.push(path);
      if (path.endsWith(".offer-context.png"))
        return [line("到手价", 1, 0.6, 0.45, 0.2, 0.2)];
      if (path.endsWith(".price.png"))
        return [line("¥19.9", 0.5, 0.3, 0.2, 0.4, 0.3)];
      return [
        line("优惠", 1, 0.43, 0.26),
        line("已享受优惠", 1, 0.05, 0.31, 0.18),
        line("可再享优惠", 1, 0.29, 0.31, 0.18),
        line("¥15，国手价", 0.3, 0.36, 0.37, 0.26, 0.03),
        line("= ¥19.9", 0.3, 0.2, 0.456, 0.17),
        line("京东价", 1, 0.25, 0.481, 0.09, 0.013),
      ];
    });
    assert.deepEqual(result, {
      value: "19.9",
      basis: "jd-price",
      label: "京东价",
    });
    assert.ok(visited.some((path) => path.endsWith(".offer-context.png")));
    assert.ok(visited.some((path) => path.endsWith(".price.png")));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("anchored refinements recognize a daily-price label and preserve it", async () => {
  const dir = await mkdtemp(resolve(tmpdir(), "hezi-offer-ocr-"));
  try {
    const image = resolve(dir, "offer.png");
    await sharp({
      create: { width: 1080, height: 2400, channels: 3, background: "white" },
    })
      .png()
      .toFile(image);
    const visited: string[] = [];
    const result = await readOfferPrice(image, async (path) => {
      visited.push(path);
      if (path.endsWith(".offer-context.png"))
        return [line("到手价", 1, 0.6, 0.45, 0.2, 0.2)];
      if (path.endsWith(".price.png"))
        return [line("¥21.9", 0.5, 0.3, 0.2, 0.4, 0.3)];
      return [
        line("优惠", 1, 0.43, 0.26),
        line("日常价", 1, 0.25, 0.481, 0.09, 0.013),
      ];
    });
    assert.deepEqual(result, {
      value: "21.9",
      basis: "jd-price",
      label: "日常价",
    });
    assert.ok(visited.some((path) => path.endsWith(".price.png")));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("refinement never accepts a low-confidence amount", async () => {
  const dir = await mkdtemp(resolve(tmpdir(), "hezi-offer-ocr-"));
  try {
    const image = resolve(dir, "offer.png");
    await sharp({
      create: { width: 1080, height: 2400, channels: 3, background: "white" },
    })
      .png()
      .toFile(image);
    const result = await readOfferPrice(image, async (path) => {
      if (path.endsWith(".offer-context.png"))
        return [line("到手价", 1, 0.6, 0.45)];
      if (path.endsWith(".price.png"))
        return [line("¥19.9", 0.49, 0.3, 0.2, 0.4, 0.3)];
      return [
        line("优惠", 1, 0.43, 0.26),
        line("京东价", 1, 0.25, 0.481, 0.09, 0.013),
      ];
    });
    assert.equal(result, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("bounded soft fallback recovers a labelled amount without price arithmetic", async () => {
  const dir = await mkdtemp(resolve(tmpdir(), "hezi-offer-ocr-"));
  try {
    const image = resolve(dir, "offer.png");
    await sharp({
      create: { width: 1080, height: 2400, channels: 3, background: "white" },
    })
      .png()
      .toFile(image);
    const visited: string[] = [];
    const result = await readOfferPrice(image, async (path) => {
      visited.push(path);
      if (path.endsWith(".offer-context.png"))
        return [line("到手价", 1, 0.6, 0.45)];
      if (path.endsWith(".price.png"))
        return [line("¥9.9", 0.3, 0.4, 0.2, 0.3, 0.3)];
      if (path.endsWith(".price-fallback-1.png"))
        return [line("¥9.9", 0.5, 0.4, 0.2, 0.3, 0.3)];
      return [
        line("优惠", 1, 0.43, 0.26),
        line("= ¥9.9 - 促销¥1", 0.3, 0.32, 0.456, 0.35),
        line("京东价", 1, 0.38, 0.481, 0.09, 0.013),
      ];
    });
    assert.deepEqual(result, {
      value: "9.9",
      basis: "jd-price",
      label: "京东价",
    });
    assert.ok(visited.some((path) => path.endsWith(".price-fallback-1.png")));
    assert.equal(
      visited.some((path) => path.endsWith(".price-fallback-2.png")),
      false,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("qualified ambiguity does not invoke fallback or choose an amount", async () => {
  const dir = await mkdtemp(resolve(tmpdir(), "hezi-offer-ocr-"));
  try {
    const image = resolve(dir, "offer.png");
    await sharp({
      create: { width: 1080, height: 2400, channels: 3, background: "white" },
    })
      .png()
      .toFile(image);
    const visited: string[] = [];
    const result = await readOfferPrice(image, async (path) => {
      visited.push(path);
      if (path.endsWith(".offer-context.png"))
        return [line("到手价", 1, 0.6, 0.45)];
      if (path.endsWith(".price.png"))
        return [
          line("¥9.9", 0.5, 0.3, 0.2, 0.25, 0.3),
          line("¥8.9", 0.5, 0.3, 0.2, 0.25, 0.3),
        ];
      return [
        line("优惠", 1, 0.43, 0.26),
        line("京东价", 1, 0.38, 0.481, 0.09, 0.013),
      ];
    });
    assert.equal(result, null);
    assert.equal(
      visited.some((path) => path.includes("price-fallback")),
      false,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("fallback never accepts an unlabelled amount", async () => {
  const dir = await mkdtemp(resolve(tmpdir(), "hezi-offer-ocr-"));
  try {
    const image = resolve(dir, "offer.png");
    await sharp({
      create: { width: 1080, height: 2400, channels: 3, background: "white" },
    })
      .png()
      .toFile(image);
    const result = await readOfferPrice(image, async (path) => {
      if (path.endsWith(".offer-context.png"))
        return [line("到手价", 1, 0.6, 0.45)];
      if (path.endsWith(".price.png"))
        return [line("9.9", 0.3, 0.4, 0.2, 0.3, 0.3)];
      return [line("优惠", 1, 0.43, 0.26)];
    });
    assert.equal(result, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("fallback never accepts arithmetic or a malformed amount", async () => {
  const dir = await mkdtemp(resolve(tmpdir(), "hezi-offer-ocr-"));
  try {
    const image = resolve(dir, "offer.png");
    await sharp({
      create: { width: 1080, height: 2400, channels: 3, background: "white" },
    })
      .png()
      .toFile(image);
    const result = await readOfferPrice(image, async (path) => {
      if (path.endsWith(".offer-context.png"))
        return [line("到手价", 1, 0.6, 0.45)];
      if (path.endsWith(".price.png"))
        return [line("¥9.9", 0.3, 0.4, 0.2, 0.3, 0.3)];
      if (path.includes("price-fallback"))
        return [line("= ¥9.9 - ¥1", 1, 0.4, 0.2, 0.3, 0.3)];
      return [
        line("优惠", 1, 0.43, 0.26),
        line("京东价", 1, 0.38, 0.481, 0.09, 0.013),
      ];
    });
    assert.equal(result, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
