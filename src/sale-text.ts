import { type Product } from "./model.js";

const amountPattern = /(\d+(?:\.\d+)?)\s*(mL|ml|ML|毫升|L|升|g|克|kg|千克)/g;

function multipliedAmount(
  sources: { value: string; source: Product["title"] }[],
) {
  const combined = sources.map(({ value }) => value).join("；");
  if (/随机|赠|任选|或|二选|三选/.test(combined)) return undefined;
  const amounts = [...combined.matchAll(amountPattern)].map(
    (match) => `${Number(match[1])}:${match[2].toLowerCase()}`,
  );
  if (new Set(amounts).size > 1) return undefined;

  const candidates = sources.flatMap(({ value, source }) => {
    const multiplied = [
      ...value.matchAll(
        /(\d+(?:\.\d+)?)\s*(mL|ml|ML|毫升|L|升|g|克|kg|千克)(?:\s*\/\s*瓶)?\s*[x×*]\s*(\d{1,3})(?:\s*(?:瓶|盒|袋|支|片|盘|桶|个))?/g,
      ),
    ];
    const perBottlePack = [
      ...value.matchAll(
        /(\d+(?:\.\d+)?)\s*(mL|ml|ML|毫升|L|升|g|克|kg|千克)\s*\/\s*瓶\s*(\d{1,3})\s*瓶装?/g,
      ),
    ];
    const matches = [...multiplied, ...perBottlePack];
    if (matches.length !== 1 || [...value.matchAll(amountPattern)].length !== 1)
      return [];
    const match = matches[0];
    const count = Number(match[3]);
    if (!Number.isInteger(count) || count <= 0) return [];
    const decimals = match[1].split(".")[1]?.length ?? 0;
    const scale = 10 ** decimals;
    const total = (Math.round(Number(match[1]) * scale) * count) / scale;
    return [{ value: `${total}${match[2]}`, source }];
  });
  const values = new Set(candidates.map(({ value }) => value.toLowerCase()));
  return values.size === 1 ? candidates[0] : undefined;
}

function amountKeys(value: string) {
  return [...value.matchAll(amountPattern)].map((match) => {
    const unit = match[2].toLowerCase();
    const normalizedUnit =
      unit === "毫升"
        ? "ml"
        : unit === "克"
          ? "g"
          : unit === "千克"
            ? "kg"
            : unit === "升"
              ? "l"
              : unit;
    return `${Number(match[1])}:${normalizedUnit}`;
  });
}

function explicitFlavor(value: string) {
  const exact = /^(?:无香型|有香型|无香|[\p{Script=Han}]{1,4}香)$/u;
  const parenthetical = [...value.matchAll(/[（(]([^）)]*)[）)]/g)]
    .map((match) => match[1].trim())
    .find((candidate) => exact.test(candidate));
  if (parenthetical) return parenthetical;
  return value
    .split(/[\s|,，、/【】（）()]+/)
    .map((part) => part.trim())
    .find((candidate) => exact.test(candidate));
}

function clockSingleUnitPacking(value: string): boolean {
  const clockItems = [
    ...value.matchAll(
      /(?:挂钟|闹钟|钟表|时钟)\s*(?:[x×*]\s*|)(\d{1,3})\s*(?:个)?(?!\d)/g,
    ),
  ];
  return (
    clockItems.length === 1 &&
    clockItems[0][1] === "1" &&
    !/(?:挂钟|闹钟|钟表|时钟)\s*(?:[x×*]\s*)?(?:0|[2-9]\d*)(?:个)?(?!\d)/.test(
      value,
    )
  );
}

function isClockProduct(p: Product, packing?: Product["title"]) {
  return /(?:挂钟|闹钟|钟表|时钟)/.test(
    [
      p.title.value,
      p.specs["京东销售规格"]?.value ?? "",
      packing?.value ?? "",
    ].join(" "),
  );
}

export function cleanSaleLabel(value: string) {
  const marketing = new Set([
    "1居推荐",
    "2居必备",
    "超市同款",
    "回购推荐",
    "特惠促销",
    "热销款",
    "店铺畅销",
    "爆款",
    "升级大瓶",
    "小瓶尝新",
  ]);
  return value
    .replace(/【([^】]*)】/g, (_whole, content: string) =>
      marketing.has(content.trim()) ? "" : content,
    )
    .trim();
}

