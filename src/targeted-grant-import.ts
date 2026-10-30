import { z } from "zod";
import { Catalog } from "./catalog.js";
import { Store } from "./store.js";

const evidenceSchema = z.object({
  sourceUrl: z.string().url(),
  checkedAt: z.string().datetime(),
});

const categoryNodeSchema = z.object({
  id: z.string().min(1),
  parentId: z.string().min(1).nullable(),
  name: z.string().min(1),
  path: z.string().min(1),
  selectable: z.boolean(),
});

/**
 * A narrow, read-receipt import for one known supplier-brand grant.  This is
 * intentionally not a replacement for BrandInventory's complete snapshot.
 */
export const targetedGrantReceiptSchema = z.object({
  shop: z.string().min(1),
  supplierId: z.string().regex(/^\d+$/),
  grantId: z.string().regex(/^\d+$/),
  brandId: z.string().regex(/^\d+$/),
  ...evidenceSchema.shape,
  categoryEvidence: z.object({
    ...evidenceSchema.shape,
    nodes: z.array(categoryNodeSchema).min(1),
  }),
  detail: z.object({
    id: z.union([z.string(), z.number()]),
    supplierId: z.union([z.string(), z.number()]),
    supplierName: z.string().min(1),
    brandId: z.union([z.string(), z.number()]),
    brandName: z.string().min(1),
    supplierBrandStatus: z.number().int(),
    validStatus: z.number().int(),
    validTimeBegin: z.string().optional(),
    validTimeEnd: z.string().optional(),
    supplierBrandCatVos: z.array(
      z.object({
        catId: z.union([z.string(), z.number()]),
        status: z.number().int(),
      }),
    ),
  }),
});
export type TargetedGrantReceipt = z.infer<typeof targetedGrantReceiptSchema>;

const pathText = (nodes: TargetedGrantReceipt["categoryEvidence"]["nodes"]) =>
  nodes.map((node) => node.name).join(" > ");

function assertVerifiedPath(input: TargetedGrantReceipt) {
  const ids = new Set<string>();
  const nodes = input.categoryEvidence.nodes;
  for (let index = 0; index < nodes.length; index++) {
    const node = nodes[index];
    if (ids.has(node.id)) throw Error("类目回执路径包含重复 ID");
    ids.add(node.id);
    const expectedParent = index ? nodes[index - 1].id : null;
    if (
      node.parentId !== expectedParent ||
      node.path !== pathText(nodes.slice(0, index + 1))
    )
      throw Error("类目回执不是从根到目标类目的已核验路径");
  }
  if (!nodes.at(-1)!.selectable) throw Error("目标类目在回执中不可选");
}

function validDates(detail: TargetedGrantReceipt["detail"], checkedAt: string) {
  if (
    detail.validStatus === 1 ||
    !detail.validTimeBegin ||
    !detail.validTimeEnd
  )
    return { state: "unknown" as const };
  const validFrom = Date.parse(detail.validTimeBegin + "T00:00:00+08:00");
  const validUntil = Date.parse(detail.validTimeEnd + "T23:59:59+08:00");
  const observed = Date.parse(checkedAt);
  if (
    !Number.isFinite(validFrom) ||
    !Number.isFinite(validUntil) ||
    validUntil < validFrom
  )
    return { state: "unknown" as const };
  return {
    state:
      validFrom <= observed && observed <= validUntil
        ? ("current" as const)
        : ("outside" as const),
    validFrom,
    validUntil,
  };
}

/**
 * Imports only the brand, root-to-leaf category evidence, and `current:<id>`
 * projection for one receipt. Historical grant rows are never edited.
 */
