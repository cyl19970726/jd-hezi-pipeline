export const CLOCK_TEXT_RULES_VERSION = "clock-title/1";

export type ClockTitleField = "类型" | "类别" | "型号";

export interface ClockTitleDerivation {
  value: string;
  quote: string;
  rule: string;
}

const clockKinds = ["挂钟", "闹钟"] as const;
const modelAfterClockContext =
  /(?:挂钟|闹钟|钟表|时钟|挂墙)\s*(?:型号[:：]?\s*)?([a-z]?\d{3,6}[a-z]?(?:-[a-z0-9]{1,4})?)(?![a-z0-9-])/gi;

function titleQuote(title: string) {
  const compact = title.trim().replace(/\s+/g, " ");
  return compact.length <= 180 ? compact : `${compact.slice(0, 177)}...`;
}

function explicitKind(title: string): (typeof clockKinds)[number] | null {
  const found = clockKinds.filter((kind) => title.includes(kind));
  return found.length === 1 ? found[0] : null;
}

function explicitModel(title: string, sku: string): string | null {
  const values = new Map<string, string>();
  for (const match of title.matchAll(modelAfterClockContext)) {
    const value = match[1];
    const normalized = value.toUpperCase();
    if (value === sku || normalized === sku.toUpperCase()) continue;
    if (!/\d/.test(value)) continue;
    if (/^(?:19|20)\d{2}$/.test(value)) continue;
    if (/^\d+(?:cm|mm|m|inch)$/i.test(value)) continue;
    if (/^\d+$/.test(value) && !/^\d{3,6}$/.test(value)) continue;
    values.set(normalized, value);
  }
  return values.size === 1 ? [...values.values()][0] : null;
}

/** Conservatively derives clock fields from one current-SKU title. */
export function deriveClockTitleField(
  title: string,
  sku: string,
  field: ClockTitleField,
): ClockTitleDerivation | null {
  const kind = explicitKind(title);
  if (!kind) return null;
  const value = field === "型号" ? explicitModel(title, sku) : kind;
  if (!value) return null;
  return {
    value,
    quote: `商品标题“${titleQuote(title)}”`,
    rule: CLOCK_TEXT_RULES_VERSION,
  };
}
