import type { Product } from "./model.js";
import { deriveClockTitleField, type ClockTitleField } from "./clock-text.js";

export const NORMALIZATION_RULES_VERSION = "jd-product-normalization/17";
export const NORMALIZATION_VERSION = NORMALIZATION_RULES_VERSION;

export type FieldResolutionStatus =
  "not_observed" | "unparsed" | "resolved" | "conflicting" | "not_applicable";

export interface FieldRequirement {
  name: string;
  required: boolean;
}

export interface ResolutionEvidence {
  sourceField: string;
  value: string;
  sourceUrl: string;
  capturedAt: string;
  evidence: string;
  rule: string;
}

export interface FieldResolution {
  field: string;
  status: FieldResolutionStatus;
  value?: string;
  evidence: ResolutionEvidence[];
  ruleVersion: string;
  blockingReason?: string;
}

export interface NormalizationResult {
  product: Product;
  fields: FieldResolution[];
  issues: string[];
  resolutions: Record<string, FieldResolution>;
  rulesVersion: string;
  blockingReasons: string[];
}

export type NormalizationRequirements =
  | readonly string[]
  | readonly FieldRequirement[]
  | { fields: readonly FieldRequirement[] };

/** Context from the verified HZ template. It must never be guessed from text. */
export interface NormalizationContext {
  categoryId?: string;
}

type Fact = Product["specs"][string];
type Candidate = {
  value: string;
  sourceField: string;
  fact: Fact;
  rule: string;
};

const archiveBoxCategoryId = "10048009";
const penCategoryId = "10041013";
const copyPaperCategoryId = "10015007";
const paperFormat = /^A\d+$/i;
const archiveColors = [
  "白色",
  "黑色",
  "蓝色",
  "红色",
  "绿色",
  "黄色",
  "灰色",
  "粉色",
  "紫色",
  "透明",
];

const grossWeightAliases = ["商品毛重", "毛重", "包装毛重", "含包装重量"];
const directAliases: Record<string, readonly string[]> = {
  商品毛重: grossWeightAliases,
  包装名称: ["包装名称"],
  包装数量: ["包装数量", "销售数量", "装数"],
  加热器数量: ["加热器数量", "加热器个数"],
};
const placeholder = /^(?:暂无|无|未知|不详|未提供|n\/?a|-{1,2}|—)$/i;

function requirementList(
  requirements?: NormalizationRequirements,
): readonly FieldRequirement[] {
  if (!requirements) return [];
  if ("fields" in requirements) return requirements.fields;
  return [...requirements].map((requirement) =>
    typeof requirement === "string"
      ? { name: requirement, required: true }
      : requirement,
  );
}

function evidence(candidate: Candidate): ResolutionEvidence {
  return {
    sourceField: candidate.sourceField,
    value: candidate.fact.value,
    sourceUrl: candidate.fact.sourceUrl,
    capturedAt: candidate.fact.capturedAt,
    evidence: candidate.fact.evidence,
    rule: candidate.rule,
  };
}

function decimal(value: number) {
  return String(Number(value.toFixed(6)));
}

function normalizedWeight(raw: string): string | null {
  const match = raw.trim().match(/^(\d+(?:\.\d+)?)\s*(kg|千克|公斤|g|克)$/i);
  if (!match || Number(match[1]) <= 0) return null;
  const kg =
    match[2].toLowerCase() === "g" || match[2] === "克"
      ? Number(match[1]) / 1000
      : Number(match[1]);
  return decimal(kg) + "kg";
}

function positiveInteger(raw: string): string | null {
  const match = raw
    .trim()
    .match(/^(\d{1,3})(?:个|件|瓶|盒|袋|支|片|盘)?(?:装)?$/);
  return match && Number(match[1]) > 0 ? String(Number(match[1])) : null;
}

function factBelongsToProduct(product: Product, fact: Fact) {
  if (
    fact.sourceUrl === product.url ||
    product.assets.some((asset) => asset.url === fact.sourceUrl)
  )
    return true;
  try {
    const url = new URL(fact.sourceUrl);
    const match = url.pathname.match(/^\/(\d+)\.html$/);
    return url.hostname === "item.jd.com" && match?.[1] === product.sku;
  } catch {
    return false;
  }
}

