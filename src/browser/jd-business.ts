import { PipelineError, type Product } from "../model.js";
/** Consume the response emitted by a normal page load, never replay a signed request. */
export function enrichJd(product: Product, data: any): Product {
  const w = data.wareInfoReadMap;
  if (String(w?.product_id) !== product.sku)
    throw new PipelineError("NEEDS_INPUT", "京东业务响应SKU不符");
  const p = structuredClone(product);
  const fact = (value: string, evidence: string) => ({
    value,
    sourceUrl: p.url,
    capturedAt: p.capturedAt,
    evidence,
  });
  const amount = (value: unknown) => {
    const text = String(value ?? "").replace(/[¥￥,\s]/g, "");
    return /^\d+(?:\.\d{1,2})?$/.test(text) && Number(text) > 0
      ? Number(text).toFixed(2)
      : null;
  };
  const unique = (values: (string | null)[]) => [
    ...new Set(values.filter((value): value is string => !!value)),
  ];
  const items = Array.isArray(data.warePriceGatherVO?.priceItemList)
    ? data.warePriceGatherVO.priceItemList
    : [];
  const structured = (type: "regularPrice" | "jdPrice") => {
    const matching = items.filter((item: any) => item?.priceType === type);
    const parsed: (string | null)[] = matching.map((item: any) =>
      amount(item.price),
    );
    return {
      present: matching.length > 0,
      invalid: parsed.some((value) => value === null),
      values: unique(parsed),
    };
  };
  // A structured regularPrice is the strongest ordinary-price signal.  The
  // SKU-bound jdPrice type is the fallback; raw p/op/m and personalized price
  // types never enter this selection.
  const regularPrices = structured("regularPrice");
  const jdPrices = structured("jdPrice");
  const selectedStructured = regularPrices.present ? regularPrices : jdPrices;
  const structuredPrices = selectedStructured.values;
  const raw = product as Product & {
    priceCandidates?: { text?: string; basis?: string }[];
    priceEvidence?: {
      visibleRegularPrice?: boolean;
      regularPriceAmbiguous?: boolean;
    };
  };
  const domPrices = unique(
    (raw.priceCandidates ?? [])
      .filter((candidate) => candidate.basis === "jd-price")
      .map((candidate) => amount(candidate.text)),
  );
  const domPrice =
    product.price?.basis === "jd-price" ? amount(product.price.value) : null;
  const domConflict =
    raw.priceEvidence?.regularPriceAmbiguous === true || domPrices.length > 1;
  const structuredConflict =
    selectedStructured.invalid ||
    (selectedStructured.present && structuredPrices.length !== 1);
  const crossEvidenceConflict =
    structuredPrices.length === 1 &&
    unique([...domPrices, domPrice]).some(
      (value) => value !== structuredPrices[0],
    );
  if (domConflict || structuredConflict || crossEvidenceConflict)
    p.price = null;
  else if (domPrice) {
    // Keep the direct DOM evidence when it agrees with the structured response.
    p.price = { ...product.price!, value: domPrice };
  } else if (selectedStructured.present && structuredPrices.length === 1) {
    const type = regularPrices.present ? "regularPrice" : "jdPrice";
    p.price = {
      ...fact(
        structuredPrices[0],
        `京东SKU绑定业务响应 warePriceGatherVO.priceItemList priceType=${type}`,
      ),
      basis: "jd-price",
    };
  }
  for (const a of [
    ...(data.productAttributeVO?.attributes ?? []),
    ...(data.productAttributeVO?.coreAttributes ?? []),
  ])
    if (a.labelName && a.labelValue)
      p.specs[a.labelName] = fact(
        String(a.labelValue),
        "京东商品业务响应 productAttributeVO",
      );
  if (/^\d+(?:\.\d+)?$/.test(w.weight) && Number(w.weight) > 0)
    p.specs["商品毛重"] = fact(
      w.weight + "kg",
      "京东商品业务响应 wareInfoReadMap.weight（kg）",
    );
  if (w.cn_brand)
    p.specs["品牌"] = fact(w.cn_brand, "京东商品业务响应 cn_brand");
  // Source selection text is retained intact; category-specific interpretation is separate.
  if (w.color)
    p.specs["京东销售规格"] = fact(w.color, "京东商品业务响应 color");
  if (w.warranty)
    p.specs["京东质保"] = fact(w.warranty, "京东商品业务响应 warranty");
  if (w.upc_code)
    p.specs["商品条码"] = fact(w.upc_code, "京东商品业务响应 upc_code");
  return p;
}
