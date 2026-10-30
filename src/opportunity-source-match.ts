import type { Product } from "./model.js";
import { brandEquivalent, primaryBrand } from "./brand-identity.js";

export type SourceMatchFieldName = "brand" | "model" | "packaging";

export interface SourceMatchField {
  field: SourceMatchFieldName;
  marketValue: string;
  sourceValue: string;
  marketEvidenceUrl: string;
  sourceEvidenceUrl: string;
  marketEvidence?: { path: string; value: string };
  sourceEvidence?: {
    spec: string;
    value: string;
    capturedAt: string;
    evidence: string;
    participants?: Array<{
      spec: string;
      value: string;
      sourceUrl: string;
      capturedAt: string;
      evidence: string;
    }>;
  };
}

export interface CompareMarketSourceInput {
  marketPayload: unknown;
  marketItemId: string;
  marketSkuId: string;
  marketShopId: string;
  source: Product;
  detailReceiptId: string;
  marketCheckedAt: string;
  /** Independently searched candidate receipt; permits comparison when the market SKU has no JD link. */
  candidateDiscovery?: { receiptId: string; query: string };
}

export interface SourceMatchResult {
  matched: boolean;
  fields: SourceMatchField[];
  blockers: string[];
  sourceSku: string;
  detailReceiptId: string;
  checkedAt: string;
  categoryMapping?: {
    marketCategoryId: "10015";
    publishCategoryId: "10015007";
    rule: "copy-paper-parent-to-leaf/barcode-and-full-signature-v1";
    barcode: string;
    marketEvidencePath: string;
    sourceEvidenceSpec: string;
  };
}

export type SourceCandidateLane = "exact" | "substitute";

export interface SourceCandidateSearchPlan {
  lane: SourceCandidateLane;
  queries: string[];
  evidence: Array<{ field: string; value: string; path: string }>;
  blockers: string[];
}

export interface PlanSourceCandidateSearchInput {
  lane: SourceCandidateLane;
  marketPayload: unknown;
  marketSkuId: string;
  /** Required for substitutes because a substitute must not be inferred from an exact-match row. */
  explicitSubstituteTerms?: string[];
}

type Candidate = { value: string; path: string };
type SourceCandidate = Candidate & {
  spec: string;
  capturedAt: string;
  evidence: string;
  sourceUrl: string;
};

const MAX_AGE_MS = 3_600_000;
const FUTURE_SKEW_MS = 60_000;
const MATERIAL_ATTRIBUTE =
  /^(?:净含量|容量|含量|重量|克重|尺寸|颜色|色号|香型|香味|口味|味道|款式|版本|型号|规格|包装|数量|支数|片数|袋数|瓶数|盒数|层数|抽数|张数|电压|功率|能效等级|capacity|color|colour|flavou?r|scent|size|weight|volume|model|spec(?:ification)?|pack(?:aging)?|count)$/i;
const PLACEHOLDER = /^(?:无|暂无|未知|n\/?a|--)$/i;

function normalized(value: string) {
  return value
    .normalize("NFKC")
    .replace(/×/gu, "*")
    .replace(/(?<=\d)[xX](?=\d)/gu, "*")
    .replace(/\s+/gu, "")
    .toLocaleLowerCase();
}

function normalizedPackaging(value: string) {
  return normalized(value)
    .replace(/(\d+(?:\.\d+)?)m(?=[^a-z]|$)/giu, "$1米")
    .replace(
      /(千克|毫升|kg|ml|米|层|克|升|卷|包|盒|瓶|抽|张|片|支|g|l)\*(?=\d)/giu,
      "$1",
    );
}

function clipPackSignature(
  candidates: Candidate[],
  saleUnit?: Candidate | null,
) {
  const text = candidates
    .map(({ value }) => value)
    .join(" ")
    .normalize("NFKC")
    .toLocaleLowerCase();
  if (!/(?:长尾夹|长尾票夹)/u.test(text) || !/彩色/u.test(text)) return null;
  const sizes = [...text.matchAll(/(\d+(?:\.\d+)?)\s*mm(?![a-z])/giu)].map(
    (match) => String(Number(match[1])),
  );
  const counts = [...text.matchAll(/(\d+)\s*(?:只|个)/gu)].map((match) =>
    String(Number(match[1])),
  );
  const units = [
    ...text.matchAll(/(?:[/／]\s*(筒|盒|包|袋)|(筒|盒|包|袋)装)/gu),
  ].map((match) => match[1] ?? match[2]);
  if (saleUnit?.value) units.push(normalized(saleUnit.value));
  const colors = [
    ...text.matchAll(
      /(?:马卡龙色|彩色|混色|黑色|白色|红色|蓝色|绿色|黄色|紫色|橙色|灰色|粉色|棕色|咖啡色|金色|银色)/gu,
    ),
  ].map((match) =>
    /^(?:彩色|混色|马卡龙色)$/u.test(match[0]) ? "彩色" : match[0],
  );
  const distinctSizes = [...new Set(sizes)];
  const distinctCounts = [...new Set(counts)];
  const distinctUnits = [...new Set(units)];
  const distinctColors = [...new Set(colors)];
  if (
    distinctSizes.length !== 1 ||
    distinctCounts.length !== 1 ||
    distinctUnits.length !== 1 ||
    distinctUnits[0] !== "筒" ||
    distinctColors.length !== 1 ||
    distinctColors[0] !== "彩色"
  )
    return null;
  return {
    value: `长尾夹|${distinctSizes[0]}mm|彩色|${distinctCounts[0]}只/筒`,
    paths: [
      ...candidates.map(({ path }) => path),
      ...(saleUnit ? [saleUnit.path] : []),
    ],
  };
}

