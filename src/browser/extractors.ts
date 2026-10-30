// These functions run inside the page: keep them free of module-level references.
export function readPage() {
  const text = document.body?.innerText ?? "";
  const shopCandidates = [
    ...document.querySelectorAll(".ant-select-selection-item"),
  ]
    .map((e) => e.textContent?.trim() ?? "")
    .filter((t) => t.includes("国内店") && t.includes("|"));
  const shop =
    shopCandidates[0]
      ?.split("|")
      .slice(1)
      .join("|")
      .replace(/（启用）|\(启用\)/g, "")
      .trim() ?? "";
  const errors = [
    ...document.querySelectorAll(
      ".ant-message-notice-content,.ant-notification-notice-description,.ant-form-item-explain-error,.ant-modal-confirm-content",
    ),
  ]
    .map((e) => e.textContent?.trim() ?? "")
    .filter(Boolean);
  const positiveLogin =
    !!document.querySelector(".nickname")?.textContent?.trim() ||
    !!shop ||
    (location.hostname === "home.jd.com" && /我的订单|我的钱包/.test(text));
  const login =
    /^(passport\.jd\.com|sso\.csgmall\.com)$/.test(location.hostname) &&
    !positiveLogin;
  return {
    url: location.href,
    title: document.title,
    shop,
    errors,
    login,
    accountChanged: [...document.querySelectorAll('[role="dialog"]')].some(
      (e) => e.textContent?.includes("登录账号发生变更"),
    ),
    auth: positiveLogin
      ? "authenticated"
      : login
        ? "login_required"
        : "unknown",
    risk:
      (/(^|\.)csgmall\.com\.cn$/.test(location.hostname) &&
        (/\/mall-view\/intercept(?:[/?#]|$)/i.test(location.href) ||
          /AccessDeny|网站管理员策略阻断|请求已被.*策略阻断/i.test(
            document.title + " " + text.slice(0, 2000),
          ))) ||
      location.hostname === "pc-frequent-pro.pf.jd.com" ||
      /WAF拦截|访问频繁|PC频控页|安全验证|完成验证后|risk_handler/.test(
        document.title + " " + location.href + " " + text.slice(0, 1000),
      ),
    head: text.slice(0, 300),
  };
}
export function readJd() {
  const capturedAt = new Date().toISOString();
  const sourceUrl = location.href;
  const sku = location.pathname.match(/\/(\d+)\.html/)?.[1] ?? "";
  const fact = (value: string, evidence: string) => ({
    value,
    sourceUrl,
    capturedAt,
    evidence,
  });
  const title = document.title
    .replace(/【行情.*$|【价格.*$|[-－]京东.*$/, "")
    .trim();
  // A large red amount can be a coupon-dependent final price. Require its label.
  const candidates: {
    text: string;
    selector: string;
    basis: "subsidy" | "jd-price";
  }[] = [];
  let visibleRegularPrice = false;
  const addBoundedLabelledPrice = (
    panel: Element,
    label: Element,
    labelText: "补贴价" | "日常价" | "京东价",
  ) => {
    if (label.children.length || label.textContent?.trim() !== labelText)
      return;
    if ((label as HTMLElement).getBoundingClientRect().width <= 0) return;
    if (labelText !== "补贴价") visibleRegularPrice = true;
    // Stop at the first ancestor that contains price text. It must contain one
    // amount and no second price label, so a mixed panel can never donate a
    // neighbouring amount to this label.
    let group = label.parentElement;
    while (group && group !== panel) {
      const text = group.textContent?.trim() ?? "";
      const amounts = [...text.matchAll(/[¥￥]\s*(\d[\d,]*(?:\.\d{1,2})?)/g)];
      if (amounts.length) {
        if ((group as HTMLElement).getBoundingClientRect().width <= 0) break;
        const labels = [...group.querySelectorAll("*")].filter(
          (x) =>
            !x.children.length &&
            [
              "补贴价",
              "日常价",
              "京东价",
              "参考价",
              "到手价",
              "PLUS价",
            ].includes(x.textContent?.trim() ?? ""),
        );
        if (amounts.length === 1 && labels.length === 1 && labels[0] === label)
          candidates.push({
            text: amounts[0][1],
            selector: labelText + "：" + text,
            basis: labelText === "补贴价" ? "subsidy" : "jd-price",
          });
        break;
      }
      group = group.parentElement;
    }
  };
  for (const panel of document.querySelectorAll(".product-price-panel")) {
    if ((panel as HTMLElement).getBoundingClientRect().width <= 0) continue;
    const tag = panel.querySelector(".product-price--activity-item--tag");
    const tagText = tag?.textContent?.trim();
    const tagVisible =
      !!tag && (tag as HTMLElement).getBoundingClientRect().width > 0;
    if (tagVisible && ["补贴价", "日常价", "京东价"].includes(tagText ?? "")) {
      if (tagText !== "补贴价") visibleRegularPrice = true;
      const main = panel.querySelector(".product-price--main");
      const value = main?.textContent?.trim();
      if (
        value &&
        main &&
        (main as HTMLElement).getBoundingClientRect().width > 0
      )
        candidates.push({
          text: value,
          selector: tagText + "：主价格标签",
          basis: tagText === "补贴价" ? "subsidy" : "jd-price",
        });
    }
    for (const label of panel.querySelectorAll("*")) {
      const labelText = label.textContent?.trim();
      if (
        labelText === "补贴价" ||
        labelText === "日常价" ||
        labelText === "京东价"
      )
        addBoundedLabelledPrice(panel, label, labelText);
    }
  }
  // The promotion detail is SKU-bound page state. Accept only its exact JD-price
  // row, never the PLUS/final price elsewhere in the same popover.
  for (const item of document.querySelectorAll(".formula-details .item")) {
    if ((item as HTMLElement).getBoundingClientRect().width <= 0) continue;
    const desc = item.querySelector(".desc") as HTMLElement | null;
    const price = item.querySelector(".jd-price") as HTMLElement | null;
    if (
      !desc ||
      desc.getBoundingClientRect().width <= 0 ||
      !["京东价", "日常价"].includes(desc.textContent?.trim() ?? "")
    )
      continue;
    visibleRegularPrice = true;
    if (!price || price.getBoundingClientRect().width <= 0) continue;
    const value = price.textContent?.trim();
    if (value)
      candidates.push({
        text: value,
        selector: "优惠明细：" + desc.textContent?.trim(),
        basis: "jd-price",
      });
  }
  const normalized = (basis: "subsidy" | "jd-price") => [
    ...new Set(
      candidates
        .filter((x) => x.basis === basis)
        .map((x) => x.text.replace(/[¥￥,\s]/g, ""))
        .filter((x) => /^\d+(?:\.\d{1,2})?$/.test(x) && Number(x) > 0)
        .map((x) => Number(x).toFixed(2)),
    ),
  ];
  const subsidy = normalized("subsidy"),
    jdPrice = normalized("jd-price");
  // Prefer an explicit non-subsidy price. A unique subsidy price is a fallback
  // only when no visible regular-price label exists; an ambiguous or conflicting
  // visible regular price must fail closed instead of silently changing basis.
  const selected =
    jdPrice.length === 1
      ? { value: jdPrice[0], basis: "jd-price" as const }
      : !visibleRegularPrice && subsidy.length === 1
        ? { value: subsidy[0], basis: "subsidy" as const }
        : null;
  const specs: Record<string, ReturnType<typeof fact>> = {};
  for (const row of document.querySelectorAll(".attrs .item")) {
    const key = row.querySelector(".label")?.textContent?.trim();
    const value = row.querySelector(".value")?.textContent?.trim();
    if (key && value && value !== "暂无")
      specs[key] = fact(value, row.textContent ?? "");
  }
  for (const el of document.querySelectorAll(".highlight-attrs .item")) {
    const s = (el as HTMLElement).innerText
      ?.split("\n")
      .map((x) => x.trim())
      .filter(Boolean);
    if (s?.length === 2)
      specs[s[1]] = fact(s[0], (el as HTMLElement).innerText);
  }
  for (const tr of document.querySelectorAll(
    ".Ptable tr,.Ptable-item,.parameter2 li",
  )) {
    const cells = [...tr.querySelectorAll("th,td,dt,dd")].map(
      (x) => x.textContent?.trim() ?? "",
    );
    if (cells.length === 2 && cells[0] && cells[1])
      specs[cells[0]] = fact(cells[1], tr.textContent ?? "");
    else {
      const m = tr.textContent?.trim().match(/^([^：:]{1,30})[：:]\s*(.+)$/);
      if (m) specs[m[1]] = fact(m[2], tr.textContent ?? "");
    }
  }
  const getImages = (selector: string, role: "main" | "detail") => {
    const seenElements = new Set<Element>();
    const urls: string[] = [];
    for (const e of document.querySelectorAll(selector)) {
      // A selector union or future selector expansion can encounter one node
      // twice. Deduplicate traversal by node identity, never by URL: two real
      // source positions may intentionally use the same image.
      if (seenElements.has(e)) continue;
      seenElements.add(e);
      const im = e as HTMLImageElement;
      const raw =
        im.dataset.lazyload || im.dataset.src || im.currentSrc || im.src;
      if (!raw) continue;
      const url = new URL(raw, location.href).href;
      if (url.startsWith("https://")) urls.push(url);
    }
    return urls.map((url, order) => ({ role, url, order }));
  };
  return {
    sku,
    variant: "",
    url: sku ? `https://item.jd.com/${sku}.html` : sourceUrl,
    title: fact(title, document.title),
    price: selected
      ? {
          ...fact(
            selected.value,
            candidates.map((c) => c.selector + ": " + c.text).join("; "),
          ),
          basis: selected.basis,
        }
      : null,
    priceCandidates: candidates,
    priceEvidence: {
      visibleRegularPrice,
      regularPriceAmbiguous:
        visibleRegularPrice && normalized("jd-price").length !== 1,
    },
    specs,
    assets: [
      ...getImages(
        document.querySelector(".thumbnails img.image")
          ? ".thumbnails img.image"
          : "#spec-list img,#spec-img",
        "main",
      ),
      ...(() => {
        const urls: string[] = [];
        const seenElements = new Set<Element>();
        // The page also uses ssd-module-wrap for shop recommendations and ads.
        // Prefer the actual product detail root; never import surrounding cards.
        // An empty/failed root stays empty: sibling wrappers do not prove SKU ownership.
        const hasDetailRoot = !!document.querySelector(
          "#detail-main,#J-detail-content",
        );
        const selector = hasDetailRoot
          ? "#detail-main img,#detail-main .ssd-module,#J-detail-content img,#J-detail-content .ssd-module"
          : ".ssd-module-wrap:not(.ssd-format-wrap) img,.ssd-module-wrap:not(.ssd-format-wrap) .ssd-module";
        for (const e of document.querySelectorAll(selector)) {
          if (seenElements.has(e)) continue;
          seenElements.add(e);
          if (
            e.closest(
              ".ssd-format-wrap,.ssd-floor-activity,.ssd-floor-shopPrior",
            )
          )
            continue;
          const im = e as HTMLImageElement;
          const raw =
            e.tagName === "IMG"
              ? im.dataset.lazyload || im.dataset.src || im.currentSrc || im.src
              : getComputedStyle(e).backgroundImage.match(
                  /^url\(["']?(.*?)["']?\)$/,
                )?.[1];
          if (!raw) continue;
          const url = new URL(raw, location.href).href;
          if (url.startsWith("https://")) urls.push(url);
        }
        return urls.map((url, order) => ({
          role: "detail" as const,
          url,
          order,
        }));
      })(),
    ],
    capturedAt,
  };
}

export type JdFactRegion = "summarySpecs" | "detailSpecs" | "packaging";

/** Read only the requested fact-bearing areas. This deliberately has no image code. */
export function readJdRegions(regions: JdFactRegion[]) {
  const capturedAt = new Date().toISOString();
  const sourceUrl = location.href;
  const sku = location.pathname.match(/\/(\d+)\.html/)?.[1] ?? "";
  const requested = new Set(regions);
  const observed = new Set<JdFactRegion>();
  const specs: Record<
    string,
    { value: string; sourceUrl: string; capturedAt: string; evidence: string }
  > = {};
  const fact = (value: string, evidence: string) => ({
    value,
    sourceUrl,
    capturedAt,
    evidence,
  });
  const addPair = (key?: string, value?: string, evidence = "") => {
    const k = key?.replace(/[：:]$/, "").trim();
    const v = value?.trim();
    if (k && v && v !== "暂无") specs[k] = fact(v, evidence || `${k}：${v}`);
  };

  if (requested.has("summarySpecs")) {
    const roots = document.querySelectorAll(".attrs,.highlight-attrs");
    if (roots.length) observed.add("summarySpecs");
    for (const row of document.querySelectorAll(".attrs .item"))
      addPair(
        row.querySelector(".label")?.textContent ?? undefined,
        row.querySelector(".value")?.textContent ?? undefined,
        row.textContent ?? "",
      );
    for (const el of document.querySelectorAll(".highlight-attrs .item")) {
      const parts = (el as HTMLElement).innerText
        ?.split("\n")
        .map((x) => x.trim())
        .filter(Boolean);
      if (parts?.length === 2) addPair(parts[1], parts[0], parts.join(" "));
    }
  }

  if (requested.has("detailSpecs")) {
    const roots = document.querySelectorAll(".Ptable,.parameter2");
    if (roots.length) observed.add("detailSpecs");
    for (const row of document.querySelectorAll(
      ".Ptable tr,.Ptable-item,.parameter2 li",
    )) {
      const cells = [...row.querySelectorAll("th,td,dt,dd")].map(
        (x) => x.textContent?.trim() ?? "",
      );
      if (cells.length === 2)
        addPair(cells[0], cells[1], row.textContent ?? "");
      else {
        const match = row.textContent
          ?.trim()
          .match(/^([^：:]{1,30})[：:]\s*(.+)$/);
        if (match) addPair(match[1], match[2], row.textContent ?? "");
      }
    }
  }

  if (requested.has("packaging")) {
    const roots = document.querySelectorAll(
      ".package-list,#package-list,[class~='packing-list']",
    );
    if (roots.length) observed.add("packaging");
    const text = [...roots]
      .map((root) =>
        root.textContent?.replace(/^\s*包装清单\s*[：:]?\s*/, "").trim(),
      )
      .filter(Boolean)
      .join("\n");
    if (text) specs["包装清单"] = fact(text, "京东商品页包装清单区域");
  }

  const selected = [
    ...document.querySelectorAll(
      "#choose-attr-1 .item.selected a,#choose-attr-2 .item.selected a,.choose-sku .item.selected a,[class*=sku] [class*=selected] a",
    ),
  ]
    .map((el) => el.getAttribute("title") || el.textContent?.trim() || "")
    .filter(Boolean)
    .join(" ");
  return {
    sku,
    url: sku ? `https://item.jd.com/${sku}.html` : sourceUrl,
    selectedVariant: selected || undefined,
    specs,
    capturedAt,
    observedRegions: [...observed],
  };
}

/** Opens only the visible PLUS discount detail belonging to the current SKU page. */
export function openJdPriceDetails(expectedSku: string) {
  const sku = location.pathname.match(/^\/(\d+)\.html$/)?.[1];
  if (sku !== expectedSku) return false;
  for (const el of document.querySelectorAll<HTMLElement>(
    ".product-price-panel button,.product-price-panel [role=button],.product-price-panel a,.product-price-panel [class*=activity],.shareds .floor-list *",
  )) {
    const text = el.textContent?.replace(/\s+/g, "").trim() ?? "";
    if (
      !/^PLUS.*折.*立减\d+(?:\.\d+)?元$/.test(text) &&
      !/^首购礼金可减\d+(?:\.\d+)?元$/.test(text)
    )
      continue;
    if (
      [...el.children].some(
        (child) => child.textContent?.replace(/\s+/g, "").trim() === text,
      )
    )
      continue;
    if (el.getBoundingClientRect().width <= 0) continue;
    el.click();
    return true;
  }
  return false;
}
export function readFields() {
  const values: Record<string, string> = {};
  for (const el of document.querySelectorAll(
    "input[id],textarea[id],select[id]",
  )) {
    const input = el as HTMLInputElement;
    values[input.id] = input.value;
  }
  const specs: Record<string, string> = {};
  const requiredMissing: string[] = [];
  for (const pane of document.querySelectorAll(".ant-tabs-tabpane")) {
    if (!pane.textContent?.includes("规格名称")) continue;
    for (const row of pane.querySelectorAll("tr")) {
      const cells = row.querySelectorAll("td");
      if (cells.length < 2) continue;
      const label =
        (cells[0].querySelector("input") as HTMLInputElement)?.value ||
        cells[0].textContent ||
        "";
      const clean = label.replace(/\*/g, "").trim();
      const input = cells[1].querySelector(
        "input,textarea",
      ) as HTMLInputElement | null;
      const selection = cells[1]
        .querySelector(".ant-select-selection-item")
        ?.textContent?.trim();
      if (!clean || (!input && !selection)) continue;
      // Ant Select keeps its search input empty after a choice is made.  The
      // displayed selection is the persisted specification value instead.
      const value = selection || input?.value || "";
      specs[clean] = value;
      if (
        (cells[0].textContent?.includes("*") ||
          cells[0].querySelector(".required,.ant-form-item-required")) &&
        !value.trim()
      )
        requiredMissing.push(clean);
    }
  }
  for (const el of document.querySelectorAll(".ant-form-item")) {
    if (!(el as HTMLElement).getBoundingClientRect().width) continue;
    const label = el.querySelector(".ant-form-item-required");
    if (!label) continue;
    const input = el.querySelector(
      "input:not([type=hidden]):not([type=file]),textarea,select",
    ) as HTMLInputElement | null;
    const selection = el
      .querySelector(".ant-select-selection-item")
      ?.textContent?.trim();
    if (input && !input.value.trim() && !selection)
      requiredMissing.push(label.textContent?.trim() ?? input.id);
  }
  const fields = [...document.querySelectorAll("input,textarea,select")]
    .filter((e) => (e as HTMLElement).getBoundingClientRect().width > 0)
    .map((e) => {
      const x = e as HTMLInputElement;
      return {
        id: x.id,
        placeholder: x.getAttribute("placeholder"),
        value: x.value,
        type: x.type,
        label: x.closest(".ant-form-item")?.querySelector("label")?.textContent,
      };
    });
  const files = [...document.querySelectorAll("input[type=file]")].map((e) => ({
    accept: e.getAttribute("accept"),
    multiple: e.hasAttribute("multiple"),
    outer: e.outerHTML.slice(0, 700),
  }));
  return { values, specs, requiredMissing, fields, files };
}
export function readRows() {
  const tables = [...document.querySelectorAll("table")];
  const records: {
    code: string;
    title: string;
    status: string;
    itemId: string;
    editHref: string;
    category: string;
    platformWarning?: string | null;
  }[] = [];
  for (const table of tables) {
    let headers = [...table.querySelectorAll("thead th")].map(
      (x) => x.textContent?.trim() ?? "",
    );
    if (!headers.length) {
      const parent = table.closest(".ant-table-wrapper");
      headers = [...(parent?.querySelectorAll("thead th") ?? [])].map(
        (x) => x.textContent?.trim() ?? "",
      );
    }
    const codeIndex = headers.findIndex((h) => h === "商品编码");
    const titleIndex = headers.findIndex((h) => h === "商品信息");
    const statusIndex = headers.findIndex((h) => h === "状态");
    const catIndex = headers.findIndex((h) => h === "所属类目");
    const warningIndex = headers.findIndex((h) => h === "下架原因");
    if (codeIndex < 0 || titleIndex < 0 || statusIndex < 0) continue;
    for (const tr of table.querySelectorAll("tbody tr")) {
      const td = [...tr.querySelectorAll("td")];
      if (td.length <= Math.max(codeIndex, titleIndex, statusIndex)) continue;
      const code = td[codeIndex].textContent?.trim() ?? "";
      const title =
        td[titleIndex].textContent?.replace(/^\s*预览\s*/, "").trim() ?? "";
      if (!/^\d+$/.test(code) || !title) continue;
      const edit = [...tr.querySelectorAll("a")].find(
        (a) => a.textContent?.trim() === "编辑",
      );
      const itemId =
        [...tr.querySelectorAll("[href]")]
          .map(
            (a) =>
              a.getAttribute("href")?.match(/[?&]itemId=(\d+)(?:&|$)/)?.[1],
          )
          .find(Boolean) ?? "";
      records.push({
        code,
        itemId,
        title,
        status:
          td[statusIndex].querySelector(".ant-tag")?.textContent?.trim() ??
          td[statusIndex].textContent?.trim() ??
          "",
        category: td[catIndex]?.textContent?.trim() ?? "",
        ...(warningIndex >= 0 && td[warningIndex]
          ? { platformWarning: td[warningIndex].textContent?.trim() || null }
          : {}),
        editHref: edit?.getAttribute("href") ?? "",
      });
    }
  }
  const next = document.querySelector(".ant-pagination-next");
  return {
    records,
    nextAvailable:
      !!next && !next.classList.contains("ant-pagination-disabled"),
    hasTable:
      tables.some((t) => t.textContent?.includes("商品编码")) ||
      !!document.querySelector(".ant-table-wrapper"),
    totalText:
      document.querySelector(".ant-pagination-total-text")?.textContent ?? "",
    empty: !!document.querySelector(".ant-empty-description"),
  };
}
