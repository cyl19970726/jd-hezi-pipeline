/** DOM-backed form values, resolved by observed labels. No hidden API writes. */
export async function formBatch(args: {
  keys?: string[];
  values?: Record<string, string>;
}) {
  const labels: Record<string, string[]> = {
    title: ["商品名称"],
    origin: ["产地"],
    model: ["规格型号"],
    weight: ["商品重量"],
    sourceUrl: ["商品链接", "链接地址"],
    price: ["售价", "销售价格"],
  };
  const placeholders: Record<string, string> = {
    length: "长,大于0的整数",
    width: "宽,大于0的整数",
    height: "高,大于0的整数",
    weight: "商品重量",
    price: "最多保留两位小数",
  };
  const resolve = (key: string): HTMLInputElement | HTMLTextAreaElement => {
    let nodes: Element[] = [];
    if (key === "inventory") {
      for (const table of document.querySelectorAll(
        ".ant-tabs-tabpane-active table",
      )) {
        const i = [...table.querySelectorAll("thead th")].findIndex(
          (e) => e.textContent?.trim() === "库存",
        );
        if (i >= 0)
          for (const tr of table.querySelectorAll("tbody tr")) {
            const el = tr.querySelectorAll("td")[i]?.querySelector("input");
            if (el) nodes.push(el);
          }
      }
    } else {
      const forms = [...document.querySelectorAll(".ant-form-item")].filter(
        (e) => {
          const label =
            e.querySelector("label")?.textContent?.replace(/[\s*：:]/g, "") ??
            "";
          return (labels[key] ?? []).some(
            (l) => label === l || (key === "weight" && label.startsWith(l)),
          );
        },
      );
      nodes = forms
        .flatMap((e) => [
          ...e.querySelectorAll(
            "input:not([type=hidden]):not([readonly]),textarea",
          ),
        ])
        .filter((e) => (e as HTMLElement).getBoundingClientRect().width > 0);
      if (!nodes.length && placeholders[key])
        nodes = [...document.querySelectorAll("input")].filter(
          (e) =>
            e.placeholder === placeholders[key] &&
            e.getBoundingClientRect().width > 0,
        );
    }
    if (nodes.length !== 1) throw Error("Cannot uniquely resolve " + key);
    return nodes[0] as HTMLInputElement;
  };
  const keys = args.values ? Object.keys(args.values) : (args.keys ?? []);
  // Resolve every target before any edit, so schema drift does not cause a partial fill.
  const targets = Object.fromEntries(keys.map((k) => [k, resolve(k)]));
  if (args.values) {
    for (const [key, value] of Object.entries(args.values)) {
      const e = targets[key];
      if (
        e.disabled ||
        e.readOnly ||
        (e.maxLength > 0 && value.length > e.maxLength)
      )
        throw Error("Field rejects value: " + key);
    }
    for (const [key, value] of Object.entries(args.values)) {
      const e = resolve(key);
      if (e.value === value) continue;
      const proto =
        e.tagName === "TEXTAREA"
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype;
      const set = Object.getOwnPropertyDescriptor(proto, "value")?.set;
      if (!set) throw Error("Native field setter unavailable");
      set.call(e, value);
      e.dispatchEvent(new Event("input", { bubbles: true }));
      e.dispatchEvent(new Event("change", { bubbles: true }));
      e.dispatchEvent(new FocusEvent("blur", { bubbles: true }));
      await Promise.resolve();
    }
  }
  const result = Object.fromEntries(keys.map((k) => [k, resolve(k).value]));
  if (args.values)
    for (const k of keys)
      if (
        result[k] !== args.values[k] &&
        !(
          [
            "weight",
            "price",
            "inventory",
            "length",
            "width",
            "height",
          ].includes(k) &&
          result[k].trim() !== "" &&
          args.values[k].trim() !== "" &&
          Number(result[k]) === Number(args.values[k])
        )
      )
        throw Error("Field did not retain value: " + k);
  return result;
}
