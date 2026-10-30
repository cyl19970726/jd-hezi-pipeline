import { z } from "zod";
import { Store } from "./store.js";
import { digest, parseSku } from "./model.js";
const identifier = z
  .union([z.string().min(1), z.number().int().safe()])
  .transform(String);
const skuSchema = z.object({
  id: identifier,
  itemId: identifier,
  shopId: identifier,
  skuName: z.string(),
  sellPrice: z.union([
    z.string().regex(/^\d+(\.\d{1,2})?$/),
    z.number().nonnegative().finite(),
  ]),
  inventory: z.number().nonnegative(),
  skuStatus: z.number(),
  skuShelfStatus: z.number(),
  skuUnit: z.string().nullish(),
  specAttributes: z.string().nullish(),
  attributesName: z.string().nullish(),
  barCode: z.string().nullish(),
  skuPicUrls: z.array(z.object({ url: z.string().nullish() })).nullish(),
});
const responseSchema = z.object({
  code: z.union([z.literal("0"), z.literal(0)]),
  data: z.object({
    itemId: identifier,
    itemPublishVo: z.object({
      id: identifier,
      shopId: identifier,
      brandName: z.string(),
      saleStatus: z.number(),
    }),
    itemSkuInfoList: z.array(skuSchema).min(1),
  }),
});
export class MarketDetails {
  constructor(readonly store: Store) {
    store.db.exec(
      `CREATE TABLE IF NOT EXISTS market_details(id TEXT PRIMARY KEY,shop TEXT NOT NULL,item_id TEXT NOT NULL,checked_at TEXT NOT NULL,payload TEXT NOT NULL); CREATE INDEX IF NOT EXISTS market_details_lookup ON market_details(shop,item_id,checked_at);`,
    );
  }
  save(
    shop: string,
    itemId: string,
    otherShopId: string,
    input: unknown,
    checkedAt = new Date().toISOString(),
    expectedSkus: string[] = [],
  ) {
    const r = responseSchema.parse(input),
      d = r.data;
    if (
      d.itemId !== itemId ||
      d.itemPublishVo.id !== itemId ||
      d.itemPublishVo.shopId !== otherShopId ||
      d.itemSkuInfoList.some(
        (s) => s.itemId !== itemId || s.shopId !== otherShopId,
      ) ||
      new Set(d.itemSkuInfoList.map((s) => s.id)).size !==
        d.itemSkuInfoList.length
    )
      throw Error("竞品详情身份与搜索候选不一致");
    if (expectedSkus.some((id) => !d.itemSkuInfoList.some((s) => s.id === id)))
      throw Error("搜索销售SKU在详情中缺失，需重新核对");
    if (
      !Number.isFinite(Date.parse(checkedAt)) ||
      Date.parse(checkedAt) > Date.now() + 60000
    )
      throw Error("竞品详情核验时间不合法");
    const id = digest({ shop, itemId, checkedAt, input });
    this.store.db
      .prepare("INSERT OR IGNORE INTO market_details VALUES(?,?,?,?,?)")
      .run(id, shop, itemId, checkedAt, JSON.stringify(input));
    return id;
  }
  get(id: string) {
    const row = this.store.db
      .prepare("SELECT * FROM market_details WHERE id=?")
      .get(id);
    if (!row) throw Error("竞品详情证据不存在");
    const d = responseSchema.parse(JSON.parse(String(row.payload))).data;
    return {
      id: String(row.id),
      shop: String(row.shop),
      itemId: d.itemId,
      shopId: d.itemPublishVo.shopId,
      brand: d.itemPublishVo.brandName,
      checkedAt: String(row.checked_at),
      skus: d.itemSkuInfoList.map((s) => ({
        id: s.id,
        title: s.skuName,
        price: String(s.sellPrice),
        available:
          d.itemPublishVo.saleStatus === 60 &&
          s.skuStatus === 1 &&
          s.skuShelfStatus === 20 &&
          s.inventory > 0,
        unit: s.skuUnit ?? null,
        attributes: s.attributesName ?? s.specAttributes ?? "",
        barcode: s.barCode ?? null,
        sourceSkus: [
          ...new Set(
            (s.skuPicUrls ?? []).flatMap((link) => {
              try {
                const u = new URL(link.url?.trim() ?? "");
                return [parseSku(u.href)];
              } catch {
                return [];
              }
            }),
          ),
        ],
      })),
    };
  }
  fresh(shop: string, itemId: string, now = Date.now()) {
    const row = this.store.db
      .prepare(
        "SELECT id,checked_at FROM market_details WHERE shop=? AND item_id=? ORDER BY checked_at DESC,rowid DESC LIMIT 1",
      )
      .get(shop, itemId);
    if (
      !row ||
      now - Date.parse(String(row.checked_at)) > 3600000 ||
      Date.parse(String(row.checked_at)) > now + 60000
    )
      return null;
    return this.get(String(row.id));
  }
}

/** Source-link evidence is a proposal for review, not permission to publish at the displayed price. */
export function sourceMatch(
  product: { sku: string; specs: Record<string, { value: string }> },
  detail: ReturnType<MarketDetails["get"]>,
  skuId: string,
) {
  const sku = detail.skus.find((s) => s.id === skuId);
  if (!sku) throw Error("详情中没有目标销售SKU");
  const normalize = (s: string) =>
    s.replace(/（.*?）|\(.*?\)|\s/g, "").toLowerCase();
  const brand = product.specs["品牌"]?.value;
  const brandMatches = !!brand && normalize(brand) === normalize(detail.brand);
  const source =
    sku.sourceSkus.length === 1 && sku.sourceSkus[0] === product.sku
      ? "same-jd-sku"
      : sku.sourceSkus.length
        ? "other-or-multiple-jd-skus"
        : "no-jd-link";
  return {
    source,
    brandMatches,
    available: sku.available,
    price: sku.price,
    checkedAt: detail.checkedAt,
    receiptId: detail.id,
    attributes: sku.attributes,
    reviewRequired: true,
    reasons: [
      ...(!brandMatches ? ["品牌缺失或不一致"] : []),
      ...(source !== "same-jd-sku"
        ? ["来源链接不足以证明同款；不同京东SKU也不能单独证明不同款"]
        : []),
      ...(!sku.available ? ["当前未满足在售、有效SKU及有库存条件"] : []),
      "还需核对销售包装、购买条件与完整搜索范围",
    ],
  };
}