function explicitHeaterCount(raw: string): string | null {
  const matches = [
    ...raw.matchAll(/(\d{1,3})\s*(?:个|只|台)?\s*(?:加热器|器)(?!具)/g),
    ...raw.matchAll(/(?:加热器|器)(?!具)\s*(\d{1,3})\s*(?:个|只|台)?/g),
  ].map((match) => Number(match[1]));
  return matches.length && new Set(matches).size === 1 && matches[0] > 0
    ? String(matches[0])
    : null;
}

function explicitSinglePackingItem(
  raw: string,
): { name: string; count: string } | null {
  const match = raw.trim().match(/^(.+?)\s*[x×*]\s*(\d{1,3})$/);
  if (!match || Number(match[2]) <= 0) return null;
  const name = match[1].trim();
  if (
    !name ||
    /[x×*+＋、，,]|每|至|[-~～]|赠|随机/.test(name) ||
    /^\d+(?:\.\d+)?\s*(?:mL|毫升|L|升|g|克|kg|千克)$/i.test(name) ||
    [...name.matchAll(/\d{1,3}(?:个|件|瓶|盒|袋|支|片|盘|器)/g)].length > 1
  )
    return null;
  return { name, count: String(Number(match[2])) };
}

function explicitPackingCount(raw: string): string | null {
  const singleItem = explicitSinglePackingItem(raw);
  if (singleItem) return singleItem.count;
  const text = raw.replace(/\s/g, "");
  if (/[×xX*+＋、，,]|每|至|[-~～]|赠|随机/.test(text)) return null;
  const componentCounts = [
    ...text.matchAll(/\d{1,3}(?:个|件|瓶|盒|袋|支|片|盘|器)/g),
  ];
  if (componentCounts.length !== 1) return null;
  const simple = text.match(
    /^(?:\D|\d+(?:\.\d+)?(?:mL|ml|ML|L|g|克))*?(\d{1,3})(瓶|盒|袋|支|片|盘)(?:装)?$/,
  );
  if (simple && Number(simple[1]) > 0) return String(Number(simple[1]));
  return null;
}

function uniqueMatches(raw: string, pattern: RegExp) {
  return [
    ...new Set(
      [...raw.normalize("NFKC").matchAll(pattern)].map((match) =>
        String(Number(match[1])),
      ),
    ),
  ];
}

type ArchiveBoxDerivation = {
  packing: Fact;
  sales: Fact;
  itemNumber?: Fact;
  width: string;
  colors: string[];
};

function penBoxSpecification(
  product: Product,
  context?: NormalizationContext,
): { quantity: Fact; count: string } | null {
  if (context?.categoryId !== penCategoryId) return null;
  const quantity = product.specs["数量"];
  const packingForm = product.specs["包装形式"];
  if (
    !quantity ||
    !packingForm ||
    !factBelongsToProduct(product, quantity) ||
    !factBelongsToProduct(product, packingForm) ||
    placeholder.test(quantity.value.trim()) ||
    placeholder.test(packingForm.value.trim())
  )
    return null;
  const count = quantity.value
    .normalize("NFKC")
    .trim()
    .match(/^(\d{1,3})支$/u);
  if (
    !count ||
    Number(count[1]) <= 0 ||
    packingForm.value.normalize("NFKC").trim() !== "盒装"
  )
    return null;
  const packing = product.specs["包装清单"];
  if (packing) {
    if (!factBelongsToProduct(product, packing)) return null;
    const listed = packing.value
      .normalize("NFKC")
      .trim()
      .match(/^(\d{1,3})支装\/盒$/u);
    if (!listed || listed[1] !== count[1]) return null;
  }
  return { quantity, count: String(Number(count[1])) };
}

function penSpecificationConflict(
  product: Product,
  field: string,
  context?: NormalizationContext,
) {
  if (field !== "规格" || context?.categoryId !== penCategoryId)
    return undefined;
  const quantity = product.specs["数量"];
  if (!quantity || !factBelongsToProduct(product, quantity)) return undefined;
  const quantityCount = quantity.value
    .normalize("NFKC")
    .trim()
    .match(/^(\d{1,3})支$/u)?.[1];
  if (!quantityCount) return undefined;
  const observedCounts = [
    product.specs["包装清单"],
    product.specs["京东销售规格"],
    product.specs["规格"],
  ].flatMap((fact) => {
    if (!fact || !factBelongsToProduct(product, fact)) return [];
    return [...fact.value.normalize("NFKC").matchAll(/(\d{1,3})支装/gu)].map(
      (match) => match[1],
    );
  });
  return observedCounts.some((count) => count !== quantityCount)
    ? "中性笔数量与包装清单或当前销售规格不一致，不能填规格"
    : undefined;
}

