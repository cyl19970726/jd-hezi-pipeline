import { request } from "node:http";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  currentAuditStatus,
  resumeVerifiedPageRequests,
  serve,
} from "../src/server.js";

test("page-request recovery checks HZ before clearing only known page reasons", async () => {
  const calls: { action: string; args: any }[] = [];
  const bridge = {
    call: async (action: string, args: any) => {
      calls.push({ action, args });
      return { ok: true };
    },
  };
  const config = { shop: "test" } as any;
  await resumeVerifiedPageRequests(bridge, config);
  assert.deepEqual(calls, [
    { action: "check-hz", args: { config } },
    {
      action: "resume-requests",
      args: { config, reasonIds: ["http-403", "auth-redirect"] },
    },
  ]);
});

test("failed HZ verification leaves page-request pauses untouched", async () => {
  const calls: string[] = [];
  const bridge = {
    call: async (action: string) => {
      calls.push(action);
      throw Error("仍在验证页");
    },
  };
  await assert.rejects(
    resumeVerifiedPageRequests(bridge, { shop: "test" } as any),
    /验证页/,
  );
  assert.deepEqual(calls, ["check-hz"]);
});

test("fresh matching audit status overlays the workbench state", () => {
  const updatedAt = "2026-09-11T10:00:00.000Z";
  assert.deepEqual(
    currentAuditStatus("42", updatedAt, {
      checkedAt: "2026-09-11T10:00:00.000Z",
      observation: { itemId: "42", status: "上架" },
    }),
    { status: "上架", checkedAt: "2026-09-11T10:00:00.000Z" },
  );
});

test("stale, foreign, or malformed audits cannot overlay workbench state", () => {
  const updatedAt = "2026-09-11T10:00:00.000Z";
  for (const audit of [
    {
      checkedAt: "2026-09-11T09:59:59.999Z",
      observation: { itemId: "42", status: "上架" },
    },
    {
      checkedAt: "2026-09-11T10:00:01.000Z",
      observation: { itemId: "other", status: "上架" },
    },
    {
      checkedAt: "not-a-date",
      observation: { itemId: "42", status: "上架" },
    },
    {
      checkedAt: "2026-09-11T10:00:01.000Z",
      observation: { itemId: "42", status: "" },
    },
  ])
    assert.equal(currentAuditStatus("42", updatedAt, audit), null);
});

test("local workbench accepts a durable batch but rejects foreign origins and missing token", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hezi-web-"));
  await writeFile(
    join(dir, "config.json"),
    JSON.stringify({
      shop: "test",
      session: { spaceId: 3, hzPage: "p2", jdPage: "p1" },
      listUrl: "https://example.com",
      maxPages: 1,
    }),
  );
  const app = await serve(dir, 0);
  try {
    const health = await fetch(app.url + "/api/health").then((r) => r.json());
    assert.equal(health.ready, true);
    assert.match(health.releaseId, /^[a-f0-9]{64}$/);
    const state = await fetch(app.url + "/api/state").then((r) => r.json());
    const executionPage = await fetch(app.url + "/opportunity-execution");
    assert.equal(executionPage.status, 200);
    assert.match(await executionPage.text(), /机会执行台/);
    const execution = await fetch(app.url + "/api/opportunity-execution").then(
      (r) => r.json(),
    );
    assert.equal(execution.summary.total, 0);
    const post = (
      path: string,
      data: unknown,
      headers: Record<string, string> = {},
    ) =>
      fetch(app.url + path, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(data),
      });
    assert.equal((await post("/api/pause", {})).status, 403);
    assert.equal(
      (
        await post("/api/opportunity-execution/prepare", {
          rowIds: ["unverified"],
        })
      ).status,
      403,
    );
    for (const action of ["source", "hydrate", "recheck"]) {
      assert.equal(
        (
          await post("/api/opportunity-execution/" + action, {
            cohortId: "unknown",
          })
        ).status,
        403,
      );
    }
    const headers = { "X-Hezi-Token": state.token };
    assert.equal((await post("/api/pause", {}, headers)).status, 200);
    assert.equal(
      (
        await post(
          "/api/resume",
          {},
          { ...headers, Origin: "https://evil.test" },
        )
      ).status,
      403,
    );
    const batch = {
      links: ["123", "https://item.jd.com/123.html"],
      recipe: {
        brandId: "b",
        categoryId: "c",
        policyId: "p",
        unit: "件",
        through: "submit",
      },
    };
    const first = await post("/api/batches", batch, headers).then((r) =>
      r.json(),
    );
    assert.equal(first.items.length, 1);
    const second = await post("/api/batches", batch, headers).then((r) =>
      r.json(),
    );
    assert.equal(second.items[0].id, first.items[0].id);
    assert.equal(second.items[0].reused, true);
    const checked = await post(
      "/api/preflight",
      { jobIds: [first.items[0].id] },
      headers,
    ).then((r) => r.json());
    assert.equal(checked.checked, 1);
    assert.equal(checked.ready, false);
    assert.equal(checked.platform.length, 0);
    assert.ok(
      checked.items[0].issues.some((x: any) => x.code === "COLLECT_REQUIRED"),
    );
    const retained = await fetch(app.url + "/api/state").then((r) => r.json());
    assert.equal(retained.preflight.items[0].jobId, first.items[0].id);
    const listed = retained.jobs.find(
      (job: any) => job.id === first.items[0].id,
    );
    assert.equal(listed.priceComparison.jd, null);
    assert.equal(listed.priceComparison.competitor, null);
    assert.equal(listed.priceComparison.listing, null);
    const detail = await fetch(app.url + "/api/jobs/" + first.items[0].id).then(
      (r) => r.json(),
    );
    assert.deepEqual(detail.priceComparison, listed.priceComparison);

    assert.equal(
      await new Promise<number | undefined>((ok, reject) => {
        const req = request(
          app.url,
          { headers: { Host: "evil.test" } },
          (res) => {
            res.resume();
            ok(res.statusCode);
          },
        );
        req.on("error", reject);
        req.end();
      }),
      403,
    );
  } finally {
    await app.stop();
    await rm(dir, { recursive: true, force: true });
  }
});
