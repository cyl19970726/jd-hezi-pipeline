/** Observed supplier after-sales table, using row labels rather than input positions across the page. */
export function afterSales(values?: Record<string, string>) {
  const root = document;
  const fields: Record<string, string> = {};
  for (const [label, key] of [
    ["退货", "refund"],
    ["换货", "exchange"],
    ["质保", "warranty"],
  ]) {
    const rows = [...root.querySelectorAll("tr")].filter(
      (r) => r.querySelector("td")?.textContent?.trim() === label,
    );
    if (rows.length !== 1) throw Error("After-sales row ambiguous: " + label);
    const row = rows[0];
    const inputs = [...row.querySelectorAll("input")].filter(
      (i) => i.type !== "radio" && i.type !== "checkbox",
    );
    if (inputs.length !== 1) throw Error("After-sales duration ambiguous");
    const name = "after_" + key;
    if (values) {
      if (!/^\d+$/.test(values[name] ?? ""))
        throw Error("Invalid after-sales duration");
      if (key !== "warranty") {
        const radio = row.querySelector(
          'input[type=radio][value="2"]',
        ) as HTMLInputElement;
        if (!radio) throw Error("Quality service option missing");
        if (!radio.checked) radio.click();
      }
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!;
      setter.call(inputs[0], values[name]);
      inputs[0].dispatchEvent(new Event("input", { bubbles: true }));
      inputs[0].dispatchEvent(new Event("change", { bubbles: true }));
      inputs[0].dispatchEvent(new Event("blur", { bubbles: true }));
    }
    fields[name] = inputs[0].value;
    if (key !== "warranty")
      fields[name + "_mode"] =
        (row.querySelector("input[type=radio]:checked") as HTMLInputElement)
          ?.value ?? "";
  }
  return fields;
}
