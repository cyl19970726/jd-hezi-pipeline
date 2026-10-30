import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.js";
import { example } from "../src/demo.js";
import {
  createRecoverySnapshot,
  verifyRecoverySnapshot,
} from "../src/recovery-snapshot.js";
test("snapshot includes committed WAL data and detects later backup corruption", async () => {
  const root = await mkdtemp(join(tmpdir(), "hezi-recovery-"));
  const s = new Store(join(root, "state.sqlite"));
  try {
    const { product, plan } = example();
    product.assets = [];
    const r = s.put(plan.shop, product);
    s.bind(r.id, "990910000922", "990910000922");
    const dest = join(root, "snap");
    await createRecoverySnapshot(s, dest);
    const checked = await verifyRecoverySnapshot(dest);
    assert.equal(checked.products, 1);
    assert.equal(checked.remoteBindings, 1);
    await writeFile(join(dest, "state.sqlite"), "corrupt");
    await assert.rejects(verifyRecoverySnapshot(dest), /校验/);
  } finally {
    s.close();
    await rm(root, { recursive: true, force: true });
  }
});
test("snapshot refuses to overwrite an existing recovery point", async () => {
  const root = await mkdtemp(join(tmpdir(), "hezi-recovery-"));
  const s = new Store(join(root, "state.sqlite"));
  try {
    const dest = join(root, "snap");
    await createRecoverySnapshot(s, dest);
    await assert.rejects(createRecoverySnapshot(s, dest));
  } finally {
    s.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("snapshot preserves Android media checkpoints and files before a product capture finishes", async () => {
  const { createHash } = await import("node:crypto");
  const { readFile } = await import("node:fs/promises");
  const root = await mkdtemp(join(tmpdir(), "hezi-phone-recovery-"));
  const s = new Store(join(root, "state.sqlite"));
  try {
    const path = join(root, "original.jpg"),
      content = Buffer.from("original app export");
    await writeFile(path, content);
    const cp = {
      version: 1,
      sku: "123",
      variant: "500mL 2瓶",
      main: [
        { path, sha256: createHash("sha256").update(content).digest("hex") },
      ],
      detail: [],
      complete: false,
    };
    s.setMeta("android-capture:shop:123", cp);
    const dest = join(root, "snap");
    const result = await createRecoverySnapshot(s, dest);
    assert.equal(result.products, 0);
    assert.equal(result.files, 1);
    const manifest = JSON.parse(
      await readFile(join(dest, "manifest.json"), "utf8"),
    );
    assert.deepEqual(
      await readFile(join(dest, manifest.files[0].path)),
      content,
    );
    const restored = new Store(join(dest, "state.sqlite"));
    try {
      assert.deepEqual(restored.meta("android-capture:shop:123"), cp);
    } finally {
      restored.close();
    }
  } finally {
    s.close();
    await rm(root, { recursive: true, force: true });
  }
});
