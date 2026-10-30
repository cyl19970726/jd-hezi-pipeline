import { readdir, readFile } from "node:fs/promises";
import { resolve, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { digest, PipelineError } from "./model.js";
export const PACKAGE_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
);
/** Fingerprint actual executable files, not a git label that can hide local edits. */
export async function releaseVersion(root = PACKAGE_ROOT): Promise<string> {
  const files: string[] = [];
  async function walk(path: string) {
    for (const entry of (await readdir(path, { withFileTypes: true })).sort(
      (a, b) => a.name.localeCompare(b.name),
    )) {
      const full = resolve(path, entry.name);
      if (entry.isSymbolicLink())
        throw new PipelineError("NEEDS_INPUT", "发布文件不能使用可变符号链接");
      if (entry.isDirectory()) await walk(full);
      else if (
        entry.isFile() &&
        !entry.name.endsWith(".map") &&
        !entry.name.endsWith(".d.ts")
      )
        files.push(full);
    }
  }
  await walk(resolve(root, "dist"));
  await walk(resolve(root, "web"));
  files.push(resolve(root, "package.json"), resolve(root, "package-lock.json"));
  const content = await Promise.all(
    files
      .sort()
      .map(async (file) => [
        relative(root, file),
        digest((await readFile(file)).toString("base64")),
      ]),
  );
  return digest({ runtime: process.version, files: content });
}
export class ReleaseGuard {
  private constructor(
    readonly releaseId: string,
    readonly root: string,
  ) {}
  static async create(root = PACKAGE_ROOT) {
    return new ReleaseGuard(await releaseVersion(root), root);
  }
  async assertCurrent() {
    if ((await releaseVersion(this.root)) !== this.releaseId)
      throw new PipelineError(
        "PAUSED",
        "运行版本发生变化；停止当前服务并在固定版本重新启动后再继续",
      );
  }
}
