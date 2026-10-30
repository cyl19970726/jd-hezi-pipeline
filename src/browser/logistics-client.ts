export type LogisticsExports = Record<
  "item" | "area" | "templates" | "addresses",
  string
>;

/** Resolve minified exports from exact read-only endpoint semantics without calling them. */
export async function resolveLogisticsModule(
  candidates: string[],
  readSource: (path: string) => Promise<string>,
): Promise<{ path: string; exports: LogisticsExports }> {
  const endpoints = {
    item: "/item/shop/itemTmplPublish/queryItemInfo",
    area: "/item/shop/area/config/queryAreaConfigAndBrandById",
    templates: "/item/seller/shops/freight/queryTemplateSkuList",
    addresses: "/item/seller/deliveryAddress/queryConfigByItemId",
  } as const;
  const paths = [
    ...new Set(
      candidates.filter((path) =>
        /\/shop-view\/assets\/manage-[a-z0-9]+\.js(?:[?#].*)?$/i.test(path),
      ),
    ),
  ].slice(-12);
  const matches: { path: string; exports: LogisticsExports }[] = [];
  for (const path of paths) {
    const source = await readSource(path).catch(() => "");
    if (
      !Object.values(endpoints).every((endpoint) => source.includes(endpoint))
    )
      continue;
    const declarations = [...source.matchAll(/function\s+([\w$]+)\s*\(/g)].map(
      (match) => ({ name: match[1], index: match.index }),
    );
    const exported = new Map<string, string>();
    const block = source.match(/export\s*\{([^}]+)\}\s*;?\s*$/)?.[1];
    if (!block) throw Error("Logistics module export map missing");
    for (const entry of block.split(",")) {
      const match = entry.trim().match(/^([\w$]+)(?:\s+as\s+([\w$]+))?$/);
      if (match) exported.set(match[1], match[2] ?? match[1]);
    }
    const names = {} as LogisticsExports;
    for (const [key, endpoint] of Object.entries(endpoints) as [
      keyof LogisticsExports,
      string,
    ][]) {
      const index = source.indexOf(endpoint);
      const declaration = declarations
        .filter((row) => row.index < index)
        .at(-1);
      const publicName = declaration && exported.get(declaration.name);
      if (!publicName)
        throw Error("Logistics export missing for endpoint: " + endpoint);
      names[key] = publicName;
    }
    if (new Set(Object.values(names)).size !== 4)
      throw Error("Logistics endpoint exports are not unique");
    matches.push({ path, exports: names });
  }
  if (matches.length !== 1)
    throw Error(
      matches.length
        ? "Multiple logistics modules matched"
        : "Logistics module not found",
    );
  return matches[0];
}