function currentArchiveBoxFacts(
  product: Product,
  context?: NormalizationContext,
): ArchiveBoxDerivation | null {
  if (
    context?.categoryId !== archiveBoxCategoryId ||
    !factBelongsToProduct(product, product.title) ||
    !product.title.value.includes("档案盒")
  )
    return null;
  const packing = product.specs["包装清单"];
  const sales = product.specs["京东销售规格"];
  if (
    !packing ||
    !sales ||
    !factBelongsToProduct(product, packing) ||
    !factBelongsToProduct(product, sales)
  )
    return null;
  const pack = packing.value.normalize("NFKC").trim();
  const count = pack.match(/^.+档案盒\s*[x×*]\s*(\d{1,3})\s*个$/u);
  if (!count || Number(count[1]) !== 1) return null;
  const salesText = sales.value.normalize("NFKC");
  const explicitCounts = [
    ...salesText.matchAll(/(\d{1,3})\s*(?:个|只|件)(?:装)?/gu),
    ...product.title.value
      .normalize("NFKC")
      .matchAll(/档案盒\s*(?:[x×*]\s*)?(\d{1,3})\s*(?:个|只|件)/gu),
  ].map((match) => Number(match[1]));
  if (explicitCounts.some((value) => value !== 1)) return null;
  const sideWidths = uniqueMatches(salesText, /(\d+(?:\.\d+)?)\s*mm\s*侧宽/giu);
  const dimensions = uniqueMatches(
    salesText,
    /(\d+(?:\.\d+)?)\s*mm(?![a-z])/giu,
  );
  const titleDimensions = uniqueMatches(
    product.title.value.normalize("NFKC"),
    /(\d+(?:\.\d+)?)\s*mm(?![a-z])/giu,
  );
  if (
    sideWidths.length !== 1 ||
    dimensions.length !== 1 ||
    dimensions[0] !== sideWidths[0] ||
    (titleDimensions.length > 0 &&
      (titleDimensions.length !== 1 || titleDimensions[0] !== sideWidths[0]))
  )
    return null;
  const colors = archiveColors.filter((color) => salesText.includes(color));
  const itemNumber = product.specs["货号"];
  return {
    packing,
    sales,
    itemNumber:
      itemNumber &&
      factBelongsToProduct(product, itemNumber) &&
      !placeholder.test(itemNumber.value.trim())
        ? itemNumber
        : undefined,
    width: sideWidths[0],
    colors,
  };
}

function archiveBoxConflict(
  product: Product,
  field: string,
  context?: NormalizationContext,
): string | undefined {
  if (
    context?.categoryId !== archiveBoxCategoryId ||
    !factBelongsToProduct(product, product.title) ||
    !product.title.value.includes("档案盒")
  )
    return undefined;
  const packing = product.specs["包装清单"];
  const sales = product.specs["京东销售规格"];
  if (
    !packing ||
    !sales ||
    !factBelongsToProduct(product, packing) ||
    !factBelongsToProduct(product, sales)
  )
    return undefined;
  const pack = packing.value.normalize("NFKC");
  const count = pack.match(/^.+档案盒\s*[x×*]\s*(\d{1,3})\s*个$/u);
  if (field === "规格" && count && Number(count[1]) !== 1)
    return "档案盒包装清单不是明确单个装，不能填规格";
  const salesText = sales.value.normalize("NFKC");
  const explicitCounts = [
    ...salesText.matchAll(/(\d{1,3})\s*(?:个|只|件)(?:装)?/gu),
    ...product.title.value
      .normalize("NFKC")
      .matchAll(/档案盒\s*(?:[x×*]\s*)?(\d{1,3})\s*(?:个|只|件)/gu),
  ].map((match) => Number(match[1]));
  if (field === "规格" && explicitCounts.some((value) => value !== 1))
    return "档案盒销售规格或标题不是明确单个装，不能填规格";
  const sourceSpec = product.specs["规格"];
  const originalSpec = product.specs["京东原始规格"];
  if (
    field === "规格" &&
    sourceSpec &&
    originalSpec &&
    paperFormat.test(sourceSpec.value.trim()) &&
    sourceSpec.value.trim() !== originalSpec.value.trim()
  )
    return "档案盒京东原始规格与已有备份不一致，不能覆盖";
  const widths = uniqueMatches(salesText, /(\d+(?:\.\d+)?)\s*mm\s*侧宽/giu);
  const dimensions = uniqueMatches(
    salesText,
    /(\d+(?:\.\d+)?)\s*mm(?![a-z])/giu,
  );
  const titleDimensions = uniqueMatches(
    product.title.value.normalize("NFKC"),
    /(\d+(?:\.\d+)?)\s*mm(?![a-z])/giu,
  );
  if (
    field === "尺寸规格" &&
    (widths.length > 1 ||
      dimensions.length > 1 ||
      (widths.length === 1 &&
        dimensions.length === 1 &&
        widths[0] !== dimensions[0]) ||
      (titleDimensions.length > 0 &&
        (titleDimensions.length !== 1 || titleDimensions[0] !== widths[0])))
  )
    return "档案盒侧宽存在不同的明确尺寸，不能填尺寸规格";
  const colors = archiveColors.filter((color) => salesText.includes(color));
  if (field === "颜色" && colors.length > 1)
    return "档案盒销售规格存在多个明确颜色，不能填颜色";
  return undefined;
}