function archiveBoxSignature(
  candidates: Candidate[],
  saleUnit?: Candidate | null,
) {
  const value = candidates
    .map((candidate) => candidate.value)
    .join(" ")
    .normalize("NFKC")
    .toLocaleLowerCase();
  if (!/(?:档案盒|资料盒|文件盒)/u.test(value)) return null;
  const widths = [...value.matchAll(/(\d+(?:\.\d+)?)\s*mm(?![a-z])/giu)].map(
    (match) => String(Number(match[1])),
  );
  const quantities = [
    ...value.matchAll(/(?:(\d+)\s*(只|件|个)(?:装)?|单个装)/gu),
  ].map((match) => ({
    count: String(Number(match[1] ?? "1")),
    unit: match[2] ?? "个",
  }));
  const counts = quantities.map((quantity) => quantity.count);
  const units = [
    ...quantities.map((quantity) => quantity.unit),
    ...value.matchAll(/单位[:：]?\s*(只|件|个)/gu),
  ].map((entry) => (typeof entry === "string" ? entry : entry[1]));
  if (saleUnit?.value) units.push(normalized(saleUnit.value));
  const colors = [
    ...value.matchAll(
      /(?:黑色|白色|红色|蓝色|绿色|黄色|紫色|橙色|灰色|粉色|棕色|咖啡色|金色|银色)/gu,
    ),
  ].map((match) => match[0]);
  const materials = [...value.matchAll(/(?:pp|pvc|纸质)/giu)].map((match) =>
    match[0].toLocaleLowerCase(),
  );
  const width = [...new Set(widths)];
  const count = [...new Set(counts)];
  const unit = [...new Set(units)];
  const color = [...new Set(colors)];
  const material = [...new Set(materials)];
  if (
    width.length !== 1 ||
    count.length !== 1 ||
    unit.length !== 1 ||
    unit[0] !== "个" ||
    color.length !== 1 ||
    material.length !== 1
  )
    return null;
  return {
    value: `档案盒|${width[0]}mm|${color[0]}|${material[0]}|${count[0]}个`,
    paths: [
      ...candidates.map((candidate) => candidate.path),
      ...(saleUnit ? [saleUnit.path] : []),
    ],
  };
}

function gelPenSignature(candidates: Candidate[], saleUnit?: Candidate | null) {
  const value = candidates
    .map((candidate) => candidate.value)
    .join(" ")
    .normalize("NFKC")
    .toLocaleLowerCase();
  if (!/中性笔/u.test(value)) return null;
  const counts = [...value.matchAll(/(\d+)\s*支(?:装)?/gu)].map((match) =>
    String(Number(match[1])),
  );
  const units = [
    ...value.matchAll(/(?:[/／]\s*(盒)|(盒)装|单位[:：]?\s*(盒))/gu),
  ].map((match) => match[1] ?? match[2] ?? match[3]);
  if (saleUnit?.value) units.push(normalized(saleUnit.value));
  const colors = [
    ...value.matchAll(
      /(?:黑色|白色|红色|蓝色|绿色|黄色|紫色|橙色|灰色|粉色|棕色|咖啡色)/gu,
    ),
  ].map((match) => match[0]);
  const widths = [...value.matchAll(/(\d+(?:\.\d+)?)\s*mm(?![a-z])/giu)].map(
    (match) => String(Number(match[1])),
  );
  const count = [...new Set(counts)];
  const unit = [...new Set(units)];
  const color = [...new Set(colors)];
  const width = [...new Set(widths)];
  if (
    count.length !== 1 ||
    unit.length !== 1 ||
    unit[0] !== "盒" ||
    color.length !== 1 ||
    width.length !== 1
  )
    return null;
  return {
    value: `中性笔|${width[0]}mm|${color[0]}|${count[0]}支/盒`,
    paths: [
      ...candidates.map((candidate) => candidate.path),
      ...(saleUnit ? [saleUnit.path] : []),
    ],
  };
}

type CopyPaperSignature = { value: string; model: string; paths: string[] };