export function importTargetedGrantReceipt(
  store: Store,
  received: unknown,
  now = Date.now(),
) {
  const input = targetedGrantReceiptSchema.parse(received);
  if (Date.parse(input.checkedAt) > now + 60_000)
    throw Error("品牌授权核验时间不能在未来");
  if (Date.parse(input.categoryEvidence.checkedAt) > now + 60_000)
    throw Error("类目核验时间不能在未来");
  assertVerifiedPath(input);
  const detail = input.detail;
  if (
    String(detail.id) !== input.grantId ||
    String(detail.supplierId) !== input.supplierId ||
    detail.supplierName !== input.shop ||
    String(detail.brandId) !== input.brandId
  )
    throw Error("品牌详情与店铺、供应商、品牌或授权 ID 不完全一致");

  const targetCategory = input.categoryEvidence.nodes.at(-1)!;
  const dates = validDates(detail, input.checkedAt);
  const grantState =
    dates.state === "unknown" ||
    ![1, 4].includes(detail.supplierBrandStatus) ||
    dates.state === "outside"
      ? ("invalid" as const)
      : ("active" as const);
  const currentId = "current:" + input.grantId;

  return store.tx(() => {
    const brand = store.db
      .prepare("SELECT * FROM catalog_brands WHERE shop=? AND id=?")
      .get(input.shop, input.brandId);
    if (!brand) throw Error("目标品牌不在当前店铺目录，不能凭详情新建身份");

    // A real platform grant ID may appear in history, but it must never be
    // repurposed for another brand by this narrowly scoped import.
    let current: any = null;
    for (const id of [input.grantId, currentId]) {
      const existing = store.db
        .prepare(
          "SELECT brand_id,checked_at FROM catalog_grants WHERE shop=? AND id=?",
        )
        .get(input.shop, id);
      if (existing && String(existing.brand_id) !== input.brandId)
        throw Error("历史或当前授权 ID 已绑定另一品牌，拒绝重新标记");
      if (
        id === currentId &&
        existing &&
        Date.parse(String(existing.checked_at)) > Date.parse(input.checkedAt)
      )
        throw Error("品牌授权回执早于当前投影，拒绝回退或清除更新范围");
      if (id === currentId) current = existing;
    }

    new Catalog(store).import({
      shop: input.shop,
      brands: [
        {
          id: input.brandId,
          name: detail.brandName,
          sourceUrl: input.sourceUrl,
          checkedAt: input.checkedAt,
        },
      ],
      categories: input.categoryEvidence.nodes.map((category) => ({
        ...category,
        sourceUrl: input.categoryEvidence.sourceUrl,
        checkedAt: input.categoryEvidence.checkedAt,
      })),
      grants: [],
    });

    const activeScopes = [
      ...new Set(
        detail.supplierBrandCatVos
          .filter((scope) => scope.status === 1)
          .map((scope) => String(scope.catId)),
      ),
    ].filter((categoryId) =>
      store.db
        .prepare("SELECT 1 FROM catalog_categories WHERE shop=? AND id=?")
        .get(input.shop, categoryId),
    );
    const eligible = activeScopes.some((categoryId) =>
      input.categoryEvidence.nodes.some(
        (category) => category.id === categoryId,
      ),
    );

    if (dates.state === "unknown") {
      if (current) {
        store.db
          .prepare(
            `UPDATE catalog_grants SET status='pending',source_url=?,checked_at=?
             WHERE shop=? AND id=?`,
          )
          .run(input.sourceUrl, input.checkedAt, input.shop, currentId);
        store.db
          .prepare("DELETE FROM catalog_scopes WHERE shop=? AND grant_id=?")
          .run(input.shop, currentId);
      }
      store.event(null, "TARGETED_GRANT_UNRESOLVED", {
        shop: input.shop,
        supplierId: input.supplierId,
        grantId: input.grantId,
        brandId: input.brandId,
        categoryId: targetCategory.id,
        checkedAt: input.checkedAt,
        reason: "授权有效期缺失、长期有效或格式无效，不能作为当前可用授权",
        shadowedCurrentProjection: !!current,
      });
      return {
        grantId: currentId,
        brandId: input.brandId,
        categoryId: targetCategory.id,
        status: "unknown" as const,
        eligible: false,
        scopes: [] as string[],
        checkedAt: input.checkedAt,
      };
    }

    store.db
      .prepare(
        `INSERT INTO catalog_grants VALUES(?,?,?,?,?,?,?,?)
         ON CONFLICT(shop,id) DO UPDATE SET brand_id=excluded.brand_id,status=excluded.status,
         valid_from=excluded.valid_from,valid_until=excluded.valid_until,source_url=excluded.source_url,
         checked_at=excluded.checked_at WHERE excluded.checked_at >= catalog_grants.checked_at`,
      )
      .run(
        input.shop,
        currentId,
        input.brandId,
        grantState === "active" ? "approved" : "revoked",
        new Date(dates.validFrom).toISOString(),
        new Date(dates.validUntil).toISOString(),
        input.sourceUrl,
        input.checkedAt,
      );
    store.db
      .prepare("DELETE FROM catalog_scopes WHERE shop=? AND grant_id=?")
      .run(input.shop, currentId);
    if (grantState === "active")
      for (const categoryId of activeScopes)
        store.db
          .prepare("INSERT INTO catalog_scopes VALUES(?,?,?,?)")
          .run(input.shop, currentId, categoryId, 1);

    store.event(null, "TARGETED_GRANT_IMPORTED", {
      shop: input.shop,
      supplierId: input.supplierId,
      grantId: input.grantId,
      currentId,
      brandId: input.brandId,
      categoryId: targetCategory.id,
      status: grantState === "active" ? "approved" : "revoked",
      checkedAt: input.checkedAt,
    });
    return {
      grantId: currentId,
      brandId: input.brandId,
      categoryId: targetCategory.id,
      status:
        grantState === "active" ? ("approved" as const) : ("revoked" as const),
      eligible: grantState === "active" && eligible,
      scopes: grantState === "active" ? activeScopes : [],
      checkedAt: input.checkedAt,
    };
  });
}
