import { JD_CAPTURE_PARSER } from "../src/jd-capture.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { archiveJdBusinessObservation } from "../src/browser/jd-observation-archive.js";

test("archives an identity-bound raw business observation beside the source database", async () => {
  const root = await mkdtemp(join(tmpdir(), "hezi-jd-observation-"));
  try {
    const database = join(root, "state.sqlite");
    const observedAt = "2026-09-11T12:34:56.789Z";
    const response = {
      wareInfoReadMap: { product_id: "5773954", weight: "0.62" },
      productAttributeVO: {
        attributes: [{ labelName: "包装", labelValue: "1瓶" }],
      },
    };
    const path = await archiveJdBusinessObservation({
      sourceDatabasePath: database,
      shop: "示例店铺",
      sku: "5773954",
      sourceUrl: "https://item.jd.com/5773954.html",
      response,
      observedAt,
    });
    assert.ok(path?.startsWith(resolve(root, "jd-observations") + "/"));
    const saved = JSON.parse(await readFile(path!, "utf8"));
    assert.deepEqual(saved.response, response);
    assert.equal(saved.sku, "5773954");
    assert.equal(saved.sourceUrl, "https://item.jd.com/5773954.html");
    assert.equal(saved.observedAt, observedAt);
    assert.equal(saved.parserVersion, JD_CAPTURE_PARSER);
    assert.match(saved.shopScope, /^[a-f0-9]{20}$/);
    assert.equal((await stat(path!)).mode & 0o777, 0o600);
    assert.equal((await stat(resolve(path!, ".."))).mode & 0o777, 0o700);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects mismatched response or URL identity without creating an archive", async () => {
  const root = await mkdtemp(join(tmpdir(), "hezi-jd-observation-"));
  const base = {
    sourceDatabasePath: join(root, "state.sqlite"),
    shop: "示例店铺",
    sku: "5773954",
    sourceUrl: "https://item.jd.com/5773954.html",
    response: { wareInfoReadMap: { product_id: "5773954" } },
  };
  try {
    await assert.rejects(
      archiveJdBusinessObservation({
        ...base,
        sourceUrl: "https://item.jd.com/123.html",
      }),
      /URL与SKU不符/,
    );
    await assert.rejects(
      archiveJdBusinessObservation({
        ...base,
        response: { wareInfoReadMap: { product_id: "123" } },
      }),
      /响应SKU不符/,
    );
    await assert.rejects(readdir(join(root, "jd-observations")), {
      code: "ENOENT",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("demo collection without a source database explicitly skips archival", async () => {
  assert.equal(
    await archiveJdBusinessObservation({
      shop: "demo",
      sku: "5773954",
      sourceUrl: "https://item.jd.com/5773954.html",
      response: { wareInfoReadMap: { product_id: "5773954" } },
    }),
    null,
  );
});