function copyPaperSignature(
  candidates: Candidate[],
  saleUnit?: Candidate | null,
): CopyPaperSignature | null {
  const raw = candidates
    .map((candidate) =>
      "spec" in candidate
        ? `${String((candidate as SourceCandidate).spec)}:${candidate.value}`
        : candidate.value,
    )
    .join(" ")
    .normalize("NFKC");
  const titleRaw = candidates
    .filter(
      (candidate) =>
        candidate.path === "source.title" ||
        candidate.path.endsWith(".skuName"),
    )
    .map(({ value }) => value)
    .join(" ")
    .normalize("NFKC");
  if (!/复印纸/u.test(raw)) return null;
  const numbers = (pattern: RegExp) => [
    ...new Set(
      [...raw.matchAll(pattern)].map((match) => String(Number(match[1]))),
    ),
  ];
  const strings = (pattern: RegExp) => [
    ...new Set(
      [...raw.matchAll(pattern)].map((match) => match[1].toUpperCase()),
    ),
  ];
  const alphaModels = [
    ...new Set(
      [
        ...titleRaw.matchAll(
          /(?<![A-Z0-9])([A-Z]{1,4}\d{3,}[A-Z0-9-]*)(?![A-Z0-9])/giu,
        ),
      ].map((match) => match[1].toUpperCase()),
    ),
  ].filter((value) => !/^A\d+$/u.test(value));
  const numericModels = [
    ...new Set(
      [...titleRaw.matchAll(/(?<![A-Z0-9])(\d{4,})(?![A-Z0-9])/giu)]
        .filter((match) => {
          const value = Number(match[1]);
          const suffix = titleRaw.slice(match.index! + match[0].length);
          return (
            match[1].length <= 6 &&
            (value < 1900 || value > 2099) &&
            !/^\s*(?:张|页|包|箱|g|克|mm|cm|毫米|厘米)/iu.test(suffix) &&
            (match.index! < 24 || /^\s*(?:【|$)/u.test(suffix))
          );
        })
        .map((match) => match[1]),
    ),
  ];
  const models = [...new Set([...alphaModels, ...numericModels])];
  const explicitModels = [
    ...new Set(
      [...raw.matchAll(/(?:型号|货号):([^\s;]+)/gu)].map((match) =>
        match[1].toUpperCase(),
      ),
    ),
  ];
  const labeled = (name: string) => [
    ...new Set(
      [...raw.matchAll(new RegExp(`(?:^|\\s)${name}:([^\\s;]+)`, "gu"))].map(
        (match) => match[1],
      ),
    ),
  ];
  const explicitSizes = [...labeled("纸张尺寸"), ...labeled("复印纸规格")];
  const explicitSpecs = labeled("规格");
  const explicitColors = labeled("颜色");
  const explicitWeights = labeled("克重");
  const explicitPackCounts = labeled("包数");
  const explicitSheetCounts = labeled("张数");
  const formats = strings(/(?<![A-Z0-9])(A\d+)(?!\d)/giu);
  const weights = numbers(/(\d+(?:\.\d+)?)\s*(?:g(?![a-z])|克(?!重))/giu);
  const multiplied = [...raw.matchAll(/(\d+)\s*张\s*[x×*]\s*(\d+)\s*包/gu)];
  const sheetsPerPack = [
    ...new Set([
      ...numbers(/(\d+)\s*张\s*[\/／每]\s*包/gu),
      ...multiplied.map((match) => String(Number(match[1]))),
    ]),
  ];
  const packsPerBox = [
    ...new Set([
      ...numbers(/(\d+)\s*包(?:装(?![:：])|\s*[\/／每]\s*箱)/gu),
      ...multiplied.map((match) => String(Number(match[2]))),
      ...numbers(/[（(]\s*(\d+)\s*包\s*[）)]/gu),
    ]),
  ];
  const totals = numbers(/(?:总计|共|整箱|张数[:：]?)\s*(\d+)\s*张/gu);
  const colors = [
    ...new Set(
      [
        ...raw.matchAll(
          /(?:灰白色|米白色|本白色|白色|彩色|黑色|红色|蓝色|绿色|黄色|灰色|粉色|紫色)/gu,
        ),
      ].map((match) => match[0]),
    ),
  ];
  const units = saleUnit?.value
    ? [normalized(saleUnit.value)]
    : /(?:^|[^\d])(?:1|一)\s*箱(?:装|[（(]|\s|$)/u.test(raw)
      ? ["箱"]
      : [];
  if (
    [models, formats, weights, sheetsPerPack, packsPerBox, colors, units].some(
      (values) => values.length !== 1,
    ) ||
    (explicitModels.length > 0 &&
      (explicitModels.length !== 1 || explicitModels[0] !== models[0])) ||
    explicitSizes.some((value) => value.toUpperCase() !== "A4") ||
    explicitSpecs.some(
      (value) =>
        !/^A4$/iu.test(value) &&
        !new RegExp(`^${packsPerBox[0]}\\s*包装$`, "u").test(value),
    ) ||
    explicitColors.some((value) => value !== "白色") ||
    explicitWeights.some((value) => {
      if (new RegExp(`^${weights[0]}\\s*(?:g|克)$`, "iu").test(value))
        return false;
      return !(
        value === weights[0] &&
        new RegExp(`${weights[0]}\\s*g`, "iu").test(titleRaw)
      );
    }) ||
    explicitPackCounts.some(
      (value) => !new RegExp(`^${packsPerBox[0]}\\s*包装$`, "u").test(value),
    ) ||
    explicitSheetCounts.some(
      (value) =>
        !new RegExp(
          `^${Number(sheetsPerPack[0]) * Number(packsPerBox[0])}\\s*张$`,
          "u",
        ).test(value),
    ) ||
    formats[0] !== "A4" ||
    colors[0] !== "白色" ||
    units[0] !== "箱" ||
    (totals.length > 0 &&
      (totals.length !== 1 ||
        Number(sheetsPerPack[0]) * Number(packsPerBox[0]) !==
          Number(totals[0])))
  )
    return null;
  const total = String(Number(sheetsPerPack[0]) * Number(packsPerBox[0]));
  return {
    model: models[0],
    value: `复印纸|${models[0]}|${formats[0]}|${weights[0]}g|${colors[0]}|${sheetsPerPack[0]}张/包|${packsPerBox[0]}包/箱|总${total}张|箱`,
    paths: [
      ...candidates.map(({ path }) => path),
      ...(saleUnit ? [saleUnit.path] : []),
    ],
  };
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function id(value: unknown): string | null {
  return typeof value === "string" ||
    (typeof value === "number" && Number.isSafeInteger(value))
    ? String(value)
    : null;
}

function exactJdUrl(value: string, sku: string) {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.hostname === "item.jd.com" &&
      url.pathname === `/${sku}.html` &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}

function jdSkuFromUrl(value: string) {
  try {
    const url = new URL(value);
    const match = url.pathname.match(/^\/(\d+)\.html$/u);
    return url.protocol === "https:" &&
      url.hostname === "item.jd.com" &&
      !url.username &&
      !url.password &&
      match
      ? match[1]
      : null;
  } catch {
    return null;
  }
}

function fresh(value: string, now: number) {
  const at = Date.parse(value);
  return (
    Number.isFinite(at) && at <= now + FUTURE_SKEW_MS && now - at <= MAX_AGE_MS
  );
}

function add(
  map: Map<string, Candidate[]>,
  name: unknown,
  value: unknown,
  path: string,
) {
  const key = text(name)?.normalize("NFKC").trim();
  const candidate = text(value);
  if (!key || !candidate) return;
  const values = map.get(key) ?? [];
  values.push({ value: candidate, path });
  map.set(key, values);
}

function parseSpecString(
  map: Map<string, Candidate[]>,
  value: unknown,
  path: string,
) {
  const raw = text(value);
  if (!raw) return;
  for (const part of raw.split(/[;；]/u)) {
    const separator = part.search(/[:：]/u);
    if (separator <= 0) continue;
    add(map, part.slice(0, separator), part.slice(separator + 1), path);
  }
}

function distinct(candidates: Candidate[]) {
  const result = new Map<string, Candidate>();
  for (const candidate of candidates)
    result.set(normalized(candidate.value), candidate);
  return [...result.values()];
}

function jdLinks(raw: unknown) {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    const value = text((entry as any)?.url);
    return value ? [value] : [];
  });
}

