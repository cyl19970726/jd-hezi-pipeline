import type { AssetDownloadPolicy } from "./assets.js";
import { JdTraffic } from "./jd-traffic.js";
import { JdCaptureStore, type CaptureContext } from "./jd-capture.js";
import { PipelineError } from "./model.js";
import { Store } from "./store.js";

/** All production CDN downloads share the browser/phone gate; cache hits stay offline. */
export function jdAssetPolicy(
  store: Store,
  context: CaptureContext,
): AssetDownloadPolicy {
  // Native CDN fetches belong to the web channel even in a mixed phone product.
  const traffic = new JdTraffic(store, context.shop);
  const capture = new JdCaptureStore(store);
  return {
    runNetwork: (_asset, operation) =>
      traffic.asset(async () => {
        capture.metric(
          { ...context, source: "browser" },
          {
            stage: "asset-attempt",
            reason: "CDN fetch attempted; HTTP response not yet observed",
          },
        );
        try {
          return await operation();
        } catch (e) {
          if (
            e instanceof PipelineError &&
            [403, 429].includes(Number((e.details as any)?.httpStatus))
          )
            traffic.risk(
              "京东图片服务拒绝请求，暂停采集等待检查：" + e.message,
              (e.details as any)?.retryAfter ?? null,
            );
          throw e;
        }
      }),
    onMetric: (metric) => {
      capture.metric(
        {
          ...context,
          source: metric.kind === "download" ? "browser" : context.source,
        },
        {
          stage: "assets",
          reason: metric.source,
          downloads: metric.kind === "download" ? 1 : 0,
          downloadBytes: metric.bytes,
          cacheHits: metric.kind === "cache-hit" ? 1 : 0,
        },
      );
    },
  };
}
