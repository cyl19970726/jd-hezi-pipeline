import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { writeFile } from "node:fs/promises";
import sharp from "sharp";
import { type OcrLine, priceFromOffer } from "./android-structure.js";
const exec = promisify(execFile);
export async function ocr(path: string): Promise<OcrLine[]> {
  const result = await exec(
    "/usr/bin/swift",
    [resolve(import.meta.dirname, "../src/native-ocr.swift"), path],
    { timeout: 30000, maxBuffer: 2_000_000 },
  );
  return JSON.parse(result.stdout);
}
export async function readOfferPrice(
  path: string,
  recognize: (path: string) => Promise<OcrLine[]> = ocr,
) {
  const lines = await recognize(path),
    meta = await sharp(path).metadata();
  // Re-read the current-price badge beneath the verified offer header. This crop
  // supplies panel context only; its personalized amount is never a quote.
  const offerHeader = lines.find(
    (l) => l.text === "优惠" && l.confidence >= 0.85,
  );
  if (offerHeader) {
    const left = Math.max(0, Math.floor((offerHeader.x - 0.15) * meta.width!)),
      top = Math.max(0, Math.floor((offerHeader.y + 0.075) * meta.height!)),
      width = Math.min(meta.width! - left, Math.ceil(0.46 * meta.width!)),
      height = Math.min(meta.height! - top, Math.ceil(0.09 * meta.height!)),
      crop = path + ".offer-context.png";
    await sharp(path)
      .extract({ left, top, width, height })
      .resize({ width: width * 5 })
      .png()
      .toFile(crop);
    const refined = await recognize(crop);
    lines.push(
      ...refined.map((l) => ({
        ...l,
        x: (left + l.x * width) / meta.width!,
        y: (top + l.y * height) / meta.height!,
        width: (l.width * width) / meta.width!,
        height: (l.height * height) / meta.height!,
      })),
    );
  }
  const priceLabels = lines.filter(
    (l) =>
      ["日常价", "京东价", "补贴价"].includes(l.text) && l.confidence >= 0.85,
  );
  for (const label of priceLabels) {
    const left = Math.max(0, Math.floor((label.x - 0.09) * meta.width!)),
      top = Math.max(0, Math.floor((label.y - 0.037) * meta.height!));
    const width = Math.min(
        meta.width! - left,
        Math.ceil((label.width + 0.14) * meta.width!),
      ),
      height = Math.ceil(0.035 * meta.height!);
    const crop = path + ".price.png";
    await sharp(path)
      .extract({ left, top, width, height })
      .resize({ width: width * 5 })
      .grayscale()
      .normalize()
      .threshold(150)
      .png()
      .toFile(crop);
    const refined = await recognize(crop);
    lines.push(
      ...refined.map((l) => ({
        ...l,
        x: (left + l.x * width) / meta.width!,
        y: (top + l.y * height) / meta.height!,
        width: (l.width * width) / meta.width!,
        height: (l.height * height) / meta.height!,
      })),
    );
  }
  const boundAmounts = (label: OcrLine, minimumConfidence: number) =>
    lines.filter(
      (line) =>
        line.confidence >= minimumConfidence &&
        line.y + line.height <= label.y + 0.01 &&
        label.y - (line.y + line.height) < 0.035 &&
        line.x <= label.x + label.width &&
        line.x + line.width >= label.x &&
        /^[=＝]?\s*[¥￥Y]\s*\d+(?:\.\d{1,2})?$/.test(line.text.trim()),
    );
  // A fallback is justified only by one high-confidence label and an otherwise
  // correctly positioned numeric amount that missed the existing confidence
  // threshold. Multiple labels or already-qualified amounts remain ambiguous.
  if (
    !priceFromOffer(lines) &&
    priceLabels.length === 1 &&
    boundAmounts(priceLabels[0], 0.5).length === 0 &&
    boundAmounts(priceLabels[0], 0.3).length > 0
  ) {
    const label = priceLabels[0],
      left = Math.max(0, Math.floor((label.x - 0.09) * meta.width!)),
      top = Math.max(0, Math.floor((label.y - 0.045) * meta.height!)),
      width = Math.min(
        meta.width! - left,
        Math.ceil((label.width + 0.14) * meta.width!),
      ),
      height = Math.min(meta.height! - top, Math.ceil(0.05 * meta.height!));
    const variants = [
      (image: ReturnType<typeof sharp>) =>
        image
          .resize({ width: width * 5 })
          .grayscale()
          .normalize(),
      (image: ReturnType<typeof sharp>) =>
        image
          .resize({ width: width * 8 })
          .grayscale()
          .normalize()
          .sharpen(),
    ];
    for (let index = 0; index < variants.length; index++) {
      const crop = path + `.price-fallback-${index + 1}.png`;
      await variants[index](sharp(path).extract({ left, top, width, height }))
        .png()
        .toFile(crop);
      const refined = await recognize(crop);
      lines.push(
        ...refined.map((line) => ({
          ...line,
          x: (left + line.x * width) / meta.width!,
          y: (top + line.y * height) / meta.height!,
          width: (line.width * width) / meta.width!,
          height: (line.height * height) / meta.height!,
        })),
      );
      if (priceFromOffer(lines)) break;
    }
  }
  await writeFile(path + ".ocr.json", JSON.stringify(lines, null, 2), {
    mode: 0o600,
  });
  return priceFromOffer(lines);
}
