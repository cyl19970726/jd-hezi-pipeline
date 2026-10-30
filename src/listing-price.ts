import { PricingStore } from "./pricing-store.js";
import { Store } from "./store.js";
import { money, PipelineError, type Product, type Plan } from "./model.js";
export function listingPrice(
  store: Store,
  shop: string,
  p: Product,
): Pick<Plan, "rulesVersion" | "price" | "pricingReviewId"> {
  const mode = store.meta("listing-price:" + shop) ?? "jd-source";
  if (mode === "jd-regular-preferred") {
    const since = Date.parse(
      String(store.meta("listing-price-effective-at:" + shop) ?? ""),
    );
    if (
      !p.price ||
      !money(p.price.value) ||
      !["jd-price", "subsidy"].includes(p.price.basis ?? "")
    )
      throw new PipelineError(
        "NEEDS_INPUT",
        "缺少明确日常价/京东价或备用补贴价；禁止使用到手价或无标签划线价",
      );
    const captured = Date.parse(p.price.capturedAt);
    if (Number.isFinite(since) && !Number.isFinite(captured))
      throw new PipelineError(
        "NEEDS_INPUT",
        "明确报价缺少有效采集时间证据，必须重新采集",
      );
    if (Number.isFinite(since) && captured < since)
      throw new PipelineError(
        "NEEDS_INPUT",
        "价格优先级已更新，旧报价必须重新采集：日常价/京东价优先，缺失时才用补贴价",
      );
    return {
      rulesVersion:
        p.price.basis === "jd-price" ? "catalog-jd-v2" : "catalog-jd-v1",
      price: { ...p.price },
    };
  }
  if (mode === "jd-subsidy" || mode === "jd-source") {
    if (
      !p.price ||
      !money(p.price.value) ||
      (p.price.basis !== "subsidy" &&
        !(mode === "jd-source" && p.price.basis === "jd-price"))
    )
      throw new PipelineError(
        "NEEDS_INPUT",
        "缺少明确京东补贴价或允许的京东价；上架不等待竞品比价，也不使用到手价或无标签划线价",
      );
    return {
      rulesVersion:
        p.price.basis === "jd-price" ? "catalog-jd-v2" : "catalog-jd-v1",
      price: { ...p.price },
    };
  }
  if (mode !== "competitor")
    throw new PipelineError("NEEDS_INPUT", "未知上架定价策略");
  const pricing = new PricingStore(store).resolve(shop, p);
  if (!pricing) throw new PipelineError("NEEDS_INPUT", "尚未完成同款比价核验");
  return {
    rulesVersion: "catalog-v3",
    pricingReviewId: pricing.id,
    price: {
      value: pricing.decision.value,
      basis: pricing.decision.basis,
      sourceUrl: pricing.review.searchUrls[0],
      capturedAt: pricing.decision.checkedAt,
      evidence: "数据库比价记录 " + pricing.id,
    },
  };
}
