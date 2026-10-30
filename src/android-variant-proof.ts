import { PipelineError } from "./model.js";

export interface AndroidVariantProof {
  sku: string;
  caption: string;
}

const decode = (value: string) =>
  value
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

function nodes(xml: string) {
  return [...xml.matchAll(/<node\s+([^>]*?)(?:\/?>)/g)].map((match) =>
    Object.fromEntries(
      [...match[1].matchAll(/([\w-]+)="([^"]*)"/g)].map((attribute) => [
        attribute[1],
        decode(attribute[2]),
      ]),
    ),
  );
}

/** Read a complete selected caption only when the native panel binds it to one exact SKU. */
export function androidVariantProof(
  xml: string,
  expectedSku: string,
): AndroidVariantProof {
  if (!/^\d+$/.test(expectedSku))
    throw new PipelineError("NEEDS_INPUT", "手机规格面板目标SKU格式无效");
  const all = nodes(xml);
  const skus = all.flatMap((node) => {
    const match = node.text?.match(/^编号:\s*(\d+)$/);
    return match ? [match[1]] : [];
  });
  if (skus.length !== 1 || skus[0] !== expectedSku)
    throw new PipelineError(
      "NEEDS_INPUT",
      "手机规格面板商品编号不唯一或与任务SKU不符",
    );
  const header = all.findIndex((node) => /^规格\(\d+\)$/.test(node.text || ""));
  const captions = all
    .slice(header + 1)
    .flatMap((node) =>
      header >= 0 &&
      node.selected === "true" &&
      node.class === "android.widget.TextView" &&
      /:id\/a3s$/.test(node["resource-id"] || "") &&
      node.text
        ? [node.text]
        : [],
    );
  if (captions.length !== 1)
    throw new PipelineError(
      "NEEDS_INPUT",
      "手机规格面板已选规格文字不唯一，不能猜测商品",
    );
  return { sku: expectedSku, caption: captions[0] };
}
