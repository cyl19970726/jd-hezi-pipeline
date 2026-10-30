import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EgoBridge } from "../src/browser/bridge.js";
async function executable(body: string, fn: (path: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "hezi-bridge-"));
  try {
    const path = join(dir, "fake-ego");
    await writeFile(path, "#!/usr/bin/env node\n" + body, { mode: 0o700 });
    await fn(path);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
test("bridge accepts receipt even with browser narration before it", () =>
  executable(
    `process.stdin.resume();process.stdin.on('end',()=>console.log('browser narration\\nHEZI_RESULT:'+JSON.stringify({ok:true,result:{authenticated:true}})));`,
    async (p) => {
      assert.deepEqual(await new EgoBridge(p).call("inspect", {}), {
        authenticated: true,
      });
    },
  ));
test("browser user-control stop is actionable instead of automatic retry", () =>
  executable(
    `process.stdin.resume();process.stdin.on('end',()=>console.error('The user now controls this task space.'));`,
    async (p) => {
      await assert.rejects(new EgoBridge(p).call("inspect", {}), {
        code: "CONTROL_REQUIRED",
      });
    },
  ));
test("lost browser receipt times out with uncertain outcome", () =>
  executable(`process.stdin.resume();setInterval(()=>{},1000);`, async (p) => {
    await assert.rejects(new EgoBridge(p, 80).call("save", {}), {
      code: "UNKNOWN_OUTCOME",
    });
  }));

test("current Ego takeover message preserves the user-control hard stop", () =>
  executable(
    `process.stdin.resume();process.stdin.on('end',()=>console.error('The user has taken control of this task space, so browser commands are paused.'));`,
    async (p) => {
      await assert.rejects(new EgoBridge(p).call("inspect", {}), {
        code: "CONTROL_REQUIRED",
      });
    },
  ));

test("Ego may send console receipts on stderr, including large extraction results", () =>
  executable(
    `process.stdin.resume();process.stdin.on('end',()=>console.error('HEZI_RESULT:'+JSON.stringify({ok:true,result:{value:'x'.repeat(8000)}})));`,
    async (p) => {
      assert.equal(
        (await new EgoBridge(p).call("collect", {})).value.length,
        8000,
      );
    },
  ));