/** Only selected-SKU text. Never inspects images or invents unmentioned capacities. */
export function prepareSaleText(input: Product): Product {
  const p = structuredClone(input);
  const legacyGeneratedFields = new Set([
    "规格",
    "类别",
    "包装名称",
    "包装数量",
    "加热器数量",
    "净含量",
    "总净含量",
    "香型",
  ]);
  for (const [key, fact] of Object.entries(p.specs)) {
    if (
      legacyGeneratedFields.has(key) &&
      fact.sourceUrl === p.url &&
      /(?:所选规格文字规则|销售文字规则) sale-text\/(?:1|2|3|4|5|6)(?:；|$)/.test(
        fact.evidence,
      )
    )
      delete p.specs[key];
  }
  const selected = p.specs["京东销售规格"];
  const packing = p.specs["包装清单"];
  const currentPacking = packing?.sourceUrl === p.url ? packing : undefined;
  const clean = cleanSaleLabel;
  const add = (key: string, value: string | undefined, source = selected) => {
    if (!p.specs[key] && value && source?.sourceUrl === p.url)
      p.specs[key] = {
        ...source,
        value,
        evidence: source.evidence + "；销售文字规则 sale-text/5",
      };
  };
  const text = clean(selected?.value ?? "");
  const clock = isClockProduct(p, currentPacking);
  if (clock) {
    // A clock's platform "规格" means its sale unit.  Its selected SKU label
    // often contains color or dimensions, so only a current checklist proving
    // exactly one clock can generate 一个装.
    if (currentPacking && clockSingleUnitPacking(currentPacking.value))
      add("规格", "一个装", currentPacking);
  } else if (selected?.value.trim()) add("规格", clean(selected.value));
  const categorySources = [
    selected?.sourceUrl === p.url ? selected : undefined,
    currentPacking,
  ].filter((source): source is NonNullable<typeof source> => Boolean(source));
  for (const source of categorySources) {
    const category = source.value.match(/杀蟑(?:胶饵|饵剂)|涂刷饵剂/)?.[0];
    if (category) {
      add("类别", category, source);
      break;
    }
  }
  if (selected?.sourceUrl === p.url)
    add("香型", explicitFlavor(text), selected);
  const singlePacking = currentPacking?.value
    .trim()
    .match(/^(.+?)\s*[x×*]\s*(\d{1,3})\s*(?:瓶|盒|袋|支|片|盘|桶|个)?$/i);
  if (singlePacking) {
    const name = singlePacking[1].trim();
    const count = Number(singlePacking[2]);
    const unambiguous =
      count > 0 &&
      !/[x×*+＋、，,]|每|至|[-~～]|赠|随机/.test(name) &&
      !/^\d+(?:\.\d+)?\s*(?:mL|毫升|L|升|g|克|kg|千克)$/i.test(name);
    if (unambiguous) {
      // An explicit current-SKU checklist describes the actual packing row more
      // directly than a selected label containing scent or usage copy.
      add("包装名称", name, currentPacking);
      add("包装数量", String(count), currentPacking);
    }
  }
  const ambiguous = /随机|赠|任选|或|二选|三选/.test(
    text + (currentPacking?.value ?? ""),
  );
  let conflictingSingleBottlePacking = false;
  if (!ambiguous) {
    const singleBottleCandidate = text.match(
      /(\d+(?:\.\d+)?)\s*(mL|ml|ML|毫升|L|升|g|克|kg|千克)\s*(\/\s*瓶|(?<!\d)1\s*瓶(?!\d))/,
    );
    const explicitContainers = [
      ...text.matchAll(/(\d+)\s*(瓶|盒|袋|支|片|盘|桶|个)/g),
    ];
    const selectedSingleBottle =
      singleBottleCandidate &&
      !/[+＋x×*]/.test(text) &&
      (singleBottleCandidate[3].includes("/")
        ? explicitContainers.length === 0
        : explicitContainers.length === 1 &&
          explicitContainers[0][1] === "1" &&
          explicitContainers[0][2] === "瓶")
        ? singleBottleCandidate
        : null;
    if (selectedSingleBottle && selected?.sourceUrl === p.url) {
      const selectedAmount = amountKeys(selectedSingleBottle[0])[0];
      const packingAmounts = currentPacking
        ? amountKeys(currentPacking.value)
        : [];
      const packingConflict =
        new Set(packingAmounts).size > 1 ||
        (packingAmounts.length === 1 && packingAmounts[0] !== selectedAmount);
      conflictingSingleBottlePacking = packingConflict;
      if (!packingConflict) {
        add("包装数量", "1", selected);
        const packingName = currentPacking?.value
          .replace(amountPattern, "")
          .replace(/^[\s,，、+＋/]+|[\s,，、+＋/]+$/g, "")
          .trim();
        const selectedName = text
          .replace(selectedSingleBottle[0], "")
          .replace(/[（(][^）)]*[）)]/g, "")
          .replace(/^[\s,，、+＋/]+|[\s,，、+＋/]+$/g, "")
          .trim();
        add(
          "包装名称",
          packingName || selectedName || undefined,
          packingName ? currentPacking : selected,
        );
      }
    }
    const heater = text.match(/(\d+)\s*(?:个|台|只)?\s*(?:加热器|器)(?!具)/);
    if (heater) add("加热器数量", heater[1]);
    else if (/补充液/.test(text) && !/器/.test(text)) add("加热器数量", "0");
    const containers = [
      ...text.matchAll(
        /(\d+)\s*(瓶|盒|袋|支|片|盘|桶|个(?!\s*(?:加热器|器)))/g,
      ),
    ];
    const selectedMultipliedAmount = text.match(
      /\d+(?:\.\d+)?\s*(?:mL|ml|ML|毫升|L|升|g|克|kg|千克)(?:(?:\s*\/\s*瓶)?\s*[x×*]\s*\d{1,3}\s*(?:瓶|盒|袋|支|片|盘|桶|个)|\s*\/\s*瓶\s*\d{1,3}\s*瓶装?)/,
    )?.[0];
    if (heater && containers.length === 1) {
      // A mixed set has one packing row; do not add bottles and heaters together.
      add("包装名称", text + "套装");
      add("包装数量", "1");
    } else if (containers.length === 1) {
      add("包装数量", containers[0][1]);
      add(
        "包装名称",
        clean(text.replace(selectedMultipliedAmount ?? containers[0][0], "")) ||
          containers[0][2],
      );
    } else if (currentPacking?.value) {
      const sameBottles = [
        ...currentPacking.value.matchAll(/(?:[x×*]\s*)(\d+)瓶/g),
      ];
      const refill = currentPacking.value.match(
        /(\d+)正装\s*[+＋]\s*(\d+)补(?:液|充装)/,
      );
      if (
        sameBottles.length > 1 &&
        !/袋|器|赠|随机/.test(currentPacking.value)
      ) {
        add(
          "包装数量",
          String(sameBottles.reduce((n, m) => n + Number(m[1]), 0)),
          currentPacking,
        );
        add("包装名称", currentPacking.value.split(/[（(]/)[0], currentPacking);
      } else if (refill) {
        add(
          "包装数量",
          String(Number(refill[1]) + Number(refill[2])),
          currentPacking,
        );
        add("包装名称", currentPacking.value.split(/[（(]/)[0], currentPacking);
      }
    }
    const total = multipliedAmount(
      [
        selected?.sourceUrl === p.url
          ? { value: text, source: selected }
          : undefined,
        currentPacking
          ? { value: clean(currentPacking.value), source: currentPacking }
          : undefined,
      ].filter(
        (
          source,
        ): source is { value: string; source: NonNullable<typeof selected> } =>
          Boolean(source),
      ),
    );
    if (total) add("净含量", total.value, total.source);
    if (total) add("总净含量", total.value, total.source);
    // A single stated capacity without a multiplier stays verbatim.
    const capacities = [...text.matchAll(amountPattern)];
    if (!total && capacities.length === 1 && !/[x×*]\s*\d/.test(text))
      add("净含量", capacities[0][0]);
    if (!total && capacities.length === 1 && selectedSingleBottle)
      add("总净含量", capacities[0][0]);
  }
  if (
    currentPacking?.value.trim() &&
    !p.specs["包装数量"] &&
    !conflictingSingleBottlePacking
  ) {
    const wholePackageEvidence =
      currentPacking.evidence +
      "；用户确认：京东包装清单未写件数时按完整销售包装1份填写，1份不代表1支" +
      "；销售文字规则 sale-text/5";
    if (!p.specs["包装名称"])
      p.specs["包装名称"] = {
        ...currentPacking,
        value: currentPacking.value.trim(),
        evidence: wholePackageEvidence,
      };
    p.specs["包装数量"] = {
      ...currentPacking,
      value: "1",
      evidence: wholePackageEvidence,
    };
  }
  return p;
}
