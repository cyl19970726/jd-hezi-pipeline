import {
  JdCaptureStore,
  JD_CAPTURE_PARSER,
  type CaptureContext,
} from "./jd-capture.js";
import { digest, identity, PipelineError, type Product } from "./model.js";
import type { Store } from "./store.js";

export function sourceContext(
  store: Store,
  shop: string,
  sku: string,
  source: "browser" | "android" = "browser",
): CaptureContext {
  const context = store.meta("jd-context:" + shop);
  return {
    shop,
    sku,
    source,
    parserVersion: JD_CAPTURE_PARSER,
    accountContext: String(context?.account ?? ""),
    regionContext: String(context?.region ?? ""),
  };
}

/** Reuse the original capture store; provenance is not inferred from a fresh timestamp. */
export class SourceReuse {
  readonly captures: JdCaptureStore;
  constructor(readonly store: Store) {
    this.captures = new JdCaptureStore(store);
  }

  remember(context: CaptureContext, product: Product) {
    const previous = this.captures.facts(context);
    if (
      previous &&
      (previous.variant !== product.variant ||
        Date.parse(previous.capturedAt) > Date.parse(product.capturedAt))
    )
      throw new PipelineError(
        "NEEDS_INPUT",
        "来源缓存的销售变体不同或已有更新事实，不能覆盖",
      );
    return this.store.tx(() => {
      this.captures.saveProduct(context, product);
      this.captures.observePage(
        context,
        product.url,
        product.sku,
        product.price?.capturedAt ?? product.capturedAt,
      );
    });
  }

  /** Runs inside the same transaction as enqueue and opportunity association. */
  adopt(shop: string, product: Product) {
    // Existing jobs are keyed by shop/SKU and Worker uses the canonical empty variant.
    // Never silently enqueue a noncanonical variant under a different product identity.
    if (product.variant !== "")
      throw new PipelineError(
        "NEEDS_INPUT",
        "当前任务仅支持按京东SKU绑定的销售规格，不能丢弃非空变体身份",
      );
    const context = sourceContext(this.store, shop, product.sku);
    const observed = this.captures.facts(context);
    if (!observed || digest(observed) !== digest(product))
      throw new PipelineError(
        "NEEDS_INPUT",
        "共享来源缓存缺失或版本不一致，需重新核验来源",
      );
    const id = identity(shop, product.sku, product.variant);
    const found = this.store.db
      .prepare("SELECT id FROM products WHERE id=?")
      .get(id);
    if (found) {
      const row = this.store.get(id);
      if (this.store.pending(id))
        throw new PipelineError(
          "UNKNOWN_OUTCOME",
          "已有商品存在未决写入，必须先对账",
        );
      if (
        row.remoteId ||
        row.plan ||
        [
          "DRAFT_SAVED",
          "DRAFT_VERIFIED",
          "SUBMIT_REQUESTED",
          "UNKNOWN_OUTCOME",
          "REJECTED",
          "SUBMITTED",
          "APPROVED",
          "ON_SALE",
        ].includes(row.state)
      )
        throw new PipelineError(
          "NEEDS_INPUT",
          "已有商品计划或远端身份，保留原任务处理，不能用机会资料覆盖",
        );
      if (digest(row.product) !== digest(product))
        throw new PipelineError(
          "NEEDS_INPUT",
          "已有本地商品事实不同，需要核对原记录，不能静默覆盖",
        );
      return row;
    }
    const row = this.store.put(shop, product);
    this.store.event(row.id, "OPPORTUNITY_SOURCE_REUSED", {
      source: context.source,
      parserVersion: context.parserVersion,
    });
    return row;
  }
}