function copyPaperConflict(
  product: Product,
  field: string,
  context?: NormalizationContext,
): string | undefined {
  if (context?.categoryId !== copyPaperCategoryId) return undefined;
  if (field === "纸张尺寸") {
    const spec = product.specs["规格"];
    const backup = product.specs["京东原始规格"];
    if (
      spec &&
      backup &&
      factBelongsToProduct(product, spec) &&
      factBelongsToProduct(product, backup) &&
      paperFormat.test(spec.value.trim()) &&
      spec.value.trim().toUpperCase() !== backup.value.trim().toUpperCase()
    )
      return "复印纸原始纸张规格与已有备份不一致，不能填纸张尺寸";
  }
  if (field === "规格") {
    const facts = [
      product.specs["包数"],
      product.specs["包装清单"],
      product.title,
    ].filter((fact): fact is Fact =>
      Boolean(fact && factBelongsToProduct(product, fact)),
    );
    const counts = [
      ...new Set(
        facts.flatMap((fact) =>
          [
            ...fact.value
              .normalize("NFKC")
              .matchAll(/(\d+)\s*包(?:装|\s*[\/／每]\s*箱)/gu),
          ].map((match) => String(Number(match[1]))),
        ),
      ),
    ];
    if (counts.length > 1)
      return `复印纸每箱包数存在不同的明确值：${counts.join("、")}`;
  }
  return undefined;
}

function normalizationInput(product: Product, context?: NormalizationContext) {
  if (context?.categoryId === copyPaperCategoryId) {
    const normalized = structuredClone(product);
    const spec = normalized.specs["规格"];
    if (
      spec &&
      factBelongsToProduct(product, spec) &&
      paperFormat.test(spec.value.trim())
    ) {
      if (!normalized.specs["京东原始规格"])
        normalized.specs["京东原始规格"] = { ...spec };
      delete normalized.specs["规格"];
    }
    return normalized;
  }
  const archive = currentArchiveBoxFacts(product, context);
  if (!archive) return structuredClone(product);
  const normalized = structuredClone(product);
  const spec = normalized.specs["规格"];
  if (
    spec &&
    factBelongsToProduct(product, spec) &&
    paperFormat.test(spec.value.trim())
  ) {
    if (!normalized.specs["京东原始规格"])
      normalized.specs["京东原始规格"] = { ...spec };
    delete normalized.specs["规格"];
  } else if (
    spec &&
    /销售文字规则 sale-text\//.test(spec.evidence) &&
    factBelongsToProduct(product, spec)
  )
    delete normalized.specs["规格"];
  return normalized;
}