/** Builds bounded keyword requests from explicit selected-SKU facts only. */
export function planSourceCandidateSearch(
  input: PlanSourceCandidateSearchInput,
): SourceCandidateSearchPlan {
  const blockers: string[] = [];
  const evidence: SourceCandidateSearchPlan["evidence"] = [];
  if (input.lane === "substitute") {
    const terms = distinct(
      (input.explicitSubstituteTerms ?? []).flatMap((value, index) => {
        const term = text(value);
        return term
          ? [{ value: term, path: `explicitSubstituteTerms[${index}]` }]
          : [];
      }),
    );
    if (!terms.length)
      blockers.push("替代候选必须提供已审核的明确检索词，不能从同款机会推断");
    evidence.push(
      ...terms.map((term) => ({ field: "substitute-term", ...term })),
    );
    return {
      lane: "substitute",
      queries: terms.length ? [terms.map((term) => term.value).join(" ")] : [],
      evidence,
      blockers,
    };
  }

  const raw: any = input.marketPayload;
  const publish = raw?.data?.itemPublishVo;
  const selected = (
    Array.isArray(raw?.data?.itemSkuInfoList) ? raw.data.itemSkuInfoList : []
  ).filter((sku: any) => id(sku?.id) === input.marketSkuId);
  if (selected.length !== 1) blockers.push("竞品详情没有唯一的目标销售SKU");
  const attrs = new Map<string, Candidate[]>();
  const sku = selected[0];
  const mapped = publish?.skuSpecMap?.[input.marketSkuId];
  if (Array.isArray(mapped))
    mapped.forEach((attr: any, index: number) =>
      add(
        attrs,
        attr?.attrName,
        attr?.attrValue,
        `data.itemPublishVo.skuSpecMap.${input.marketSkuId}[${index}]`,
      ),
    );
  parseSpecString(
    attrs,
    sku?.specAttributes,
    "data.itemSkuInfoList[target].specAttributes",
  );
  parseSpecString(
    attrs,
    sku?.attributesName,
    "data.itemSkuInfoList[target].attributesName",
  );
  add(attrs, "型号", sku?.modelCode, "data.itemSkuInfoList[target].modelCode");
  const brands = distinct(
    ["brandName", "brandNameCh", "brandNameEn"].flatMap((name) => {
      const value = text(publish?.[name]);
      return value ? [{ value, path: `data.itemPublishVo.${name}` }] : [];
    }),
  );
  evidence.push(...brands.map((brand) => ({ field: "brand", ...brand })));
  const models = distinct(
    ["型号", "商品型号", "产品型号"].flatMap((name) => attrs.get(name) ?? []),
  );
  if (models.length === 1) evidence.push({ field: "model", ...models[0] });
  else if (models.length > 1) blockers.push("型号存在冲突的重复事实");
  const packaging = distinct(attrs.get("规格") ?? []);
  if (packaging.length === 1)
    evidence.push({ field: "packaging", ...packaging[0] });
  else if (packaging.length > 1) blockers.push("销售包装存在冲突的重复事实");
  if (!brands.length) blockers.push("品牌缺少可核验的明确事实");
  const selectedTitle = text(sku?.skuName);
  if (!models.length && selectedTitle)
    evidence.push({
      field: "selected-sku-title",
      value: selectedTitle,
      path: "data.itemSkuInfoList[target].skuName",
    });
  if (!models.length && !selectedTitle)
    blockers.push("型号与所选销售SKU标题均缺少，无法生成有界检索词");
  const queries = blockers.length
    ? []
    : brands
        .slice(0, 2)
        .map((brand) =>
          [brand.value, models[0]?.value ?? selectedTitle, packaging[0]?.value]
            .filter(Boolean)
            .join(" "),
        );
  return { lane: "exact", queries: [...new Set(queries)], evidence, blockers };
}

