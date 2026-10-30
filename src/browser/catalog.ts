/** Read only data already bound to the current page's catalog controls. */
export function readCatalogOptions() {
  const app = (document.querySelector("#app") as any)?.__vue_app__;
  const queue = [app?._container?._vnode];
  const seen = new Set<any>();
  let tree: any[] | undefined, brands: any[] | undefined;
  while (queue.length && seen.size < 10000) {
    const v = queue.shift();
    if (!v || typeof v !== "object" || seen.has(v)) continue;
    seen.add(v);
    const c = v.component,
      props = c?.props ?? v.props ?? {};
    if (props.id === "form_item_categoryId" && Array.isArray(props.treeData))
      tree = props.treeData;
    if (props.id === "form_item_brandId" && Array.isArray(props.options))
      brands = props.options;
    if (c?.subTree) queue.push(c.subTree);
    if (Array.isArray(v.children)) queue.push(...v.children);
  }
  if (!tree?.length || !brands?.length)
    throw new Error("当前目录控件未加载，或组件结构已变化");
  const checkedAt = new Date().toISOString(),
    sourceUrl = location.href;
  const categories: any[] = [];
  const visit = (nodes: any[], parentId: string | null, path: string[]) => {
    for (const node of nodes) {
      if (node.id === undefined || !node.categoryName)
        throw new Error("类目节点缺少平台ID或名称");
      const id = String(node.id),
        name = String(node.categoryName),
        names = [...path, name];
      categories.push({
        id,
        parentId,
        name,
        path: names.join(" > "),
        selectable: !node.disabled && !node.children?.length,
        checkedAt,
        sourceUrl,
      });
      if (node.children?.length) visit(node.children, id, names);
    }
  };
  visit(tree, null, []);
  return {
    categories,
    brands: brands.map((b) => {
      if (b.value === undefined || !b.label)
        throw new Error("品牌选项缺少品牌ID或名称");
      return {
        id: String(b.value),
        name: String(b.label),
        checkedAt,
        sourceUrl,
      };
    }),
    grants: [],
  };
}

/**
 * Non-mutating readiness probe for the page-bound catalog controls.
 * The runtime can wait on this before calling readCatalogOptions, avoiding a
 * false UI_CHANGED result while the loaded list is still fetching options.
 */
export function catalogOptionsReady() {
  const app = (document.querySelector("#app") as any)?.__vue_app__;
  const queue = [app?._container?._vnode];
  const seen = new Set<any>();
  let categoryCount = 0,
    brandCount = 0,
    categoryControl = false,
    brandControl = false;
  while (queue.length && seen.size < 10000) {
    const v = queue.shift();
    if (!v || typeof v !== "object" || seen.has(v)) continue;
    seen.add(v);
    const c = v.component,
      props = c?.props ?? v.props ?? {};
    if (props.id === "form_item_categoryId") {
      categoryControl = true;
      if (Array.isArray(props.treeData)) categoryCount = props.treeData.length;
    }
    if (props.id === "form_item_brandId") {
      brandControl = true;
      if (Array.isArray(props.options)) brandCount = props.options.length;
    }
    if (c?.subTree) queue.push(c.subTree);
    if (Array.isArray(v.children)) queue.push(...v.children);
  }
  return {
    ready: categoryCount > 0 && brandCount > 0,
    categoryCount,
    brandCount,
    categoryControl,
    brandControl,
  };
}
