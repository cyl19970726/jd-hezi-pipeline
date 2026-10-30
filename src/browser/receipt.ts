/** Observe the application's own save response without modifying requests or credentials. */
export function selectSiteApiClient(exports: Record<string, unknown>) {
  const clients = [
    ...new Set(
      Object.values(exports).filter(
        (value: any) =>
          value &&
          (typeof value === "object" || typeof value === "function") &&
          typeof value.post === "function" &&
          typeof value.get === "function",
      ),
    ),
  ] as any[];
  if (clients.length !== 1) throw Error("Site API client is not unique");
  return clients[0];
}

export async function observeNewSave(
  sku: string,
  entryPath: string,
  selectClient: (exports: Record<string, unknown>) => any,
  providedClient?: any,
) {
  const w = window as any;
  if (
    !location.hash.includes("goods/publish") ||
    /[?&]itemId=/.test(location.hash)
  )
    throw Error("Not a new product form");
  const url = (
    document.querySelector(
      "#form_item_linkList_0_goodsLink",
    ) as HTMLInputElement
  )?.value;
  if (url !== `https://item.jd.com/${sku}.html`)
    throw Error("Source SKU differs");
  if (!/\/shop-view\/assets\/index-[a-z0-9]+\.js(?:[?#].*)?$/i.test(entryPath))
    throw Error("Invalid site entry module");
  const client = providedClient ?? selectClient(await import(entryPath));
  if (typeof client?.post !== "function")
    throw Error("Site API version changed");
  if (w.__heziSaveWatching) throw Error("A save observer is already installed");
  const original = client.post;
  w.__heziSaveReceipt = null;
  w.__heziSaveDiagnostic = null;
  w.__heziSaveWatching = true;
  client.post = async function (request: any, ...options: any[]) {
    if (request.url !== "/item/shop/itemTmplPublish/saveItemPublish")
      return original.call(this, request, ...options);
    if (request.params?.id) throw Error("Unexpected existing ID");
    const sanitize = (value: any, depth = 0): any => {
      if (depth > 4) return "[truncated]";
      if (value === null || ["number", "boolean"].includes(typeof value))
        return value;
      if (typeof value === "string") return value.slice(0, 1000);
      if (Array.isArray(value))
        return value.slice(0, 20).map((item) => sanitize(item, depth + 1));
      if (typeof value !== "object") return String(value).slice(0, 1000);
      return Object.fromEntries(
        Object.entries(value)
          .slice(0, 50)
          .map(([key, item]) => [
            key,
            /token|cookie|authorization|password|secret|credential|session|sign/i.test(
              key,
            )
              ? "[redacted]"
              : sanitize(item, depth + 1),
          ]),
      );
    };
    try {
      const result = await original.call(this, request, ...options);
      const id = String(result);
      w.__heziSaveDiagnostic = {
        outcome: "resolved",
        responseType: Array.isArray(result) ? "array" : typeof result,
        response: sanitize(result),
        itemIdCaptured: /^\d+$/.test(id),
      };
      if (!/^\d+$/.test(id)) throw Error("Save result is not an item ID");
      w.__heziSaveReceipt = { itemId: id, sku };
      return result;
    } catch (error: any) {
      if (!w.__heziSaveDiagnostic) {
        const safeError: Record<string, unknown> = {
          name: String(error?.name ?? "Error").slice(0, 100),
          message: String(error?.message ?? error).slice(0, 1000),
        };
        for (const key of ["code", "status", "statusText", "details", "data"])
          if (error?.[key] !== undefined) safeError[key] = sanitize(error[key]);
        w.__heziSaveDiagnostic = {
          outcome: "rejected",
          error: safeError,
        };
      }
      throw error;
    } finally {
      client.post = original;
      w.__heziSaveWatching = false;
    }
  };
  return { watching: true };
}
