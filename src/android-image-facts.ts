import { readFile, writeFile } from "node:fs/promises";
import { ocr } from "./android-ocr.js";
import type { Product } from "./model.js";
export function scentFromImage(
  caption: string,
  lines: string[],
): string | null {
  // Only observed, explicit scent headings agreeing with the selected sales variant.
  const candidates = [
    ["茉莉", "清新茉莉香", "茉莉香"],
    ["茉莉", "茉莉花香", "茉莉花香"],
    ["薄荷", "雨后薄荷香", "薄荷香"],
  ];
  const values = candidates
    .filter(
      ([variant, heading]) =>
        caption.includes(variant) && lines.includes(heading),
    )
    .map(([, , value]) => value);
  return values.length === 1 ? values[0] : null;
}
export async function enrichAndroidImageFacts(
  product: Product,
): Promise<Product> {
  const p = structuredClone(product);
  if (p.specs["香型"]) return p;
  const caption = p.specs["京东销售规格"]?.value ?? "";
  for (const asset of p.assets.filter((a) => a.role === "detail")) {
    if (!asset.originalPath || !asset.originalSha256) continue;
    const cache = asset.originalPath + ".ocr.json";
    let rows = await readFile(cache, "utf8")
      .then((x) => JSON.parse(x))
      .catch((e) => {
        if (e.code === "ENOENT") return null;
        throw e;
      });
    if (!rows) {
      rows = await ocr(asset.originalPath);
      await writeFile(cache, JSON.stringify(rows), { mode: 0o600 });
    }
    const value = scentFromImage(
      caption,
      rows.filter((r: any) => r.confidence >= 0.8).map((r: any) => r.text),
    );
    if (value) {
      p.specs["香型"] = {
        value,
        sourceUrl: p.url,
        capturedAt: p.capturedAt,
        evidence:
          "安卓京东详情原文件的明确香型标题，与所选规格一致；SHA-256 " +
          asset.originalSha256,
      };
      break;
    }
  }
  return p;
}
