import type { Plan, Product } from "./model.js";

export const MOSQUITO_FORM_CATEGORY_IDS = {
  tablet: "106009002010",
  liquid: "106009002011",
  coil: "106009002009",
  spray: "106009002005",
} as const;

type MosquitoForm = keyof typeof MOSQUITO_FORM_CATEGORY_IDS;

const LABELS: Record<MosquitoForm, string> = {
  tablet: "电热蚊香片",
  liquid: "蚊香液",
  coil: "盘式蚊香",
  spray: "驱蚊喷雾",
};

function formsIn(value: string): Set<MosquitoForm> {
  const normalized = value.replace(/\s+/g, "");
  const forms = new Set<MosquitoForm>();
  if (/电热蚊香片|电蚊香片|蚊香片/.test(normalized)) forms.add("tablet");
  if (/电热蚊香液|电蚊香液|蚊香液/.test(normalized)) forms.add("liquid");
  if (/蚊香盘|盘式蚊香|盘香/.test(normalized)) forms.add("coil");
  if (/驱蚊喷雾|防蚊喷雾/.test(normalized)) forms.add("spray");
  return forms;
}

/** Uses only SKU-bound product text. Shared detail-page fields are intentionally excluded. */
export function validateProductCategorySemantics(
  product: Product,
  plan: Plan,
): string[] {
  const categoryId = plan.catalogBinding?.categoryId;
  const selected = Object.entries(MOSQUITO_FORM_CATEGORY_IDS).find(
    ([, id]) => id === categoryId,
  )?.[0] as MosquitoForm | undefined;
  if (!selected) return [];

  const evidence = [
    product.title.value,
    product.variant,
    product.specs["京东销售规格"]?.value,
    product.specs["包装名称"]?.value,
  ].filter((value): value is string => Boolean(value?.trim()));
  const observed = new Set(evidence.flatMap((value) => [...formsIn(value)]));
  if (observed.size !== 1) return [];
  const [actual] = observed;
  return actual === selected
    ? []
    : [`商品明确为${LABELS[actual]}，与所选类目${LABELS[selected]}不一致`];
}
