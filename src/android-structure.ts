import { androidNodes } from "./android.js";
import { PipelineError, type Product } from "./model.js";
export type AndroidNode = Record<string, string> & { children: AndroidNode[] };
export function androidTree(xml: string): AndroidNode {
  const root = { children: [] } as unknown as AndroidNode,
    stack = [root];
  for (const m of xml.matchAll(/<node\b[^>]*>|<\/node>/g)) {
    if (m[0] === "</node>") {
      if (stack.length > 1) stack.pop();
      continue;
    }
    const n = {
      ...androidNodes(m[0])[0],
      children: [],
    } as unknown as AndroidNode;
    stack.at(-1)!.children.push(n);
    if (!m[0].endsWith("/>")) stack.push(n);
  }
  return root;
}
export function descendants(node: AndroidNode): AndroidNode[] {
  return node.children.flatMap((n) => [n, ...descendants(n)]);
}
export function detailImageNodes(xml: string) {
  const all = descendants(androidTree(xml));
  const intro = all.find((n) => n["resource-id"] === "IntroductionModule");
  if (!intro) throw new PipelineError("NEEDS_INPUT", "手机详情图片区域未识别");
  const container = descendants(intro).find(
    (n) => n["resource-id"] === "scale-wei2-wd",
  );
  if (!container)
    throw new PipelineError("NEEDS_INPUT", "手机详情图片结构未适配");
  // Actual JD layout: blank TextView leaves in the introduction, one per original image.
  return descendants(container).filter(
    (n) =>
      n.class === "android.widget.TextView" &&
      !n.text &&
      !n["content-desc"] &&
      !n["resource-id"] &&
      !n.children.length,
  );
}
export function bounds(n: Record<string, unknown>) {
  const m = String(n.bounds).match(/^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$/);
  if (!m) return null;
  const [x, y, right, bottom] = m.slice(1).map(Number);
  return right > x && bottom > y ? { x, y, right, bottom } : null;
}
export type OcrLine = {
  text: string;
  confidence: number;
  x: number;
  y: number;
  width: number;
  height: number;
};
export type AndroidOfferPrice = {
  value: string;
  basis: "subsidy" | "jd-price";
  label: "日常价" | "京东价" | "补贴价";
};
export function priceFromOffer(lines: OcrLine[]): AndroidOfferPrice | null {
  const clean = lines.filter((l) => l.confidence >= 0.85);
  if (
    !(
      clean.some((l) => l.text === "优惠") ||
      (clean.some((l) => l.text === "已享受优惠") &&
        clean.some((l) => l.text === "可再享优惠"))
    ) ||
    !lines.some((l) => l.text.includes("到手价"))
  )
    return null;
  const tierQuote = (
    entries: ReadonlyArray<
      readonly [AndroidOfferPrice["label"], AndroidOfferPrice["basis"]]
    >,
  ): { present: boolean; quote: AndroidOfferPrice | null } => {
    const labels = entries.flatMap(([label, basis]) =>
      clean
        .filter((line) => line.text === label)
        .map((line) => ({ line, label, basis })),
    );
    const candidates = labels.flatMap(({ line: labelLine, label, basis }) =>
      [labelLine].flatMap((labelLine) => {
        const amounts = [
          ...new Set(
            lines
              .filter(
                (line) =>
                  line.confidence >= 0.5 &&
                  line.y + line.height <= labelLine.y + 0.01 &&
                  labelLine.y - (line.y + line.height) < 0.035 &&
                  line.x <= labelLine.x + labelLine.width &&
                  line.x + line.width >= labelLine.x &&
                  /^[=＝]?\s*[¥￥Y]\s*\d+(?:\.\d{1,2})?$/.test(
                    line.text.trim(),
                  ),
              )
              .map((line) => line.text.match(/\d+(?:\.\d{1,2})?/)![0]),
          ),
        ];
        return amounts.map((value) => ({ value, basis, label }));
      }),
    );
    if (!labels.length) return { present: false, quote: null };
    if (!candidates.length) return { present: true, quote: null };
    const values = new Set(
      candidates
        .filter((candidate) => Number(candidate.value) > 0)
        .map((candidate) => String(Number(candidate.value))),
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
  return regular.present
    ? regular.quote
    : tierQuote([["补贴价", "subsidy"]]).quote;
}
export function androidMissing(p: Product) {
  const missing: string[] = [];
  if (!p.price?.basis) missing.push("明确补贴价或京东价");
  if (p.assets.filter((a) => a.role === "main").length < 3)
    missing.push("至少3张商品主图原文件");
  if (!p.assets.some((a) => a.role === "detail"))
    missing.push("商品详情原文件");
  for (const key of ["商品毛重", "包装名称", "包装数量", "来源店铺"])
    if (!p.specs[key]) missing.push(key);
  if (!p.specs["手机原图完整性"]) missing.push("主图及详情图完整性核验");
  return missing;
}
