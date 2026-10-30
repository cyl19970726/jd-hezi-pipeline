/** Versioned Vue adapter: update the same reactive form data rendered by Logistics.
 * The platform's own submit(PUBLISH) validator remains in effect. */
export async function applyLogistics(value: {
  areas: { areaId: string; areaName: string }[];
  templateId: string;
  addressIds: string[];
}) {
  const root = (document.querySelector("#app") as any)?.__vue_app__?._container
    ?._vnode;
  const seen = new Set<any>(),
    found: any[] = [];
  function walk(v: any, inside = false) {
    if (!v || typeof v !== "object" || seen.has(v)) return;
    seen.add(v);
    if (seen.size > 10000) throw Error("Vue tree exceeded limit");
    const c = v.component;
    const active = inside || c?.type?.__name === "Logistics";
    if (
      active &&
      c?.props?.data &&
      Array.isArray(c.props.data.areaList) &&
      Array.isArray(c.props.data.addressIdList)
    )
      found.push(c.props.data);
    if (c) walk(c.subTree, active);
    if (Array.isArray(v.children))
      v.children.forEach((x: any) => walk(x, active));
  }
  walk(root);
  const models = [...new Set(found)];
  if (models.length !== 1) throw Error("Logistics model not unique");
  const model = models[0];
  if (String(model.templateId) !== value.templateId)
    throw Error("Template ID differs from selected template");
  if (
    JSON.stringify(model.addressIdList.map(String).sort()) !==
    JSON.stringify([...value.addressIds].sort())
  )
    throw Error("Shipping address differs from source policy");
  model.areaList = value.areas.map((x) => ({
    value: x.areaId,
    label: x.areaName,
  }));
  return {
    areas: model.areaList.length,
    templateId: String(model.templateId),
    addressIds: model.addressIdList.map(String),
  };
}

/** Read actual relationships through the loaded platform client; never exports authentication. */
export async function readLogistics(
  itemId: string,
  modulePaths: string[],
  resolveModule: (
    candidates: string[],
    readSource: (path: string) => Promise<string>,
  ) => Promise<{
    path: string;
    exports: {
      item: string;
      area: string;
      templates: string;
      addresses: string;
    };
  }>,
) {
  const cacheKey = "hezi:logistics-module:v1";
  let resolved: Awaited<ReturnType<typeof resolveModule>> | null = null;
  try {
    const cached = JSON.parse(sessionStorage.getItem(cacheKey) ?? "null");
    if (cached && modulePaths.includes(cached.path)) resolved = cached;
  } catch {
    /* Resolve again when a prior cache is malformed. */
  }
  if (!resolved) {
    resolved = await resolveModule(modulePaths, async (path) => {
      const response = await fetch(path);
      if (!response.ok) throw Error("Manage module source request failed");
      const type = response.headers.get("content-type") ?? "";
      if (!/javascript|ecmascript/i.test(type))
        throw Error("Manage module source is not JavaScript");
      return response.text();
    });
    sessionStorage.setItem(cacheKey, JSON.stringify(resolved));
  }
  const m = await import(resolved.path);
  const itemReader = m[resolved.exports.item],
    areaReader = m[resolved.exports.area],
    templateReader = m[resolved.exports.templates],
    addressReader = m[resolved.exports.addresses];
  if (
    typeof itemReader !== "function" ||
    typeof areaReader !== "function" ||
    typeof templateReader !== "function" ||
    typeof addressReader !== "function"
  )
    throw Error("Manage client exports missing");
  const item = await itemReader({ itemId }, "none");
  if (!item || typeof item !== "object") throw Error("Invalid item response");
  if (String(item.id) !== itemId) throw Error("Item identity differs");
  if (!Array.isArray(item.itemTmplSkuVoList))
    throw Error("Missing item SKU rows");
  const skuList = item.itemTmplSkuVoList.map((s: any) => s.id).join(",");
  const [area, templates, addresses] = await Promise.all([
    areaReader({ itemId }, "none"),
    templateReader({ skuList }, "none"),
    addressReader({ itemId }, "none"),
  ]);
  if (!Array.isArray(area)) throw Error("Invalid delivery area response");
  if (!Array.isArray(templates))
    throw Error("Invalid freight template response");
  if (!Array.isArray(addresses))
    throw Error("Invalid delivery address response");
  const templateIds = [
    ...new Set(templates.map((x: any) => String(x.templateId))),
  ];
  if (templateIds.length !== 1)
    throw Error("Multiple or missing freight templates");
  return {
    sourceItemId: itemId,
    sourceShopId: String(item.shopId),
    checkedAt: new Date().toISOString(),
    hasOrderInfo: item.hasOrderInfo,
    areas: area.map((x: any) => ({
      areaId: String(x.areaId),
      areaName: x.areaName,
    })),
    templateId: templateIds[0],
    templateName: templates[0].templateName,
    addressIds: addresses
      .filter((x: any) => x.isSelect)
      .map((x: any) => String(x.id)),
  };
}
