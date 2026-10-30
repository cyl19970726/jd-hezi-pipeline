import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.js";
import { JdTraffic } from "../src/jd-traffic.js";
import { discoverSource } from "../src/browser/discovery-runner.js";

test("shared JD pause stops discovery even before a same-page observation", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hezi-discovery-pause-")),
    path = join(dir, "state.sqlite");
  const s = new Store(path);
  try {
    new JdTraffic(s, "shop", undefined, "android").pauseAccount(
      "RATE_LIMITED",
      "verification",
    );
    let accessed = false;
    const page = new Proxy(
      {},
      {
        get() {
          accessed = true;
          throw Error("browser must not be accessed");
        },
      },
    );
    await assert.rejects(
      discoverSource(
        page,
        { shop: "shop" } as any,
        { database: path, runId: "unused" },
        async () => {
          accessed = true;
        },
      ),
      /暂停/,
    );
    assert.equal(accessed, false);
    const release = s.lock("publisher");
    release();
  } finally {
    s.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
