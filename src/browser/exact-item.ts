/** UI query observed 2026-09-11: queryItemIdList:[id], shopId, hideStatus:0.
 * UI columns observed: 商品编码 renders id; 下架原因 renders soldOutTypeDesc unchanged.
 * Use this bounded identity lookup, never an unfiltered inventory scan.
 */
export async function readExactItem(
  itemId: string,
  shopId: string,
  shop: string,
  resolveSource: (
    paths: string[],
    read: (path: string) => Promise<string>,
  ) => Promise<{ path: string; exports: { list: string } }>,
) {
  if (
    !/^\d+$/.test(itemId) ||
    !/^\d+$/.test(shopId) ||
    !Number.isSafeInteger(Number(shopId))
  )
    throw Error("Invalid exact item identity");
  const paths = [...document.scripts].map((x) => x.src);
  const source = await resolveSource(paths, async (path) => {
    const r = await fetch(path);
    if (
      !r.ok ||
      !/javascript|ecmascript/i.test(r.headers.get("content-type") ?? "")
    )
      throw Error("Source module is not JavaScript");
    return r.text();
  });
  const module = await import(source.path),
    read = module[source.exports.list];
  if (typeof read !== "function") throw Error("Exact item list reader missing");
  let response: any;
  for (const draft of [false, true]) {
    response = await read(
      {
        pageNum: 1,
        pageSize: 10,
        queryItemIdList: [itemId],
        shopId: Number(shopId),
        hideStatus: 0,
        ...(draft ? { itemStatusList: ["99"] } : {}),
      },
      "none",
    );
    if (
      response?.totalCount === 0 &&
      (response.result === null || response.result?.length === 0)
    )
      continue;
    break;
  }
  if (
    response?.totalCount !== 1 ||
    !Array.isArray(response.result) ||
    response.result.length !== 1
  )
    throw Error("Exact item was not uniquely returned");
  const row = response.result[0];
  if (
    String(row.id) !== itemId ||
    String(row.shopId) !== shopId ||
    row.shopName !== shop
  )
    throw Error("Exact item or shop differs");
  if (
    typeof row.saleStatusView !== "string" ||
    !row.saleStatusView.trim() ||
    typeof row.itemName !== "string"
  )
    throw Error("Exact item status/title missing");
  if (
    !Object.hasOwn(row, "soldOutTypeDesc") ||
    (row.soldOutTypeDesc !== null && typeof row.soldOutTypeDesc !== "string")
  )
    throw Error("Exact item warning column missing or changed");
  return {
    itemId,
    code: itemId,
    shop,
    title: row.itemName,
    status: row.saleStatusView,
    platformWarning:
      [
        ...new Set(
          [
            row.soldOutTypeDesc,
            ...(["已驳回", "审核不通过"].includes(row.saleStatusView.trim())
              ? [
                  row.rejectReason,
                  row.refusalReason,
                  row.contentRejectReason,
                  row.contentRejectRemark,
                  row.categoryRejectReason,
                  row.categoryRejectRemark,
                  row.brandRejectReason,
                  row.brandRejectRemark,
                ]
              : []),
          ]
            .filter(
              (value): value is string =>
                typeof value === "string" && !!value.trim(),
            )
            .map((value) => value.trim()),
        ),
      ].join("；") || null,
  };
}
