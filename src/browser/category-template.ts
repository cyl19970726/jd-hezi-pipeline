/** Read schema only from the visible supplier parameter table; never copy another item's values. */
export function readCategoryTemplate(categoryId: string) {
  const rows = [
    ...document.querySelectorAll(".ant-tabs-tabpane-active tr[attrname][cid]"),
  ];
  if (!rows.length || rows.some((r) => r.getAttribute("cid") !== categoryId))
    throw Error("当前规格表类目不符或尚未加载");
  const fields = rows.map((r) => {
    const id = r.getAttribute("attrid"),
      name = r.getAttribute("attrname")?.trim(),
      required = r.getAttribute("optiontype"),
      selectType = r.getAttribute("selecttype");
    if (!id || !name || !["1", "2"].includes(required ?? "") || !selectType)
      throw Error("规格字段标识或必填标记缺失");
    return { id, name, required: required === "1", selectType };
  });
  if (
    new Set(fields.map((f) => f.name)).size !== fields.length ||
    new Set(fields.map((f) => f.id)).size !== fields.length
  )
    throw Error("规格字段重复，无法确认模板");
  const specs = fields.filter((f) => f.required).map((f) => f.name);
  if (!specs.length) throw Error("未发现必填规格，需要核实模板");
  return {
    categoryId,
    specs,
    fields,
    sourceUrl: location.href,
    checkedAt: new Date().toISOString(),
  };
}
