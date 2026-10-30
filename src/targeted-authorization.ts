import { Store } from "./store.js";
import { importTargetedGrantReceipt } from "./targeted-grant-import.js";
import type { BrowserConfig } from "./browser/runtime.js";

/** Refresh known supplier identities with current page receipts, without rescanning every brand. */
export async function refreshTargetedAuthorization(
  store: Store,
  config: BrowserConfig,
  input: { brandId: string; categoryId: string },
  bridge: { call(action: string, args: unknown): Promise<any> },
) {
  store.assertRunning(config.shop);
  const known = store.db
    .prepare(
      "SELECT grant_id,list_json FROM brand_inventory_rows WHERE brand_id=? AND run_id IN (SELECT id FROM brand_inventory_runs WHERE shop=?) ORDER BY rowid DESC LIMIT 1",
    )
    .get(input.brandId, config.shop);
  if (!known) throw Error("本地没有该品牌的明确供应商授权身份");
  const identity = JSON.parse(String(known.list_json));
  if (
    identity.supplierName !== config.shop ||
    String(identity.brandId) !== input.brandId ||
    !/^\d+$/.test(String(identity.supplierId))
  )
    throw Error("本地供应商授权身份不一致");
  const unlock = store.lock("publisher");
  try {
    const options = await bridge.call("refresh-catalog-options", { config });
    if (options.shop !== config.shop || !Array.isArray(options.categories))
      throw Error("目录回执店铺或类目缺失");
    const nodes: any[] = [];
    let next: string | null = input.categoryId;
    const seen = new Set<string>();
    while (next !== null) {
      if (seen.has(next)) throw Error("目录类目路径包含循环");
      seen.add(next);
      const matches = options.categories.filter(
        (node: any) => node.id === next,
      );
      if (matches.length !== 1) throw Error("当前目录不包含唯一目标类目路径");
      nodes.unshift(matches[0]);
      next = matches[0].parentId;
    }
    const result = await bridge.call("brand-read", {
      config,
      grantId: String(known.grant_id),
      supplierId: String(identity.supplierId),
      brandId: input.brandId,
    });
    const receipt = {
      ...result,
      categoryEvidence: {
        nodes,
        sourceUrl: nodes.at(-1).sourceUrl,
        checkedAt: nodes.at(-1).checkedAt,
      },
    };
    const imported = importTargetedGrantReceipt(store, receipt);
    store.setMeta(
      `targeted-authorization:${config.shop}:${input.brandId}:${input.categoryId}`,
      receipt,
    );
    return imported;
  } finally {
    unlock();
  }
}
