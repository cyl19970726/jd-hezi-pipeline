import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ReleaseGuard, releaseVersion } from "../src/release-version.js";
test("release guard fingerprints executable changes and stops mixed-version processing", async () => {
  const root = await mkdtemp(join(tmpdir(), "hezi-release-"));
  try {
    await mkdir(join(root, "dist"));
    await mkdir(join(root, "web"));
    for (const f of [
      "dist/server.js",
      "web/app.js",
      "package.json",
      "package-lock.json",
    ])
      await writeFile(join(root, f), "first");
    const guard = await ReleaseGuard.create(root);
    await guard.assertCurrent();
    assert.equal(await releaseVersion(root), guard.releaseId);
    await writeFile(join(root, "dist/server.js"), "second");
    await assert.rejects(guard.assertCurrent(), /运行版本发生变化/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
