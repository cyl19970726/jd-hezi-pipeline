import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { JD_CAPTURE_PARSER } from "../jd-capture.js";
import { parseSku } from "../model.js";

export interface JdBusinessObservation {
  version: 1;
  parserVersion: string;
  shopScope: string;
  sku: string;
  sourceUrl: string;
  observedAt: string;
  response: unknown;
}

/** Persist an already received response for offline parser work; this performs no network I/O. */
export async function archiveJdBusinessObservation(args: {
  sourceDatabasePath?: string;
  shop: string;
  sku: string;
  sourceUrl: string;
  response: unknown;
  observedAt?: string;
  parserVersion?: string;
}) {
  if (!args.sourceDatabasePath) return null;
  if (!/^\d+$/.test(args.sku) || parseSku(args.sourceUrl) !== args.sku)
    throw Error("京东业务观测来源URL与SKU不符");
  if (
    !args.response ||
    typeof args.response !== "object" ||
    String((args.response as any).wareInfoReadMap?.product_id) !== args.sku
  )
    throw Error("京东业务观测响应SKU不符");
  if (!args.shop.trim()) throw Error("京东业务观测缺少店铺范围");
  const observedTime = Date.parse(args.observedAt ?? new Date().toISOString());
  if (!Number.isFinite(observedTime)) throw Error("京东业务观测时间无效");
  const observedAt = new Date(observedTime).toISOString();
  const shopScope = createHash("sha256")
    .update(args.shop)
    .digest("hex")
    .slice(0, 20);
  const archiveRoot = resolve(
    dirname(resolve(args.sourceDatabasePath)),
    "jd-observations",
  );
  const shopDirectory = resolve(archiveRoot, shopScope);
  const directory = resolve(shopDirectory, args.sku);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await Promise.all(
    [archiveRoot, shopDirectory, directory].map((path) => chmod(path, 0o700)),
  );
  const name = observedAt.replace(/[:.]/g, "-") + "-" + randomUUID();
  const path = resolve(directory, name + ".json");
  const temporary = path + ".tmp";
  const observation: JdBusinessObservation = {
    version: 1,
    parserVersion: args.parserVersion ?? JD_CAPTURE_PARSER,
    shopScope,
    sku: args.sku,
    sourceUrl: args.sourceUrl,
    observedAt,
    response: args.response,
  };
  try {
    await writeFile(temporary, JSON.stringify(observation), {
      mode: 0o600,
      flag: "wx",
    });
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
  return path;
}
