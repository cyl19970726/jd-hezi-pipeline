/** Current JD mall list, excluding promotional links outside the product cards. */
export function readShopListing() {
  const text = document.body.innerText;
  const count = text.match(/共\s*(\d+)\s*件商品/);
  const pages = text.match(/\b(\d+)\/(\d+)\b/);
  const current = document.querySelector(".jPageCurrent")?.textContent?.trim();
  const next = [
    ...document.querySelectorAll<HTMLAnchorElement>(".jPage a[href]"),
  ].find((a) => a.textContent?.includes("下一页"));
  const last = [...document.querySelectorAll(".jPage .jPageDisable")].some(
    (e) => e.textContent?.includes("下一页"),
  );
  if (!count || !pages || !current || Number(current) !== Number(pages[1]))
    throw Error("店铺列表缺少可核验分页信息");
  const rows = [
    ...document.querySelectorAll<HTMLAnchorElement>(
      ".jSubObject .jDesc a[href]",
    ),
  ].map((a) => {
    const url = new URL(a.href),
      sku = url.pathname.match(/^\/(\d+)\.html$/)?.[1];
    if (url.hostname !== "item.jd.com" || !sku)
      throw Error("店铺商品链接不是京东SKU");
    return {
      sku,
      url: `https://item.jd.com/${sku}.html`,
      title: a.title || a.textContent?.trim() || "",
    };
  });
  return {
    url: location.href,
    shopId: (document.querySelector("#shop_id") as HTMLInputElement)?.value,
    pageNumber: Number(current),
    totalPages: Number(pages[2]),
    totalProducts: Number(count[1]),
    nextUrl: next?.href ?? null,
    lastPageConfirmed: last && Number(current) === Number(pages[2]),
    rows,
    capturedAt: new Date().toISOString(),
  };
}

/** Read only props already bound to visible JD specification options. */
export function readSkuVariants() {
  const sku = location.pathname.match(/^\/(\d+)\.html$/)?.[1];
  const store = document.querySelector<HTMLElement>(".top-name");
  const shopId = store?.closest("[data-shopid]")?.getAttribute("data-shopid");
  const brand = [...document.querySelectorAll<HTMLAnchorElement>("a[href]")]
    .map((a) => ({
      a,
      id: new URL(a.href, location.href).searchParams
        .get("ev")
        ?.match(/^exbrand_(\d+)$/)?.[1],
    }))
    .find((x) => x.id);
  if (!sku || !shopId || !brand) throw Error("商品缺少SKU、店铺ID或品牌ID证据");
  const options = [
    ...document.querySelectorAll<HTMLElement>(".specification-item-sku"),
  ];
  if (!options.length)
    throw Error("尚未支持无规格控件的商品，不能断言规格完整");
  const variants: { sku: string; hint: string }[] = [];
  for (const e of options) {
    const key = Object.keys(e).find((k) => k.startsWith("__reactFiber"));
    let fiber = key ? (e as any)[key] : null,
      data: any;
    for (let depth = 0; fiber && depth < 4; depth++, fiber = fiber.return) {
      const d = fiber.memoizedProps?.data;
      if (d?.skuId && Array.isArray(d.skuList)) {
        data = d;
        break;
      }
    }
    if (!data || data.text !== e.textContent?.trim())
      throw Error("规格控件数据与可见文本不符");
    for (const id of new Set([
      String(data.skuId),
      ...data.skuList.map(String),
    ])) {
      if (!/^\d+$/.test(id)) throw Error("规格SKU格式无效");
      variants.push({ sku: id, hint: data.text });
    }
  }
  return {
    sku,
    shopId,
    shopName: store?.textContent?.trim(),
    selfOperated: !!document.querySelector(".top-self-support-new"),
    jdBrandId: brand.id!,
    brandName: brand.a.textContent?.trim(),
    variants,
    url: location.href,
    capturedAt: new Date().toISOString(),
  };
}
