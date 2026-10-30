export type BrandExports = { detail: string; list: string };

/** Resolve the currently loaded brand reader from two exact GET endpoint semantics. */
export async function resolveBrandModule(
  candidates: string[],
  readSource: (path: string) => Promise<string>,
): Promise<{ path: string; exports: BrandExports }> {
  const endpoints = {
    detail: "/platform/seller/supplier/brand/querySupplierBrandById",
    list: "/platform-service/seller/supplier/brand/querySupplierBrandPageListByParam",
  } as const;
  const paths = [
    ...new Set(
      candidates.filter((path) => {
        try {
          const url = new URL(path, "https://b.csgmall.com.cn");
          return (
            url.origin === "https://b.csgmall.com.cn" &&
            /\/shop-view\/assets\/brand-[a-f\d]+\.js$/i.test(url.pathname)
          );
        } catch {
          return false;
        }
      }),
    ),
  ].slice(-8);
  const matches: { path: string; exports: BrandExports }[] = [];
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
    if (!block) throw Error("Brand module export map missing");
    for (const entry of block.split(",")) {
      const match = entry.trim().match(/^([\w$]+)(?:\s+as\s+([\w$]+))?$/);
      if (match) exported.set(match[1], match[2] ?? match[1]);
    }
    const names = {} as BrandExports;
    for (const [key, endpoint] of Object.entries(endpoints) as [
      keyof BrandExports,
      string,
    ][]) {
      const index = source.indexOf(endpoint);
      const position = declarations.findIndex(
        (row, i) =>
          row.index < index &&
          (i === declarations.length - 1 || declarations[i + 1].index > index),
      );
      const declaration = position >= 0 ? declarations[position] : undefined;
      const end =
        position >= 0 && position + 1 < declarations.length
          ? declarations[position + 1].index
          : source.length;
      const body = declaration ? source.slice(declaration.index, end) : "";
      const publicName = declaration && exported.get(declaration.name);
      if (!publicName || !body.includes(endpoint) || !/\.get\s*\(/.test(body))
        throw Error("Brand GET export missing for endpoint: " + endpoint);
      names[key] = publicName;
    }
    if (names.detail === names.list)
      throw Error("Brand endpoint exports are not unique");
    matches.push({ path, exports: names });
  }
  if (matches.length !== 1)
    throw Error(
      matches.length
        ? "Multiple brand modules matched"
        : "Verified brand module not found",
    );
  return matches[0];
}
