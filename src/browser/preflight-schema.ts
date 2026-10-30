/** Compare current UI schema with the exact schema used to prepare the batch. */
export function comparePreflightTemplate(expected: any, actual: any): string[] {
  const issues: string[] = [];
  if (!expected?.fields?.length)
    return ["本地模板缺少字段类型，请刷新类目模板"];
  const old = new Map<string, any>(
    expected.fields.map((f: any) => [f.name, f]),
  );
  for (const f of actual.fields ?? []) {
    const prior = old.get(f.name);
    if (
      !prior ||
      prior.id !== f.id ||
      prior.required !== f.required ||
      prior.selectType !== f.selectType
    )
      issues.push("平台规格结构已变化：" + f.name);
    if (
      !["1", "3"].includes(f.selectType) &&
      (f.required || expected.usedSpecs?.includes(f.name))
    )
      issues.push("尚未支持的规格控件：" + f.name + "（" + f.selectType + "）");
    old.delete(f.name);
  }
  for (const name of old.keys()) issues.push("平台缺少原规格字段：" + name);
  return issues;
}

/** Read controls only. No save, form fill, or framework-private state. */
export function preflightControls() {
  const tabs = [
    "基本信息",
    "上传图片",
    "商品详情",
    "规格参数",
    "包装清单",
    "销售价格",
    "售后服务",
    "物流规则",
  ];
  const issues: string[] = [];
  for (const name of tabs) {
    const found = [...document.querySelectorAll(".ant-tabs-tab-btn")].filter(
      (x) => x.textContent?.trim() === name,
    );
    if (found.length !== 1) issues.push("页面标签不能唯一定位：" + name);
  }
  for (const row of document.querySelectorAll(
    ".ant-tabs-tabpane-active tr[attrname][cid]",
  )) {
    const input = row
      .querySelectorAll("td")[1]
      ?.querySelector("input,textarea");
    const name = row.getAttribute("attrname"),
      type = row.getAttribute("selecttype");
    if (
      !input ||
      (type === "1" && !input.closest(".ant-select")) ||
      (type === "3" && !!input.closest(".ant-select"))
    )
      issues.push("规格控件与模板类型不符：" + name);
  }
  return { issues, tabs: tabs.length };
}

/** Read the packaging-name input contract without changing form state. */
export function preflightPackingName(packingName?: string) {
  const inputs = [
    ...document.querySelectorAll('input[placeholder="附件名称"]'),
  ] as HTMLInputElement[];
  if (!inputs.length)
    return {
      maxLength: null,
      issues: ["包装名称输入框无法定位"],
      valueIssues: [] as string[],
    };
  const limits = [
    ...new Set(
      inputs.map((input) =>
        Number(input.getAttribute("maxlength") ?? input.maxLength),
      ),
    ),
  ];
  if (limits.length !== 1 || !Number.isInteger(limits[0]) || limits[0] <= 0)
    return {
      maxLength: null,
      issues: ["包装名称输入框缺少唯一有效长度限制"],
      valueIssues: [] as string[],
    };
  const maxLength = limits[0];
  return {
    maxLength,
    issues: [] as string[],
    valueIssues:
      packingName !== undefined && packingName.length > maxLength
        ? [`包装名称超过页面长度限制（${packingName.length}/${maxLength}）`]
        : [],
  };
}
