import type { Product } from "./model.js";

export const PACKING_DISPLAY_RULES_VERSION = "packing-display/1";

const clockCategories = new Set(["1068010001", "1068010003"]);
const forbidden = /赠|随机|任选|二选|三选|\b(?:or)\b|或/iu;
const removablePurpose = /[（(](?:机芯使用|显示模块使用|液显模块使用)[）)]/g;

/**
 * Converts a fully parsed component/count sequence into a short display value.
 * Returning null means the original fact must remain untouched.
 */
export function projectPackingDisplay(
  raw: string,
  maxLength = 20,
): string | null {
  const input = raw.trim();
  if (
    !input ||
    forbidden.test(input) ||
    /[+＋;；|｜/／:：\r\n\t]/.test(input) ||
    /[*×]\s*\d+\.\d+/.test(input)
  )
    return null;

  const components: { name: string; count: string }[] = [];
  let remaining = input.replace(removablePurpose, "");
  while (remaining) {
    const match = remaining.match(
      /^\s*([^*×、，,]+?)\s*[*×]\s*([1-9]\d*)(?!\d)/,
    );
    if (!match) return null;
    const name = match[1].trim();
    if (!name || /[*×、，,]/.test(name)) return null;
    components.push({ name, count: match[2] });
    remaining = remaining.slice(match[0].length);
    if (!remaining.trim()) break;
    const separator = remaining.match(/^\s*[、，,]\s*/);
    if (separator) remaining = remaining.slice(separator[0].length);
    else {
      // With no separator, a multi-digit count cannot be distinguished from
      // a single-digit count followed by a digit-prefixed component name.
      if (match[2].length > 1) return null;
      remaining = remaining.trimStart();
    }
    if (!remaining) return null;
  }

  if (!components.length) return null;
  const value = components
    .map(({ name, count }) => `${name}${count}`)
    .join("、");
  return value.length <= maxLength ? value : null;
}

export function clockPackingDisplayFact(
  categoryId: string,
  fact: Product["specs"][string],
): Product["specs"][string] {
  if (!clockCategories.has(categoryId)) return fact;
  const value = projectPackingDisplay(fact.value);
  if (!value || value === fact.value) return fact;
  return {
    ...fact,
    value,
    evidence: `由完整包装名称“${fact.value}”按钟表包装显示规则 ${PACKING_DISPLAY_RULES_VERSION} 生成；完整来源事实保留`,
  };
}

/** Short supplier display for a single explicit clip pack; full source stays in Product. */
export function listingPackingDisplayFact(
  categoryId: string,
  fact: Product["specs"][string],
  product: Product,
): Product["specs"][string] {
  if (categoryId === "10015007" && fact.value.length > 20) {
    const match = fact.value.match(
      /^([^+＋;；|｜、]+)复印纸\s+([1-9]\d*)g\/包\s+([1-9]\d*)包\/箱\s+总计([1-9]\d*)张$/iu,
    );
    const expected = match && {
      型号: match[1],
      克重: `${match[2]}g`,
      包数: `${match[3]}包装`,
      张数: `${match[4]}张`,
    };
    const proven =
      expected &&
      fact.sourceUrl === product.url &&
      !forbidden.test(fact.value) &&
      Object.entries(expected).every(([name, value]) => {
        const source = product.specs[name];
        if (!source || source.sourceUrl !== product.url) return false;
        return name === "型号"
          ? value.startsWith(source.value)
          : value.toLowerCase() === source.value.toLowerCase();
      });
    if (proven && match) {
      const value = `复印纸${match[2]}g${match[3]}包/箱${match[4]}张`;
      if (value.length <= 20)
        return {
          ...fact,
          value,
          evidence:
            fact.evidence +
            `；包装显示规则 copy-paper-packing/1：完整名称“${fact.value}”，省略重复型号及系列，保留品类、克重、每箱包数和总张数`,
        };
    }
    return fact;
  }
  if (categoryId !== "10049005")
    return clockPackingDisplayFact(categoryId, fact);
  if (
    fact.value.length <= 20 ||
    fact.sourceUrl !== product.url ||
    forbidden.test(fact.value)
  )
    return fact;
  const brand = product.specs["品牌"],
    model = product.specs["货号"];
  if (
    !brand ||
    !model ||
    brand.sourceUrl !== product.url ||
    model.sourceUrl !== product.url
  )
    return fact;
  const prefix = brand.value.trim() + model.value.trim();
  if (!prefix || !fact.value.startsWith(prefix)) return fact;
  const rest = fact.value.slice(prefix.length).trim();
  const match = rest.match(
    /^(彩色长尾(?:票)?夹)([1-9]\d*(?:\.\d+)?mm)筒装[（(]混[）)][（(]([1-9]\d*只\/筒)[）)]$/u,
  );
  if (!match) return fact;
  const value = `${match[1]}${match[2]}(${match[3]})`;
  if (value.length > 20) return fact;
  return {
    ...fact,
    value,
    evidence:
      fact.evidence +
      `；包装显示规则 clip-packing/1：完整名称“${fact.value}”，仅缩短重复品牌型号和筒装标记，保留类型、颜色、尺寸及每筒数量`,
  };
}
