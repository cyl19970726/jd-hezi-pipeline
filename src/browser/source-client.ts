export type SourceExports = { list: string; links: string };

/** Resolve supplier inventory readers from their exact read-only endpoint semantics. */
export async function resolveSourceModule(
  candidates: string[],
  readSource: (path: string) => Promise<string>,
): Promise<{ path: string; exports: SourceExports }> {
  const endpoints = {
    list: "/item/shop/shopItem/queryShopItemListOnlyItemInfo",
    links: "/item/shop/shopItem/querySaleItemListOnlyPageSkuInfo",
  } as const;
  const paths = [
    ...new Set(
      candidates.filter((path) =>
        /\/shop-view\/assets\/index-[a-z0-9]+\.js(?:[?#].*)?$/i.test(path),
      ),
    ),
  ].slice(-8);
  const matches: { path: string; exports: SourceExports }[] = [];
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
    if (!block) throw Error("Source module export map missing");
    for (const entry of block.split(",")) {
      const match = entry.trim().match(/^([\w$]+)(?:\s+as\s+([\w$]+))?$/);
      if (match) exported.set(match[1], match[2] ?? match[1]);
    }
    const names = {} as SourceExports;
    for (const [key, endpoint] of Object.entries(endpoints) as [
      keyof SourceExports,
      string,
    ][]) {
      const index = source.indexOf(endpoint);
      const declaration = declarations
        .filter((row) => row.index < index)
        .at(-1);
      const publicName = declaration && exported.get(declaration.name);
      if (!publicName)
        throw Error("Source export missing for endpoint: " + endpoint);
      names[key] = publicName;
    }
    if (names.list === names.links)
      throw Error("Source endpoint exports are not unique");
    matches.push({ path, exports: names });
  }
  if (matches.length !== 1)
    throw Error(
      matches.length
        ? "Multiple source modules matched"
        : "Source module not found",
    );
  return matches[0];
}
