/** Observe the actual title control; a disabled input alone is not a naming rule. */
export function readTitleControl() {
  const inputs = [
    ...document.querySelectorAll<HTMLInputElement>("#form_item_itemName"),
  ];
  if (inputs.length !== 1) throw Error("商品名称控件不唯一");
  const input = inputs[0];
  const notice = input.closest(".ant-form-item")?.textContent ?? "";
  const generated =
    /该类目下的商品将根据选择的品牌、类目、属性、商品单位组成商品名字/.test(
      notice,
    );
  if ((input.disabled || input.readOnly) && !generated)
    throw Error("商品名称不可编辑且缺少明确的自动命名说明");
  if (generated && !input.disabled && !input.readOnly)
    throw Error("自动命名说明与商品名称控件状态不一致");
  return {
    mode: generated ? ("platform-generated" as const) : ("source" as const),
    value: input.value,
  };
}

/** Read checked rows in the visible naming dialog. Never changes the platform's rule. */
export function readPlatformTitleRule() {
  const dialogs = [
    ...document.querySelectorAll<HTMLElement>(".ant-modal"),
  ].filter(
    (node) =>
      node.getBoundingClientRect().width > 0 &&
      node.textContent?.includes("选择组成商品名称的属性"),
  );
  if (dialogs.length !== 1) throw Error("自动命名规则窗口不唯一");
  const rows = [...dialogs[0].querySelectorAll("tr")];
  const parts: string[] = [];
  for (const row of rows) {
    const cells = [...row.querySelectorAll("td")];
    if (!cells.length) continue;
    const radios = [
      ...cells[0].querySelectorAll<HTMLInputElement>('input[type="radio"]'),
    ];
    if (radios.length !== 2 || radios.filter((r) => r.checked).length !== 1)
      throw Error("自动命名属性选择状态不明确");
    const selected = radios.find((r) => r.checked)!;
    if (!["0", "1"].includes(selected.value))
      throw Error("自动命名属性选项未知");
    if (selected.value === "1") {
      const name = cells[1]?.textContent?.trim();
      if (!name) throw Error("自动命名属性名称缺失");
      parts.push(name);
    }
  }
  if (
    new Set(parts).size !== parts.length ||
    !["品牌", "类目名称", "计价单位"].every((p) => parts.includes(p))
  )
    throw Error("自动命名规则缺少固定组成项或属性重复");
  return {
    mode: "platform-generated" as const,
    parts,
    separator: " " as const,
  };
}