export function compareMarketSource(
  input: CompareMarketSourceInput,
  now = Date.now(),
): SourceMatchResult {
  const blockers: string[] = [];
  const fields: SourceMatchField[] = [];
  let categoryMapping: SourceMatchResult["categoryMapping"];
  const usedTimes = new Set([input.marketCheckedAt, input.source.capturedAt]);
  const block = (message: string) => {
    if (!blockers.includes(message)) blockers.push(message);
  };
  const raw: any = input.marketPayload;
  const data = raw?.data;
  const publish = data?.itemPublishVo;
  const skus = Array.isArray(data?.itemSkuInfoList) ? data.itemSkuInfoList : [];
  const selected = skus.filter((sku: any) => id(sku?.id) === input.marketSkuId);

  if (
    id(data?.itemId) !== input.marketItemId ||
    id(publish?.id) !== input.marketItemId ||
    id(publish?.shopId) !== input.marketShopId
  )
    block("竞品详情身份与冻结的商品或店铺不一致");
  if (selected.length !== 1) block("竞品详情没有唯一的目标销售SKU");
  const sku = selected[0];
  if (
    sku &&
    (id(sku.itemId) !== input.marketItemId ||
      (sku.shopId !== undefined && id(sku.shopId) !== input.marketShopId))
  )
    block("目标销售SKU的商品或店铺身份不一致");

  if (!fresh(input.marketCheckedAt, now))
    block("竞品详情证据无效或已超过1小时");
  if (!input.detailReceiptId.trim()) block("竞品详情回执缺失");

  if (!/^\d+$/.test(input.source.sku)) block("京东SKU身份无效");
  if (!exactJdUrl(input.source.url, input.source.sku))
    block("京东商品链接没有精确指向来源SKU");
  if (!fresh(input.source.capturedAt, now))
    block("京东商品证据无效或已超过1小时");
  const rawFacts = [
    ["标题", input.source.title] as const,
    ...(input.source.price ? [["价格", input.source.price] as const] : []),
    ...Object.entries(input.source.specs),
  ];
  for (const [name, fact] of rawFacts) {
    if (!exactJdUrl(fact.sourceUrl, input.source.sku))
      block(`京东事实“${name}”的证据链接不匹配来源SKU`);
    if (!fresh(fact.capturedAt, now))
      block(`京东事实“${name}”的证据无效或已超过1小时`);
  }

  const links = jdLinks(sku?.skuPicUrls);
  if (input.candidateDiscovery) {
    if (
      !input.candidateDiscovery.receiptId.trim() ||
      !input.candidateDiscovery.query.trim()
    )
      block("独立京东候选搜索回执无效");
    const linkedSkus = links.map(jdSkuFromUrl);
    if (
      links.length &&
      (linkedSkus.some((linkedSku) => !linkedSku) ||
        !linkedSkus.includes(input.source.sku))
    )
      block("目标销售SKU已有京东来源链接，但与独立候选不一致");
  } else if (
    links.length !== 1 ||
    !exactJdUrl(links[0] ?? "", input.source.sku)
  )
    block("目标销售SKU必须有且仅有一个精确匹配的京东来源链接");

  const marketUrl = `https://b.csgmall.com.cn/mall-view/product/detail?itemId=${encodeURIComponent(input.marketItemId)}&skuId=${encodeURIComponent(input.marketSkuId)}`;
  const attrs = new Map<string, Candidate[]>();
  const itemSkuMap = publish?.skuSpecMap;
  const mapped = itemSkuMap?.[input.marketSkuId];
  if (Array.isArray(mapped))
    mapped.forEach((attr: any, index: number) =>
      add(
        attrs,
        attr?.attrName,
        attr?.attrValue,
        `data.itemPublishVo.skuSpecMap.${input.marketSkuId}[${index}]`,
      ),
    );
  const selectedAttributeLists: Array<[unknown, boolean, string]> = [
    [sku?.specAttributesList, false, "data.itemSkuInfoList[target]"],
    [publish?.specAttributes, true, "data.itemPublishVo"],
  ];
  selectedAttributeLists.forEach(([list, requireSkuId, path]) => {
    if (!Array.isArray(list)) return;
    list.forEach((attr: any, index: number) => {
      if (requireSkuId && id(attr?.skuId) !== input.marketSkuId) return;
      if (attr?.skuId !== undefined && id(attr.skuId) !== input.marketSkuId)
        return;
      if (attr?.itemId !== undefined && id(attr.itemId) !== input.marketItemId)
        return;
      add(
        attrs,
        attr?.attributeName ?? attr?.attrName,
        attr?.attributeValue ?? attr?.attrValue,
        `${path}.specAttributesList[${index}]`,
      );
    });
  });
  parseSpecString(
    attrs,
    sku?.specAttributes,
    "data.itemSkuInfoList[target].specAttributes",
  );
  parseSpecString(
    attrs,
    sku?.attributesName,
    "data.itemSkuInfoList[target].attributesName",
  );
  add(attrs, "型号", sku?.modelCode, "data.itemSkuInfoList[target].modelCode");

  const sourceFacts = new Map<string, SourceCandidate[]>();
  for (const [name, fact] of Object.entries(input.source.specs)) {
    const candidate: SourceCandidate = {
      value: fact.value,
      path: `source.specs.${name}`,
      spec: name,
      capturedAt: fact.capturedAt,
      evidence: fact.evidence,
      sourceUrl: fact.sourceUrl,
    };
    const list = sourceFacts.get(name) ?? [];
    list.push(candidate);
    sourceFacts.set(name, list);
  }

  const sourceFor = (names: string[]) =>
    names.flatMap((name) => sourceFacts.get(name) ?? []);
  const validSource = (candidate: SourceCandidate) => {
    if (!exactJdUrl(candidate.sourceUrl, input.source.sku)) {
      block(`京东规格“${candidate.spec}”的证据链接不匹配来源SKU`);
      return false;
    }
    if (!fresh(candidate.capturedAt, now)) {
      block(`京东规格“${candidate.spec}”的证据无效或已超过1小时`);
      return false;
    }
    usedTimes.add(candidate.capturedAt);
    return true;
  };

  const compare = (
    field: SourceMatchFieldName,
    marketCandidates: Candidate[],
    sourceCandidates: SourceCandidate[],
  ) => {
    const normalizeField =
      field === "packaging" ? normalizedPackaging : normalized;
    const fieldDistinct = <T extends Candidate>(candidates: T[]) => {
      const result = new Map<string, T>();
      for (const candidate of candidates)
        result.set(normalizeField(candidate.value), candidate);
      return [...result.values()];
    };
    const markets = fieldDistinct(marketCandidates);
    const sources = fieldDistinct(
      sourceCandidates.filter(validSource),
    ) as SourceCandidate[];
    if (!markets.length || !sources.length) {
      block(
        `${field === "brand" ? "品牌" : field === "model" ? "型号" : "销售包装"}缺少可核验的明确事实`,
      );
      return;
    }
    if (markets.length > 1 || sources.length > 1) {
      block(
        `${field === "brand" ? "品牌" : field === "model" ? "型号" : "销售包装"}存在冲突的重复事实`,
      );
      return;
    }
    const market = markets[0];
    const source = sources[0];
    if (
      field !== "brand" &&
      (PLACEHOLDER.test(normalized(market.value)) ||
        PLACEHOLDER.test(normalized(source.value)))
    ) {
      block(
        `${field === "model" ? "型号" : "销售包装"}是占位值，不能作为同款证据`,
      );
      return;
    }
    if (normalizeField(market.value) !== normalizeField(source.value)) {
      block(
        `${field === "brand" ? "品牌" : field === "model" ? "型号" : "销售包装"}不一致`,
      );
      return;
    }
    fields.push({
      field,
      marketValue: normalizeField(market.value),
      sourceValue: normalizeField(source.value),
      marketEvidenceUrl: marketUrl,
      sourceEvidenceUrl: source.sourceUrl,
      marketEvidence: market,
      sourceEvidence: {
        spec: source.spec,
        value: source.value,
        capturedAt: source.capturedAt,
        evidence: source.evidence,
      },
    });
  };

  const marketBrands = ["brandName", "brandNameCh", "brandNameEn"].flatMap(
    (key) => {
      const value = text(publish?.[key]);
      return value ? [{ value, path: `data.itemPublishVo.${key}` }] : [];
    },
  );
  // Explicit Chinese/English brand names are aliases. They need not equal each other.
  const sourceBrands = sourceFor(["品牌"]);
  const validBrands = distinct(
    sourceBrands.filter(validSource),
  ) as SourceCandidate[];
  const marketBrandMatch = marketBrands.find((market) =>
    validBrands.some((source) => brandEquivalent(source.value, market.value)),
  );
  const sourceBrandMatch = validBrands.find(
    (source) =>
      marketBrandMatch && brandEquivalent(source.value, marketBrandMatch.value),
  );
  if (!marketBrandMatch || !sourceBrandMatch)
    block("品牌缺失或与明确的中英文品牌名均不一致");
  else
    fields.push({
      field: "brand",
      marketValue: primaryBrand(marketBrandMatch.value),
      sourceValue: primaryBrand(sourceBrandMatch.value),
      marketEvidenceUrl: marketUrl,
      sourceEvidenceUrl: sourceBrandMatch.sourceUrl,
      marketEvidence: marketBrandMatch,
      sourceEvidence: {
        spec: sourceBrandMatch.spec,
        value: sourceBrandMatch.value,
        capturedAt: sourceBrandMatch.capturedAt,
        evidence: sourceBrandMatch.evidence,
      },
    });

  const marketCategoryId = id(publish?.cid);
  const copyPaperLeaf =
    marketCategoryId === "10015007" &&
    /复印纸/u.test(text(publish?.categoryFullName) ?? "");
  const copyPaperParent =
    marketCategoryId === "10015" &&
    text(publish?.categoryFullName) === "办公用品>办公耗材>办公用纸";
  const copyPaperCategory = copyPaperLeaf || copyPaperParent;
  if (!copyPaperCategory)
    compare(
      "model",
      [
        ...(attrs.get("型号") ?? []),
        ...(attrs.get("商品型号") ?? []),
        ...(attrs.get("产品型号") ?? []),
      ],
      sourceFor(["型号", "商品型号", "产品型号", "货号"]),
    );
  const marketPackaging = [
    ...(attrs.get("规格") ?? []),
    ...(text(publish?.packingList)
      ? [
          {
            value: text(publish.packingList)!,
            path: "data.itemPublishVo.packingList",
          },
        ]
      : []),
  ];
  const sourcePackaging = sourceFor(["京东销售规格", "包装清单", "规格"]);
  const marketClipCandidates: Candidate[] = [
    ...(text(publish?.itemName)
      ? [
          {
            value: text(publish.itemName)!,
            path: "data.itemPublishVo.itemName",
          },
        ]
      : []),
    ...(text(sku?.skuName)
      ? [
          {
            value: text(sku.skuName)!,
            path: "data.itemSkuInfoList[target].skuName",
          },
        ]
      : []),
    ...(attrs.get("类型") ?? []),
    ...(attrs.get("规格") ?? []),
    ...(attrs.get("颜色") ?? []),
    ...(attrs.get("尺寸") ?? []),
    ...(attrs.get("尺寸规格") ?? []),
    ...(attrs.get("数量") ?? []),
    ...(attrs.get("包装") ?? []),
    ...(attrs.get("材质") ?? []),
    ...(text(publish?.packingList)
      ? [
          {
            value: text(publish.packingList)!,
            path: "data.itemPublishVo.packingList",
          },
        ]
      : []),
  ];
  const marketSaleUnit = text(sku?.skuUnit)
    ? {
        value: text(sku.skuUnit)!,
        path: "data.itemSkuInfoList[target].skuUnit",
      }
    : null;
  const marketCopyCandidates: Candidate[] = copyPaperCategory
    ? [
        ...(text(sku?.skuName)
          ? [
              {
                value: text(sku.skuName)!,
                path: "data.itemSkuInfoList[target].skuName",
              },
            ]
          : []),
        ...[...attrs.entries()].flatMap(([name, values]) =>
          values.map((candidate) => ({
            ...candidate,
            value: `${name}:${candidate.value}`,
          })),
        ),
        ...(text(publish?.packingList)
          ? [
              {
                value: text(publish.packingList)!,
                path: "data.itemPublishVo.packingList",
              },
            ]
          : []),
      ]
    : [];
  const sourceCopyCandidates: SourceCandidate[] = copyPaperCategory
    ? [
        {
          value: input.source.title.value,
          path: "source.title",
          spec: "商品标题",
          capturedAt: input.source.title.capturedAt,
          evidence: input.source.title.evidence,
          sourceUrl: input.source.title.sourceUrl,
        },
        ...sourceFor([
          "型号",
          "货号",
          "克重",
          "颜色",
          "规格",
          "纸张尺寸",
          "张数",
          "包数",
          "包装清单",
          "京东销售规格",
        ]),
      ].filter(validSource)
    : [];
  const marketCopyPaper = copyPaperCategory
    ? copyPaperSignature(marketCopyCandidates, marketSaleUnit)
    : null;
  const sourceCopyPaper = copyPaperCategory
    ? copyPaperSignature(sourceCopyCandidates)
    : null;
  if (
    copyPaperParent &&
    marketCopyPaper &&
    sourceCopyPaper &&
    marketCopyPaper.value === sourceCopyPaper.value
  ) {
    const marketBarcodes = distinct([
      ...(attrs.get("商品条形码") ?? []),
      ...(attrs.get("商品条码") ?? []),
    ]);
    const sourceBarcodes = distinct(
      sourceFor(["商品条形码", "商品条码"]).filter(validSource),
    ) as SourceCandidate[];
    if (
      marketBarcodes.length === 1 &&
      sourceBarcodes.length === 1 &&
      /^\d{13}$/u.test(marketBarcodes[0].value) &&
      marketBarcodes[0].value === sourceBarcodes[0].value
    )
      categoryMapping = {
        marketCategoryId: "10015",
        publishCategoryId: "10015007",
        rule: "copy-paper-parent-to-leaf/barcode-and-full-signature-v1",
        barcode: marketBarcodes[0].value,
        marketEvidencePath: marketBarcodes[0].path,
        sourceEvidenceSpec: sourceBarcodes[0].spec,
      };
    else block("复印纸父类目映射缺少双方同一明确商品条码");
  }
  if (copyPaperCategory) {
    if (!marketCopyPaper || !sourceCopyPaper)
      block("复印纸型号或包装事实缺失、冲突或层级数量无法闭合");
    else if (marketCopyPaper.value !== sourceCopyPaper.value)
      block("复印纸型号、规格、克重、颜色、数量层级或销售单位不一致");
    else {
      const sourceTitle = sourceCopyCandidates.find(
        ({ spec }) => spec === "商品标题",
      )!;
      fields.push({
        field: "model",
        marketValue: marketCopyPaper.model,
        sourceValue: sourceCopyPaper.model,
        marketEvidenceUrl: marketUrl,
        sourceEvidenceUrl: sourceTitle.sourceUrl,
        marketEvidence: {
          path: marketCopyPaper.paths.join(" + "),
          value: marketCopyCandidates.map(({ value }) => value).join(" | "),
        },
        sourceEvidence: {
          spec: sourceTitle.spec,
          value: sourceTitle.value,
          capturedAt: sourceTitle.capturedAt,
          evidence: sourceTitle.evidence,
          participants: sourceCopyCandidates.map(
            ({ spec, value, sourceUrl, capturedAt, evidence }) => ({
              spec,
              value,
              sourceUrl,
              capturedAt,
              evidence,
            }),
          ),
        },
      });
    }
  }
  const marketClipPack = clipPackSignature(
    marketClipCandidates,
    marketSaleUnit,
  );
  const sourceClipCandidates: SourceCandidate[] = [
    {
      value: input.source.title.value,
      path: "source.title",
      spec: "商品标题",
      capturedAt: input.source.title.capturedAt,
      evidence: input.source.title.evidence,
      sourceUrl: input.source.title.sourceUrl,
    },
    ...sourcePackaging,
    ...sourceFor(["颜色", "尺寸", "数量", "包装"]),
  ];
  const validSourceClipCandidates = sourceClipCandidates.filter(validSource);
  const sourceClipPack = clipPackSignature(validSourceClipCandidates);
  const structuredSourcePack = validSourceClipCandidates.find(
    (candidate) => candidate.spec === "包装清单",
  );
  const structuredSourcePackComplete =
    structuredSourcePack &&
    /(\d+(?:\.\d+)?)\s*mm(?![a-z])/iu.test(structuredSourcePack.value) &&
    /(\d+)\s*只\s*[/／]\s*筒/u.test(structuredSourcePack.value);
  const penCategory = /中性笔/u.test(text(publish?.categoryFullName) ?? "");
  const marketPenCandidates = penCategory
    ? [
        ...marketClipCandidates,
        ...(attrs.get("笔芯颜色") ?? []),
        ...(attrs.get("书写粗细") ?? []),
      ]
    : [];
  const sourcePenCandidates = penCategory
    ? [
        ...sourceClipCandidates,
        ...sourceFor(["笔芯颜色", "书写粗细", "数量", "包装形式"]),
      ].filter(validSource)
    : [];
  const marketPenPack = penCategory
    ? gelPenSignature(marketPenCandidates, marketSaleUnit)
    : null;
  const sourcePenPack = penCategory
    ? gelPenSignature(sourcePenCandidates)
    : null;
  const penPackingList = sourcePenCandidates.find(
    (candidate) => candidate.spec === "包装清单",
  );
  const penPackingComplete =
    penPackingList &&
    /(\d+)\s*支(?:装)?\s*[/／]\s*盒/u.test(penPackingList.value);
  const archiveCategory = /(?:档案盒|资料盒)/u.test(
    text(publish?.categoryFullName) ?? "",
  );
  const marketArchivePack = archiveCategory
    ? archiveBoxSignature(marketClipCandidates, marketSaleUnit)
    : null;
  const validSourceArchiveCandidates = archiveCategory
    ? [...sourceClipCandidates, ...sourceFor(["材质", "尺寸规格"])].filter(
        validSource,
      )
    : [];
  const sourceArchivePack = archiveCategory
    ? archiveBoxSignature(validSourceArchiveCandidates)
    : null;
  const archivePackingComplete =
    structuredSourcePack &&
    /(?:档案盒|资料盒|文件盒)/u.test(structuredSourcePack.value) &&
    /[×x*]\s*1\s*个/u.test(structuredSourcePack.value.normalize("NFKC"));
  const archiveSalesSpec = validSourceClipCandidates.find(
    (candidate) => candidate.spec === "京东销售规格",
  );
  const archiveSalesComplete =
    archiveSalesSpec &&
    /(\d+(?:\.\d+)?)\s*mm(?![a-z])/iu.test(archiveSalesSpec.value) &&
    /(?:黑色|白色|红色|蓝色|绿色|黄色|紫色|橙色|灰色|粉色|棕色|咖啡色|金色|银色)/u.test(
      archiveSalesSpec.value,
    );
  const sourcePaperFormats = [
    ...new Set(
      validSourceArchiveCandidates.flatMap((candidate) =>
        [
          ...candidate.value.normalize("NFKC").matchAll(/A([3-5])(?!\d)/giu),
        ].map((match) => `a${match[1]}`),
      ),
    ),
  ];
  const marketPaperFormats = [
    ...new Set(
      marketClipCandidates.flatMap((candidate) =>
        [
          ...candidate.value.normalize("NFKC").matchAll(/A([3-5])(?!\d)/giu),
        ].map((match) => `a${match[1]}`),
      ),
    ),
  ];
  const archivePaperFormatComplete =
    sourcePaperFormats.length === 1 &&
    marketPaperFormats.length <= 1 &&
    (!marketPaperFormats.length ||
      marketPaperFormats[0] === sourcePaperFormats[0]) &&
    validSourceArchiveCandidates.some(
      (candidate) =>
        candidate.spec === "规格" &&
        normalized(candidate.value) === sourcePaperFormats[0],
    );
  let structuredArchiveMatched = false;
  if (
    copyPaperCategory &&
    marketCopyPaper &&
    sourceCopyPaper &&
    marketCopyPaper.value === sourceCopyPaper.value
  ) {
    const sourcePack =
      sourceCopyCandidates.find(({ spec }) => spec === "包装清单") ??
      sourceCopyCandidates[0];
    fields.push({
      field: "packaging",
      marketValue: marketCopyPaper.value,
      sourceValue: sourceCopyPaper.value,
      marketEvidenceUrl: marketUrl,
      sourceEvidenceUrl: sourcePack.sourceUrl,
      marketEvidence: {
        path: marketCopyPaper.paths.join(" + "),
        value: marketCopyCandidates.map(({ value }) => value).join(" | "),
      },
      sourceEvidence: {
        spec: sourcePack.spec,
        value: sourcePack.value,
        capturedAt: sourcePack.capturedAt,
        evidence: sourcePack.evidence,
        participants: sourceCopyCandidates.map(
          ({ spec, value, sourceUrl, capturedAt, evidence }) => ({
            spec,
            value,
            sourceUrl,
            capturedAt,
            evidence,
          }),
        ),
      },
    });
  } else if (
    marketClipPack &&
    sourceClipPack &&
    structuredSourcePackComplete &&
    marketClipPack.value === sourceClipPack.value
  ) {
    fields.push({
      field: "packaging",
      marketValue: marketClipPack.value,
      sourceValue: sourceClipPack.value,
      marketEvidenceUrl: marketUrl,
      sourceEvidenceUrl: structuredSourcePack.sourceUrl,
      marketEvidence: {
        path: marketClipPack.paths.join(" + "),
        value: marketClipCandidates.map(({ value }) => value).join(" | "),
      },
      sourceEvidence: {
        spec: structuredSourcePack.spec,
        value: structuredSourcePack.value,
        capturedAt: structuredSourcePack.capturedAt,
        evidence: structuredSourcePack.evidence,
      },
    });
  } else if (
    marketPenPack &&
    sourcePenPack &&
    penPackingComplete &&
    marketPenPack.value === sourcePenPack.value
  ) {
    fields.push({
      field: "packaging",
      marketValue: marketPenPack.value,
      sourceValue: sourcePenPack.value,
      marketEvidenceUrl: marketUrl,
      sourceEvidenceUrl: penPackingList.sourceUrl,
      marketEvidence: {
        path: marketPenPack.paths.join(" + "),
        value: marketPenCandidates.map(({ value }) => value).join(" | "),
      },
      sourceEvidence: {
        spec: penPackingList.spec,
        value: penPackingList.value,
        capturedAt: penPackingList.capturedAt,
        evidence: penPackingList.evidence,
        participants: sourcePenCandidates.map((candidate) => ({
          spec: candidate.spec,
          value: candidate.value,
          sourceUrl: candidate.sourceUrl,
          capturedAt: candidate.capturedAt,
          evidence: candidate.evidence,
        })),
      },
    });
  } else if (
    marketArchivePack &&
    sourceArchivePack &&
    archivePackingComplete &&
    archiveSalesComplete &&
    archivePaperFormatComplete &&
    marketArchivePack.value === sourceArchivePack.value
  ) {
    structuredArchiveMatched = true;
    fields.push({
      field: "packaging",
      marketValue: marketArchivePack.value,
      sourceValue: sourceArchivePack.value,
      marketEvidenceUrl: marketUrl,
      sourceEvidenceUrl: structuredSourcePack.sourceUrl,
      marketEvidence: {
        path: marketArchivePack.paths.join(" + "),
        value: marketClipCandidates.map(({ value }) => value).join(" | "),
      },
      sourceEvidence: {
        spec: structuredSourcePack.spec,
        value: structuredSourcePack.value,
        capturedAt: structuredSourcePack.capturedAt,
        evidence: structuredSourcePack.evidence,
        participants: validSourceArchiveCandidates.map((candidate) => ({
          spec: candidate.spec,
          value: candidate.value,
          sourceUrl: candidate.sourceUrl,
          capturedAt: candidate.capturedAt,
          evidence: candidate.evidence,
        })),
      },
    });
  } else compare("packaging", marketPackaging, sourcePackaging);

  for (const [name, candidates] of attrs) {
    if (!MATERIAL_ATTRIBUTE.test(name) || ["型号", "规格"].includes(name))
      continue;
    if (
      copyPaperCategory &&
      [
        "克重",
        "颜色",
        "纸张尺寸",
        "复印纸规格",
        "包装",
        "张数",
        "包数",
      ].includes(name)
    )
      continue;
    if (structuredArchiveMatched && name === "颜色") continue;
    const markets = distinct(candidates);
    if (markets.length > 1) {
      block(`目标销售SKU属性“${name}”存在冲突值`);
      continue;
    }
    const sources = distinct((sourceFacts.get(name) ?? []).filter(validSource));
    if (!sources.length) block(`京东来源缺少目标销售SKU物料属性“${name}”`);
    else if (
      sources.length > 1 ||
      normalized(markets[0].value) !== normalized(sources[0].value)
    )
      block(`目标销售SKU物料属性“${name}”与京东来源不一致`);
  }

  const required = new Set(fields.map((field) => field.field));
  const checkedAt = [...usedTimes].reduce((earliest, candidate) =>
    Date.parse(candidate) < Date.parse(earliest) ? candidate : earliest,
  );
  return {
    matched:
      blockers.length === 0 &&
      required.has("brand") &&
      required.has("model") &&
      required.has("packaging") &&
      (!copyPaperParent || Boolean(categoryMapping)),
    fields,
    blockers,
    sourceSku: input.source.sku,
    detailReceiptId: input.detailReceiptId,
    checkedAt,
    ...(categoryMapping ? { categoryMapping } : {}),
  };
}
