import { androidNodes } from "./android.js";
import { PipelineError } from "./model.js";

const DISCOVERY_PREFIX = "com.jd.lib.Discovery.feature:id/";
const MAIN_VIEWER_ROOT = "com.jingdong.app.mall:id/euk";

/** Accepts a main-image page only when it belongs to JD's dedicated image viewer. */
export function mainGalleryViewerReady(
  xml: string,
  position: number,
  count: number,
  identity?: { sku: string; variant: string; parserVersion: string },
) {
  const nodes = androidNodes(xml);
  if (nodes.some((node) => node["resource-id"]?.startsWith(DISCOVERY_PREFIX))) {
    if (!identity)
      throw new PipelineError(
        "NEEDS_INPUT",
        "手机进入京东Discovery轮播故事页，但缺少当前SKU规格证明；已停止主图保存",
      );
    throw new PipelineError(
      "UNSUPPORTED_MEDIA",
      "手机进入京东Discovery轮播故事页，原图入口尚未适配；已停止主图保存并保留进度",
      {
        reason: "discovery-story",
        stage: "main-gallery",
        sku: identity.sku,
        variant: identity.variant,
        parserVersion: identity.parserVersion,
        observedAt: new Date().toISOString(),
      },
    );
  }
  if (!nodes.some((node) => node.text === `${position}/${count}`)) return false;
  if (!nodes.some((node) => node["resource-id"] === MAIN_VIEWER_ROOT))
    throw new PipelineError(
      "NEEDS_INPUT",
      "手机主图页码可见，但无法确认处于京东主图查看器，已停止保存",
    );
  return true;
}
