import { randomUUID } from "node:crypto";
import { Store } from "./store.js";
import { digest, PipelineError } from "./model.js";
export interface MarketPage {
  url: string;
  page: number;
  total: number;
  last: boolean;
  checkedAt: string;
  rows: {
    itemId: string;
    title: string;
    url: string;
    shopId: string;
    shopName: string;
    minimum: string;
    free: string;
    skus: { skuId: string; title: string; price: string }[];
  }[];
}
export class MarketScan {
  constructor(readonly store: Store) {
    store.db.exec(
      "CREATE TABLE IF NOT EXISTS market_scans(id TEXT PRIMARY KEY,shop TEXT NOT NULL,query TEXT NOT NULL,next_page INTEGER NOT NULL,total INTEGER,status TEXT NOT NULL,updated_at TEXT NOT NULL); CREATE TABLE IF NOT EXISTS market_pages(run_id TEXT NOT NULL REFERENCES market_scans(id),page INTEGER NOT NULL,data TEXT NOT NULL,PRIMARY KEY(run_id,page));",
    );
  }
  start(shop: string, query: string) {
    const id = randomUUID();
    this.store.db
      .prepare("INSERT INTO market_scans VALUES(?,?,?,1,NULL,'running',?)")
      .run(id, shop, query, new Date().toISOString());
    return id;
  }
  get(id: string) {
    const r = this.store.db
      .prepare("SELECT * FROM market_scans WHERE id=?")
      .get(id);
    if (!r) throw new PipelineError("NEEDS_INPUT", "商城搜索批次不存在");
    return r;
  }
  pages(id: string): MarketPage[] {
    return this.store.db
      .prepare("SELECT data FROM market_pages WHERE run_id=? ORDER BY page")
      .all(id)
      .map((x) => JSON.parse(String(x.data)));
  }
  save(id: string, p: MarketPage) {
    return this.store.tx(() => {
      const r = this.get(id);
      const u = new URL(p.url);
      if (
        u.hostname !== "b.csgmall.com.cn" ||
        u.pathname !== "/mall-view/product/search" ||
        u.searchParams.get("keyword") !== r.query
      )
        throw Error("商城查询范围变化");
      if (r.status !== "running" || p.page !== r.next_page)
        throw Error("商城分页顺序不符");
      if (
        !Number.isInteger(p.total) ||
        p.total < 0 ||
        (r.total !== null && r.total !== p.total)
      )
        throw Error("商城搜索总量变化");
      const old = this.pages(id).flatMap((x) => x.rows);
      const ids = [...old, ...p.rows].map((x) => x.itemId);
      if (ids.some((x) => !x)) throw Error("商城分页缺失商品编号");
      if (
        p.rows.some(
          (row) =>
            !row.skus.length || row.skus.some((sku) => !sku.skuId?.trim()),
        )
      )
        throw Error("商城分页缺失销售SKU，不能推进覆盖检查点");
      if (
        this.pages(id).some(
          (oldPage) => digest(oldPage.rows) === digest(p.rows),
        )
      )
        throw Error("商城整页重复，未确认翻页成功");
      if (!p.rows.length && p.total > 0) throw Error("商城分页内容为空");
      const skuIds = [...old, ...p.rows].flatMap((row) =>
        row.skus.map((s) => s.skuId),
      );
      const discrepancies =
        ids.length !== p.total || new Set(skuIds).size !== skuIds.length;
      if (!p.last && ids.length >= p.total) throw Error("商城分页末页标记不符");
      this.store.db
        .prepare("INSERT INTO market_pages VALUES(?,?,?)")
        .run(id, p.page, JSON.stringify(p));
      this.store.db
        .prepare(
          "UPDATE market_scans SET next_page=?,total=?,status=?,updated_at=? WHERE id=?",
        )
        .run(
          p.page + 1,
          p.total,
          p.last ? (discrepancies ? "needs-review" : "complete") : "running",
          p.checkedAt,
          id,
        );
      return this.get(id);
    });
  }
  list(shop: string) {
    return this.store.db
      .prepare(
        "SELECT * FROM market_scans WHERE shop=? ORDER BY updated_at DESC",
      )
      .all(shop)
      .map((r) => ({
        ...r,
        id: String(r.id),
        seen: this.pages(String(r.id)).reduce((n, p) => n + p.rows.length, 0),
        uniqueSkus: new Set(
          this.pages(String(r.id)).flatMap((p) =>
            p.rows.flatMap((r) => r.skus.map((s) => s.skuId)),
          ),
        ).size,
        uniqueItems: new Set(
          this.pages(String(r.id)).flatMap((p) => p.rows.map((x) => x.itemId)),
        ).size,
      }));
  }
}
/** Visible result data are recall candidates, never verified in-sale offers. */
export function readMarketPage(): MarketPage {
  const text =
    document.querySelector(".layui-laypage-count")?.textContent ?? "";
  const total = Number(text.match(/共\s*(\d+)\s*条/)?.[1]);
  const page = Number(
    document.querySelector(".layui-laypage-curr")?.textContent?.trim(),
  );
  const next = document.querySelector(".layui-laypage-next");
  if (!Number.isInteger(total) || !page || !next)
    throw Error("商城搜索分页尚未就绪");
  return {
    url: location.href,
    page,
    total,
    last: next.classList.contains("layui-disabled"),
    checkedAt: new Date().toISOString(),
    rows: [...document.querySelectorAll<HTMLElement>(".goods-item")].map(
      (e) => {
        const a = e.querySelector<HTMLAnchorElement>(".desc a"),
          link = e.querySelector<HTMLElement>("a.to-product");
        return {
          itemId: e.dataset.itemId ?? "",
          title: e.querySelector("h3 a")?.getAttribute("title") ?? "",
          url: new URL(link?.dataset.href ?? "", location.href).href,
          shopId: a ? (new URL(a.href).searchParams.get("shopId") ?? "") : "",
          shopName: a?.textContent?.replace(/>$/, "").trim() ?? "",
          minimum: e.querySelector(".shop-purchase-volume")?.textContent ?? "",
          free: e.querySelector(".shop-delivery-volume")?.textContent ?? "",
          skus: [...e.querySelectorAll<HTMLElement>(".thumb-list li")].map(
            (s) => ({
              skuId: s.dataset.skuid ?? "",
              title: s.dataset.skuname ?? "",
              price: s.dataset.price ?? "",
            }),
          ),
        };
      },
    ),
  };
}

/** Preserve every sales SKU when one item appears in several result slots. */
export function marketItems(pages: MarketPage[]) {
  const items = new Map<string, MarketPage["rows"][number]>();
  for (const row of pages.flatMap((p) => p.rows)) {
    const old = items.get(row.itemId);
    if (old && old.shopId !== row.shopId)
      throw Error("同一商城商品出现不一致商家身份");
    items.set(row.itemId, {
      ...row,
      skus: [
        ...new Map(
          [...(old?.skus ?? []), ...row.skus].map((s) => [s.skuId, s]),
        ).values(),
      ],
    });
  }
  return [...items.values()];
}
