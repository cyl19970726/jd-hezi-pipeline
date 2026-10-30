import { backup, DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, chmod } from "node:fs/promises";
import { resolve } from "node:path";
import { Store } from "./store.js";
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
function counts(db: DatabaseSync) {
  return Object.fromEntries(
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all()
      .map((r) => [
        String(r.name),
        Number(
          db
            .prepare(
              'SELECT COUNT(*) n FROM "' +
                String(r.name).replaceAll('"', '""') +
                '"',
            )
            .get()?.n,
        ),
      ]),
  );
}
/** Local recovery package. Asset destinations retain original paths in the manifest. Never overwrites. */
export async function createRecoverySnapshot(
  store: Store,
  destination: string,
) {
  const target = resolve(destination);
  await mkdir(target, { mode: 0o700 });
  await backup(store.db, resolve(target, "state.sqlite"));
  await chmod(resolve(target, "state.sqlite"), 0o600);
  const db = new DatabaseSync(resolve(target, "state.sqlite"), {
    readOnly: true,
  });
  try {
    const assets = new Map<string, string | undefined>();
    for (const row of db
      .prepare("SELECT product FROM products WHERE product IS NOT NULL")
      .all()) {
      const p = JSON.parse(String(row.product));
      for (const a of p.assets ?? []) {
        if (a.path) assets.set(a.path, a.sha256);
        if (a.originalPath) assets.set(a.originalPath, a.originalSha256);
      }
    }
    // A phone run may have durable original files before Store.put(product). Back those up too.
    for (const row of db
      .prepare("SELECT value FROM meta WHERE key LIKE 'android-capture:%'")
      .all()) {
      const cp = JSON.parse(String(row.value));
      for (const a of [...(cp.main ?? []), ...(cp.detail ?? [])]) {
        if (a.path) assets.set(a.path, a.sha256);
        if (a.originalPath) assets.set(a.originalPath, a.originalSha256);
      }
    }
    await mkdir(resolve(target, "files"), { mode: 0o700 });
    const files = [];
    const copied = new Set<string>();
    for (const [originalPath, expected] of assets) {
      const content = await readFile(originalPath),
        hash = sha(content);
      if (expected && expected !== hash)
        throw Error("原素材校验失败：" + originalPath);
      const path = "files/" + hash;
      if (!copied.has(hash)) {
        await writeFile(resolve(target, path), content, {
          mode: 0o600,
          flag: "wx",
        });
        copied.add(hash);
      }
      files.push({ originalPath, path, sha256: hash, size: content.length });
    }
    const manifest = {
      version: 1,
      createdAt: new Date().toISOString(),
      databaseSha256: sha(await readFile(resolve(target, "state.sqlite"))),
      tables: counts(db),
      files,
    };
    await writeFile(
      resolve(target, "manifest.json"),
      JSON.stringify(manifest, null, 2),
      { mode: 0o600, flag: "wx" },
    );
    return { path: target, ...(await verifyRecoverySnapshot(target)) };
  } finally {
    db.close();
  }
}
export async function verifyRecoverySnapshot(destination: string) {
  const target = resolve(destination),
    manifest = JSON.parse(
      await readFile(resolve(target, "manifest.json"), "utf8"),
    );
  if (
    manifest.version !== 1 ||
    sha(await readFile(resolve(target, "state.sqlite"))) !==
      manifest.databaseSha256
  )
    throw Error("备份数据库校验失败");
  for (const file of manifest.files) {
    if (!/^files\/[a-f0-9]{64}$/.test(file.path))
      throw Error("备份文件路径校验失败");
    const b = await readFile(resolve(target, file.path));
    if (b.length !== file.size || sha(b) !== file.sha256)
      throw Error("备份素材校验失败");
  }
  const db = new DatabaseSync(resolve(target, "state.sqlite"), {
    readOnly: true,
  });
  try {
    if (db.prepare("PRAGMA integrity_check").get()?.integrity_check !== "ok")
      throw Error("备份数据库完整性校验失败");
    if (JSON.stringify(counts(db)) !== JSON.stringify(manifest.tables))
      throw Error("备份表记录数量校验失败");
    return {
      products: Number(db.prepare("SELECT COUNT(*) n FROM products").get()?.n),
      remoteBindings: Number(
        db
          .prepare(
            "SELECT COUNT(*) n FROM products WHERE remote_id IS NOT NULL",
          )
          .get()?.n,
      ),
      files: manifest.files.length,
      createdAt: manifest.createdAt,
    };
  } finally {
    db.close();
  }
}
