import { AndroidSession } from "./android-session.js";
import { androidNodes } from "./android.js";
import { PipelineError } from "./model.js";
import { Store } from "./store.js";
import { JdTraffic } from "./jd-traffic.js";
import {
  androidVariantProof,
  type AndroidVariantProof,
} from "./android-variant-proof.js";
export function variantOption(xml: string, caption: string) {
  const nodes = androidNodes(xml),
    start = nodes.findIndex((n) => /^规格\(\d+\)$/.test(n.text || ""));
  if (start < 0 || caption.length < 8) return null;
  const candidates = nodes
    .slice(start + 1)
    .filter((n) => n.text === caption || n.text?.startsWith(caption));
  return candidates.length === 1 ? candidates[0] : null;
}
export function stableVariantOption(
  firstXml: string,
  secondXml: string,
  caption: string,
) {
  const first = variantOption(firstXml, caption);
  const second = variantOption(secondXml, caption);
  const firstSku = androidNodes(firstXml).flatMap((n) => {
    const match = n.text?.match(/^编号:\s*(\d+)$/);
    return match ? [match[1]] : [];
  });
  let stableSelection = false;
  try {
    stableSelection =
      firstSku.length === 1 &&
      androidVariantProof(firstXml, firstSku[0]).caption ===
        androidVariantProof(secondXml, firstSku[0]).caption;
  } catch {
    stableSelection = false;
  }
  if (!stableSelection)
    throw new PipelineError(
      "NEEDS_INPUT",
      "手机规格面板仍在变化，未执行规格点击",
    );
  if (!first && !second) return null;
  if (
    !first ||
    !second ||
    first.text !== second.text ||
    first.bounds !== second.bounds
  )
    throw new PipelineError(
      "NEEDS_INPUT",
      "手机规格面板仍在变化，未执行规格点击",
    );
  return second;
}
/** Reuse the current app product or a previously identified sibling SKU; always confirm the numeric SKU. */
export async function navigateKnownVariant(
  store: Store,
  shop: string,
  sku: string,
  session: AndroidSession,
  current: string,
  onProof?: (proof: AndroidVariantProof) => void,
) {
  let xml = current;
  if (!androidNodes(xml).some((n) => /^编号:\s*\d+$/.test(n.text || ""))) {
    const all = androidNodes(xml).find((n) =>
      /^共\d+款$/.test(n["content-desc"] || ""),
    );
    if (!all) return false;
    await session.tap(all);
    xml = await session.wait(
      "variant-options",
      (x) => androidNodes(x).some((n) => /^编号:\s*\d+$/.test(n.text || "")),
      { timeoutMs: 15000, maxObservations: 30 },
    );
  }
  const isTarget = (x: string) =>
    androidNodes(x).some((n) =>
      new RegExp("^编号:\\s*" + sku + "$").test(n.text || ""),
    );
  if (!isTarget(xml)) {
    const expected = store.list().find((r) => r.shop === shop && r.sku === sku)
      ?.product?.specs["京东销售规格"]?.value;
    if (!expected) {
      await session.run(["shell", "input", "keyevent", "4"]);
      await session.dump("variant-cancelled");
      return false;
    }
    const stableXml = await session.dump("variant-options-stable");
    const option = stableVariantOption(xml, stableXml, expected);
    if (!option) {
      await session.run(["shell", "input", "keyevent", "4"]);
      await session.dump("variant-cancelled");
      return false;
    }
    xml = stableXml;
    store.setMeta("android-open:" + shop, {
      sku,
      at: new Date().toISOString(),
    });
    await new JdTraffic(store, shop, undefined, "android").navigate(
      `https://item.jd.com/${sku}.html`,
      () => session.tap(option),
    );
    xml = await session.wait("variant-confirmed", isTarget);
    if (!isTarget(xml))
      throw new PipelineError("NEEDS_INPUT", "手机所选规格编号不符");
  }
  if (onProof) onProof(androidVariantProof(xml, sku));
  const close = androidNodes(xml).filter(
    (n) => n["content-desc"] === "关闭按钮" && n.clickable === "true",
  );
  if (close.length === 1) await session.tap(close[0]);
  else if (close.length > 1)
    throw new PipelineError("NEEDS_INPUT", "规格面板关闭按钮不唯一");
  else await session.run(["shell", "input", "keyevent", "4"]);
  await session.wait("variant-closed", (x) =>
    androidNodes(x).some((n) => /^已选中款式 /.test(n["content-desc"] || "")),
  );
  return true;
}
