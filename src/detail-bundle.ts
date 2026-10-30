import { mkdir, copyFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { verifyLocalAssets } from "./assets.js";
import type { Product } from "./model.js";
const escape = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
/** Offline detail document, built from downloaded assets, never viewport screenshots. */
export async function exportDetail(p: Product, out: string) {
  await verifyLocalAssets(p);
  await mkdir(resolve(out, "images"), { recursive: true, mode: 0o700 });
  const assets = p.assets
    .filter((a) => a.role === "detail")
    .sort((a, b) => a.order - b.order);
  const manifest = [];
  for (const a of assets) {
    const name = `${String(a.order).padStart(3, "0")}-${a.sha256!.slice(0, 12)}.jpg`;
    await copyFile(a.path!, resolve(out, "images", name));
    manifest.push({ ...a, path: "images/" + name });
  }
  const html = `<!doctype html><html lang="zh-CN"><meta charset="UTF-8"><title>${escape(p.title.value)}</title><style>body{max-width:790px;margin:24px auto;font:16px sans-serif}img{display:block;width:100%;height:auto}dt{font-weight:bold}dd{margin-bottom:12px}</style><h1>${escape(p.title.value)}</h1><a href="${escape(p.url)}">京东来源</a><dl>${Object.entries(
    p.specs,
  )
    .map(([k, v]) => `<dt>${escape(k)}</dt><dd>${escape(v.value)}</dd>`)
    .join(
      "",
    )}</dl>${manifest.map((a) => `<img src="${a.path}" alt="商品详情第${a.order + 1}张">`).join("")}</html>`;
  await writeFile(resolve(out, "index.html"), html, { mode: 0o600 });
  await writeFile(
    resolve(out, "manifest.json"),
    JSON.stringify(
      {
        sku: p.sku,
        sourceUrl: p.url,
        capturedAt: p.capturedAt,
        assets: manifest,
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  return {
    path: resolve(out, "index.html"),
    images: assets.length,
    networkRequests: 0,
  };
}