function clipPackDerivation(product: Product) {
  const packing = product.specs["包装清单"];
  if (!packing || !factBelongsToProduct(product, packing)) return null;
  const packingText = packing.value.normalize("NFKC");
  if (!/(?:长尾夹|长尾票夹)/u.test(packingText)) return null;
  const packingSizes = uniqueMatches(
    packingText,
    /(\d+(?:\.\d+)?)\s*mm(?![a-z])/giu,
  );
  const packingCounts = uniqueMatches(packingText, /(\d+)\s*(?:只|个)/gu);
  const packingUnits = [
    ...new Set(
      [...packingText.matchAll(/[/／]\s*(筒|盒|包|袋)/gu)].map(
        (match) => match[1],
      ),
    ),
  ];
  if (
    packingSizes.length !== 1 ||
    packingCounts.length !== 1 ||
    packingUnits.length !== 1 ||
    packingUnits[0] !== "筒"
  )
    return null;

  const observedFacts = [
    product.title,
    product.specs["京东销售规格"],
    packing,
  ].filter((fact): fact is Fact =>
    Boolean(fact && factBelongsToProduct(product, fact)),
  );
  const observedText = observedFacts.map((fact) => fact.value).join(" ");
  if (!/(?:长尾夹|长尾票夹)/u.test(observedText)) return null;
  const observedSizes = uniqueMatches(
    observedText,
    /(\d+(?:\.\d+)?)\s*mm(?![a-z])/giu,
  );
  const observedCounts = uniqueMatches(observedText, /(\d+)\s*(?:只|个)/gu);
  const observedUnits = [
    ...new Set(
      [...observedText.matchAll(/[/／]\s*(筒|盒|包|袋)/gu)].map(
        (match) => match[1],
      ),
    ),
  ];
  if (
    observedSizes.length !== 1 ||
    observedCounts.length !== 1 ||
    observedUnits.length !== 1 ||
    observedUnits[0] !== "筒"
  )
    return null;
  return { packing, count: packingCounts[0] };
}

function directCandidates(
  product: Product,
  field: string,
  context?: NormalizationContext,
): Candidate[] {
  return (directAliases[field] ?? [field]).flatMap((sourceField) => {
    const fact = product.specs[sourceField];
    if (
      !fact ||
      !factBelongsToProduct(product, fact) ||
      placeholder.test(fact.value.trim())
    )
      return [];
    if (
      field === "规格" &&
      sourceField === "规格" &&
      context?.categoryId === archiveBoxCategoryId &&
      factBelongsToProduct(product, product.title) &&
      product.title.value.includes("档案盒") &&
      paperFormat.test(fact.value.trim())
    )
      return [];
    const value =
      field === "商品毛重"
        ? normalizedWeight(fact.value)
        : field === "包装数量" || field === "加热器数量"
          ? field === "加热器数量" && /^0(?:个|台)?$/.test(fact.value.trim())
            ? "0"
            : positiveInteger(fact.value)
          : fact.value.trim();
    return value
      ? [{ value, sourceField, fact, rule: `direct-alias:${sourceField}` }]
      : [];
  });
}

