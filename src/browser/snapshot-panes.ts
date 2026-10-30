/**
 * Read every persisted editor pane in one page execution.
 *
 * The helper arguments are deliberately functions: callers can serialize this
 * function and the three existing DOM readers into one Runtime.evaluate call.
 */
export async function readSnapshotPanes(
  readFields: () => {
    values: Record<string, string>;
    specs: Record<string, string>;
    requiredMissing: string[];
    fields: unknown[];
    files: unknown[];
  },
  formBatch: (args: { keys: string[] }) => Promise<Record<string, string>>,
  afterSales: () => Record<string, string>,
) {
  const names = [
    "基本信息",
    "上传图片",
    "商品详情",
    "规格参数",
    "销售价格",
    "包装清单",
    "售后服务",
    "物流规则",
  ];
  const startedAt = Date.now();
  const deadline = startedAt + 12_000;
  const paneDurations: Record<string, number> = {};
  const result: {
    fields: Record<string, string>;
    specs: Record<string, string>;
    requiredMissing: string[];
    mainImages: { url: string; loaded: boolean }[];
    detailImages: { url: string; loaded: boolean }[];
    readbackMetrics?: {
      totalDurationMs: number;
      paneDurationsMs: Record<string, number>;
      paneOrder: string[];
    };
  } = {
    fields: {},
    specs: {},
    requiredMissing: [],
    mainImages: [],
    detailImages: [],
  };
  const text = (e: Element) => e.textContent?.trim() ?? "";
  const sleep = () => new Promise<void>((resolve) => setTimeout(resolve, 25));
  const basicTabs = [...document.querySelectorAll(".ant-tabs-tab-btn")].filter(
    (candidate) => text(candidate) === "基本信息",
  );
  if (basicTabs.length !== 1)
    throw Error(
      `Snapshot DOM error: tab 基本信息 expected once, found ${basicTabs.length}`,
    );
  const root = basicTabs[0].closest(".ant-tabs");
  if (!root || !document.documentElement.contains(root))
    throw Error("Snapshot DOM error: inner product tabs root is not connected");
  const owned = (element: Element) => element.closest(".ant-tabs") === root;
  const tabFor = (name: string) =>
    [...root.querySelectorAll(".ant-tabs-tab-btn")].filter(
      (candidate) => owned(candidate) && text(candidate) === name,
    );
  for (const name of names) {
    const tabs = tabFor(name);
    if (tabs.length !== 1)
      throw Error(
        `Snapshot DOM error: tab ${name} expected once in product tabs, found ${tabs.length}`,
      );
  }
  const activePane = () => {
    const panes = [...root.querySelectorAll(".ant-tabs-tabpane-active")].filter(
      owned,
    );
    if (panes.length !== 1)
      throw Error(
        `Snapshot DOM error: expected one active pane, found ${panes.length}`,
      );
    return panes[0];
  };
  const ready = (name: string) => {
    const activeTabs = [
      ...root.querySelectorAll(".ant-tabs-tab-active"),
    ].filter(owned);
    if (activeTabs.length !== 1 || text(activeTabs[0]) !== name) return false;
    const panes = [...root.querySelectorAll(".ant-tabs-tabpane-active")].filter(
      owned,
    );
    if (panes.length !== 1) return false;
    const pane = panes[0];
    if (pane.querySelector(".ant-spin-spinning")) return false;
    if (name === "规格参数")
      return [...pane.querySelectorAll("tr")].some(
        (row) =>
          row.querySelectorAll("td").length >= 2 &&
          !!row.querySelector("input"),
      );
    if (name === "包装清单")
      return !!pane.querySelector('input[placeholder="附件名称"]');
    if (name === "商品详情") {
      try {
        return !!(
          pane.querySelector(
            "iframe.tox-edit-area__iframe",
          ) as HTMLIFrameElement | null
        )?.contentDocument?.body;
      } catch {
        return false;
      }
    }
    if (name === "上传图片") return !!pane.querySelector("input[type=file]");
    return true;
  };
  const waitUntil = async (predicate: () => boolean, message: string) => {
    while (true) {
      if (predicate()) return;
      if (Date.now() >= deadline)
        throw Error(`Snapshot timeout after 12000ms: ${message}`);
      await sleep();
    }
  };
  const waitImages = async (name: string) => {
    await waitUntil(() => {
      const pane = activePane();
      const images =
        name === "商品详情"
          ? [...pane.querySelectorAll("iframe.tox-edit-area__iframe")].flatMap(
              (frame) => [
                ...((
                  frame as HTMLIFrameElement
                ).contentDocument?.querySelectorAll("img") ?? []),
              ],
            )
          : [...pane.querySelectorAll(".img-upload-box img")];
      return images.every((image) => (image as HTMLImageElement).complete);
    }, `${name} images did not complete`);
  };

  for (const name of names) {
    const paneStartedAt = Date.now();
    const tabs = tabFor(name);
    (tabs[0] as HTMLElement).scrollIntoView?.({ block: "center" });
    (tabs[0] as HTMLElement).click();
    await waitUntil(() => ready(name), `tab ${name} did not become ready`);

    if (name === "上传图片" || name === "商品详情") await waitImages(name);
    if (name === "售后服务") Object.assign(result.fields, afterSales());
    const raw = readFields();
    result.requiredMissing.push(...raw.requiredMissing);
    Object.assign(result.specs, raw.specs);

    if (name === "基本信息" || name === "销售价格") {
      Object.assign(
        result.fields,
        await formBatch({
          keys:
            name === "基本信息"
              ? [
                  "title",
                  "origin",
                  "model",
                  "weight",
                  "length",
                  "width",
                  "height",
                  "sourceUrl",
                ]
              : ["price", "inventory"],
        }),
      );
      if (name === "基本信息") {
        const values: Record<string, string> = {};
        const map: Record<string, string> = {
          商品类目: "category",
          品牌: "brand",
          单位: "unit",
        };
        for (const form of document.querySelectorAll(".ant-form-item")) {
          const key =
            map[
              form
                .querySelector("label")
                ?.textContent?.replace(/[\s*：:]/g, "") ?? ""
            ];
          if (!key) continue;
          const input = form.querySelector(
            key === "category" ? "#form_item_categoryName" : "input",
          ) as HTMLInputElement | null;
          values[key] =
            form
              .querySelector(".ant-select-selection-item")
              ?.textContent?.trim() ||
            input?.value ||
            form
              .querySelector(".ant-form-item-control-input-content")
              ?.textContent?.trim() ||
            "";
        }
        const jd = [...document.querySelectorAll("input")].find((input) =>
          /^https:\/\/item\.jd\.com\/\d+\.html/.test(input.value),
        );
        if (jd) values.sourceUrl = jd.value;
        Object.assign(result.fields, values);
      }
    }
    if (name === "上传图片")
      result.mainImages = [
        ...activePane().querySelectorAll(".img-upload-box img"),
      ].map((image) => ({
        url: (image as HTMLImageElement).src,
        loaded:
          (image as HTMLImageElement).complete &&
          (image as HTMLImageElement).naturalWidth > 0,
      }));
    if (name === "商品详情") {
      const frames = [...activePane().querySelectorAll("iframe")].filter(
        (frame) =>
          frame.id.includes("tiny") ||
          frame.classList.contains("tox-edit-area__iframe"),
      );
      result.detailImages = frames.flatMap((frame) => {
        try {
          return [
            ...((frame as HTMLIFrameElement).contentDocument?.querySelectorAll(
              "img",
            ) ?? []),
          ].map((image) => ({
            url: image.src,
            loaded: image.complete && image.naturalWidth > 0,
          }));
        } catch {
          return [];
        }
      });
    }
    if (name === "包装清单")
      Object.assign(result.fields, {
        packingName:
          (
            activePane().querySelector(
              'input[placeholder="附件名称"]',
            ) as HTMLInputElement | null
          )?.value ?? "",
        packingCount:
          (
            activePane().querySelector(
              'input[placeholder="附件数量，请输入1-999的整数"]',
            ) as HTMLInputElement | null
          )?.value ?? "",
      });
    if (name === "物流规则")
      result.fields.shippingTemplate =
        [...activePane().querySelectorAll(".ant-select-selection-item")]
          .map((item) => text(item))
          .filter(Boolean)[0] ?? "";
    paneDurations[name] = Date.now() - paneStartedAt;
  }
  result.readbackMetrics = {
    totalDurationMs: Date.now() - startedAt,
    paneDurationsMs: paneDurations,
    paneOrder: names,
  };
  return result;
}