function derivedCandidates(
  product: Product,
  field: string,
  context?: NormalizationContext,
): Candidate[] {
  if (context?.categoryId === copyPaperCategoryId) {
    const paperPacking = product.specs["包装清单"];
    const explicitPaperBox =
      paperPacking && factBelongsToProduct(product, paperPacking)
        ? paperPacking.value
            .normalize("NFKC")
            .match(/^.+复印纸\s*[x×*]\s*1\s*箱\s*[（(]\s*\d+\s*包\s*[）)]$/u)
        : null;
    const explicitTitleBox =
      factBelongsToProduct(product, product.title) &&
      /复印纸/u.test(product.title.value) &&
      /\d+\s*张\s*[x×*]\s*\d+\s*包\s*(?:1|一)\s*箱/u.test(
        product.title.value.normalize("NFKC"),
      );
    const boxFact = explicitPaperBox
      ? paperPacking!
      : explicitTitleBox
        ? product.title
        : null;
    if (boxFact && field === "包装名称" && !product.specs["包装名称"])
      return [
        {
          value: "复印纸",
          sourceField: explicitPaperBox ? "包装清单" : "商品标题",
          fact: boxFact,
          rule: "copy-paper-box-name-from-explicit-current-sku-pack-list",
        },
      ];
    if (boxFact && field === "包装数量")
      return [
        {
          value: "1",
          sourceField: explicitPaperBox ? "包装清单" : "商品标题",
          fact: boxFact,
          rule: "copy-paper-box-count-from-explicit-current-sku-pack-list",
        },
      ];
    const sourceFormat =
      product.specs["京东原始规格"] ?? product.specs["纸张尺寸"];
    if (
      field === "纸张尺寸" &&
      sourceFormat &&
      factBelongsToProduct(product, sourceFormat) &&
      paperFormat.test(sourceFormat.value.trim())
    )
      return [
        {
          value: sourceFormat.value.trim().toUpperCase(),
          sourceField: product.specs["京东原始规格"]
            ? "京东原始规格"
            : "纸张尺寸",
          fact: sourceFormat,
          rule: "copy-paper-size-from-current-sku-explicit-format",
        },
      ];
    if (field === "规格") {
      const facts = [
        product.specs["包数"],
        product.specs["包装清单"],
        product.title,
      ].filter((fact): fact is Fact =>
        Boolean(fact && factBelongsToProduct(product, fact)),
      );
      const counts = [
        ...new Set(
          facts.flatMap((fact) =>
            [
              ...fact.value
                .normalize("NFKC")
                .matchAll(/(\d+)\s*包(?:装|\s*[\/／每]\s*箱)/gu),
            ].map((match) => String(Number(match[1]))),
          ),
        ),
      ];
      if (counts.length === 1) {
        const fact = facts.find((candidate) =>
          new RegExp(`${counts[0]}\\s*包`).test(candidate.value),
        )!;
        return [
          {
            value: `${counts[0]}包装`,
            sourceField:
              fact === product.title
                ? "商品标题"
                : (Object.entries(product.specs).find(
                    ([, value]) => value === fact,
                  )?.[0] ?? "包装清单"),
            fact,
            rule: "copy-paper-pack-spec-from-explicit-current-sku-pack-count",
          },
        ];
      }
    }
    if (field === "型号" && factBelongsToProduct(product, product.title)) {
      const facts = [product.title, product.specs["包装清单"]].filter(
        (fact): fact is Fact =>
          Boolean(fact && factBelongsToProduct(product, fact)),
      );
      const alphaModels = [
        ...new Set(
          facts
            .flatMap((fact) =>
              [
                ...fact.value
                  .normalize("NFKC")
                  .matchAll(
                    /(?<![A-Z0-9])([A-Z]{1,4}\d{3,}[A-Z0-9-]*)(?![A-Z0-9])/giu,
                  ),
              ].map((match) => match[1].toUpperCase()),
            )
            .filter((value) => !/^A\d+$/u.test(value)),
        ),
      ];
      const titleText = product.title.value.normalize("NFKC");
      const numericModels = [
        ...new Set(
          [...titleText.matchAll(/(?<![A-Z0-9])(\d{4,})(?![A-Z0-9])/giu)]
            .filter((match) => {
              const value = Number(match[1]);
              const suffix = titleText.slice(match.index! + match[0].length);
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
      if (models.length === 1)
        return [
          {
            value: models[0],
            sourceField: "商品标题",
            fact: product.title,
            rule: "copy-paper-model-from-current-sku-title-and-pack-list",
          },
        ];
    }
  }
  const archive = currentArchiveBoxFacts(product, context);
  if (archive) {
    if (field === "规格")
      return [
        {
          value: "单个装",
          sourceField: "包装清单",
          fact: archive.packing,
          rule: "archive-box-single-unit-from-current-sku-pack-list",
        },
      ];
    if (field === "尺寸规格")
      return [
        {
          value: `${archive.width}mm`,
          sourceField: "京东销售规格",
          fact: archive.sales,
          rule: "archive-box-side-width-from-current-sku-sale-spec",
        },
      ];
    if (field === "型号" && archive.itemNumber)
      return [
        {
          value: archive.itemNumber.value.trim(),
          sourceField: "货号",
          fact: archive.itemNumber,
          rule: "archive-box-model-from-current-sku-item-number",
        },
      ];
    if (field === "颜色" && archive.colors.length === 1)
      return [
        {
          value: archive.colors[0],
          sourceField: "京东销售规格",
          fact: archive.sales,
          rule: "archive-box-color-from-current-sku-sale-spec",
        },
      ];
  }
  const penSpec = penBoxSpecification(product, context);
  const canonicalSpec = product.specs["规格"];
  if (
    field === "规格" &&
    penSpec &&
    !(
      canonicalSpec &&
      factBelongsToProduct(product, canonicalSpec) &&
      !placeholder.test(canonicalSpec.value.trim())
    )
  )
    return [
      {
        value: `${penSpec.count}支装`,
        sourceField: "数量",
        fact: penSpec.quantity,
        rule: "pen-spec-from-current-sku-count-and-box-packaging",
      },
    ];
  if (field === "型号" || (field === "规格" && !product.specs["规格"])) {
    const clipPack = clipPackDerivation(product);
    const itemNumber = product.specs["货号"];
    if (clipPack) {
      if (
        field === "型号" &&
        itemNumber &&
        factBelongsToProduct(product, itemNumber) &&
        !placeholder.test(itemNumber.value.trim())
      )
        return [
          {
            value: itemNumber.value.trim(),
            sourceField: "货号",
            fact: itemNumber,
            rule: "long-tail-clip-model-from-current-sku-item-number",
          },
        ];
      if (field === "规格")
        return [
          {
            value: `${clipPack.count}只装`,
            sourceField: "包装清单",
            fact: clipPack.packing,
            rule: "long-tail-clip-spec-from-explicit-pack-list",
          },
        ];
    }
  }
  if (
    (field === "类型" || field === "类别" || field === "型号") &&
    !product.specs[field] &&
    factBelongsToProduct(product, product.title)
  ) {
    const derived = deriveClockTitleField(
      product.title.value,
      product.sku,
      field as ClockTitleField,
    );
    if (derived)
      return [
        {
          value: derived.value,
          sourceField: "商品标题",
          fact: { ...product.title, evidence: derived.quote },
          rule: derived.rule,
        },
      ];
  }
  if (field !== "包装名称" && field !== "包装数量" && field !== "加热器数量")
    return [];
  const sourceFields =
    field === "包装名称" ? ["包装清单"] : ["京东销售规格", "包装清单"];
  return sourceFields.flatMap((sourceField) => {
    const fact = product.specs[sourceField];
    if (
      !fact ||
      !factBelongsToProduct(product, fact) ||
      placeholder.test(fact.value.trim())
    )
      return [];
    const value =
      field === "包装名称"
        ? explicitSinglePackingItem(fact.value)?.name
        : field === "包装数量"
          ? explicitPackingCount(fact.value)
          : explicitHeaterCount(fact.value);
    return value
      ? [{ value, sourceField, fact, rule: `explicit-${field}:${sourceField}` }]
      : [];
  });
}

function relevantObserved(product: Product, field: string) {
  const names = [
    ...(directAliases[field] ?? [field]),
    ...(field === "包装名称"
      ? ["包装清单"]
      : field === "包装数量" || field === "加热器数量"
        ? ["京东销售规格", "包装清单"]
        : []),
  ];
  return names.some((name) => {
    const value = product.specs[name]?.value.trim();
    return Boolean(value);
  });
}

function observedEvidence(
  product: Product,
  field: string,
): ResolutionEvidence[] {
  const names = [
    ...(directAliases[field] ?? [field]),
    ...(field === "包装名称"
      ? ["包装清单"]
      : field === "包装数量" || field === "加热器数量"
        ? ["京东销售规格", "包装清单"]
        : []),
  ];
  return [...new Set(names)].flatMap((sourceField) => {
    const fact = product.specs[sourceField];
    if (!fact?.value.trim()) return [];
    return [
      evidence({
        value: fact.value,
        sourceField,
        fact,
        rule: factBelongsToProduct(product, fact)
          ? "observed-but-unparsed"
          : "rejected-foreign-source",
      }),
    ];
  });
}

function heaterNotApplicable(product: Product) {
  const identity = [
    product.title.value,
    product.variant,
    product.specs["京东销售规格"]?.value ?? "",
  ].join(" ");
  return (
    /(?:驱蚊喷雾|杀虫喷雾|盘式蚊香|蚊香盘|电蚊拍)/.test(identity) &&
    !/(?:电热?蚊香液|电热?蚊香片|加热器)/.test(identity)
  );
}

function resolve(
  product: Product,
  field: string,
  allowNotApplicable: boolean,
  context?: NormalizationContext,
  originalProduct: Product = product,
): FieldResolution {
  const paperConflict = copyPaperConflict(originalProduct, field, context);
  if (paperConflict)
    return {
      field,
      status: "conflicting",
      evidence: observedEvidence(product, field),
      ruleVersion: NORMALIZATION_RULES_VERSION,
      blockingReason: paperConflict,
    };
  const archiveConflict = archiveBoxConflict(originalProduct, field, context);
  if (archiveConflict)
    return {
      field,
      status: "conflicting",
      evidence: observedEvidence(product, field),
      ruleVersion: NORMALIZATION_RULES_VERSION,
      blockingReason: archiveConflict,
    };
  const penConflict = penSpecificationConflict(originalProduct, field, context);
  if (penConflict)
    return {
      field,
      status: "conflicting",
      evidence: observedEvidence(product, field),
      ruleVersion: NORMALIZATION_RULES_VERSION,
      blockingReason: penConflict,
    };
  const candidates = [
    ...directCandidates(product, field, context),
    ...derivedCandidates(product, field, context),
  ];
  const canonical = product.specs[field];
  const canonicalCandidate = candidates.find(
    (candidate) => candidate.sourceField === field,
  );
  if (canonical && !canonicalCandidate) {
    const validAliases = candidates.filter(
      (candidate) => candidate.sourceField !== field,
    );
    return {
      field,
      status: validAliases.length ? "conflicting" : "unparsed",
      evidence: observedEvidence(product, field),
      ruleVersion: NORMALIZATION_RULES_VERSION,
      blockingReason: `${field}已有值无效，不能由别名静默覆盖`,
    };
  }
  const values = [...new Set(candidates.map((candidate) => candidate.value))];
  if (values.length > 1)
    return {
      field,
      status: "conflicting",
      evidence: candidates.map(evidence),
      ruleVersion: NORMALIZATION_RULES_VERSION,
      blockingReason: `${field}存在不同的明确值：${values.join("、")}`,
    };
  if (values.length === 1)
    return {
      field,
      status: "resolved",
      value: values[0],
      evidence: candidates.map(evidence),
      ruleVersion: NORMALIZATION_RULES_VERSION,
    };
  if (
    field === "加热器数量" &&
    allowNotApplicable &&
    heaterNotApplicable(product)
  )
    return {
      field,
      status: "not_applicable",
      evidence: [],
      ruleVersion: NORMALIZATION_RULES_VERSION,
    };
  const observed = relevantObserved(product, field);
  return {
    field,
    status: observed ? "unparsed" : "not_observed",
    evidence: observed ? observedEvidence(product, field) : [],
    ruleVersion: NORMALIZATION_RULES_VERSION,
  };
}

/** Deterministically normalize current-SKU facts without mutating the input. */
export function normalizeProduct(
  product: Product,
  requirements?: NormalizationRequirements,
  context?: NormalizationContext,
): NormalizationResult {
  const source = normalizationInput(product, context);
  const normalized = structuredClone(source);
  const required = requirementList(requirements);
  const fields = new Set([
    "商品毛重",
    "包装名称",
    "包装数量",
    "加热器数量",
    ...(context?.categoryId === archiveBoxCategoryId
      ? ["规格", "尺寸规格", "材质", "型号", "颜色"]
      : []),
    ...(context?.categoryId === copyPaperCategoryId
      ? ["规格", "克重", "颜色", "纸张尺寸", "型号"]
      : []),
    ...required.map((item) => item.name),
  ]);
  const resolutions: Record<string, FieldResolution> = {};
  const requirementsByName = new Map(required.map((item) => [item.name, item]));

  for (const field of fields) {
    const resolution = resolve(
      source,
      field,
      requirementsByName.get(field)?.required === false,
      context,
      product,
    );
    resolutions[field] = resolution;
    if (resolution.status !== "resolved" || !resolution.value) continue;
    if (normalized.specs[field]) continue;
    const evidenceSource = resolution.evidence[0];
    normalized.specs[field] = {
      value: resolution.value,
      sourceUrl: evidenceSource.sourceUrl,
      capturedAt: evidenceSource.capturedAt,
      evidence: `${evidenceSource.evidence}；${evidenceSource.rule}；${NORMALIZATION_RULES_VERSION}`,
    };
  }

  const blockingReasons = required.flatMap(({ name, required }) => {
    if (!required) return [];
    const resolution = resolutions[name];
    if (resolution.status === "resolved") return [];
    return [
      resolution.blockingReason ??
        (resolution.status === "not_observed"
          ? `${name}尚未采集，不能视为来源明确缺失`
          : `${name}已有来源文本但无法可靠解析`),
    ];
  });

  return {
    product: normalized,
    fields: [...fields].map((field) => resolutions[field]),
    issues: blockingReasons,
    resolutions,
    rulesVersion: NORMALIZATION_RULES_VERSION,
    blockingReasons,
  };
}
