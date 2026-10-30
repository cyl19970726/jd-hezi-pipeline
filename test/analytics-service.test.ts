import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "../src/server.js";
import {
  inferResearchBrand,
  inferResearchCategory,
} from "../src/analytics/research-import.js";

test("research inference never assigns a single shop brand without title evidence", () => {
  assert.equal(inferResearchBrand("无品牌名称的螺丝", ["某品牌"]).brand, null);
  assert.equal(
    inferResearchBrand("维达 卷纸", ["维达(Vinda)"]).brand,
    "维达(Vinda)",
  );
  assert.equal(inferResearchCategory("复印纸"), "办公文具与耗材");
});
test("analytics is same-origin guarded, no fake monthly metrics, durable local decisions and raw evidence", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hezi-analytics-"));
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
    assert.equal((await fetch(app.url + "/analytics")).status, 200);
    const session = await fetch(app.url + "/api/analytics/session").then((r) =>
      r.json(),
    );
    const overview = await fetch(app.url + "/api/analytics/overview").then(
      (r) => r.json(),
    );
    assert.equal(overview.goal.remaining, null);
    assert.equal(overview.orders.orderCount, null);
    const post = (
      path: string,
      data: unknown,
      headers: Record<string, string> = {},
    ) =>
      fetch(app.url + "/api/analytics/" + path, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(data),
      });
    assert.equal((await post("observations/import", {})).status, 403);
    assert.equal(
      (
        await post(
          "observations/import",
          {},
          { "X-Hezi-Token": session.token, Origin: "https://foreign.test" },
        )
      ).status,
      403,
    );
    const input = {
      platform: "hezi",
      shop: "s1",
      itemId: "i1",
      skuId: "sku1",
      title: "测试纸品",
      brand: "测试品牌",
      saleUnit: "提",
      packaging: "六包",
      sourceEntry: "hezi-shop-list-cohort-v1",
      field: "saleCount",
      fieldVersion: "v1",
      semanticsVersion: "cumulative",
      currency: "CNY",
      value: 10,
      priceMinor: 500,
    };
    for (const [id, observedAt, value] of [
      ["start", "2026-09-17T00:00:00Z", 10],
      ["end", "2026-09-19T00:00:00Z", 12],
    ] as const)
      assert.equal(
        (
          await post(
            "observations/import",
            {
              observations: [{ ...input, value }],
              run: {
                id,
                source: "synthetic-test",
                observedAt,
                coverage: "complete",
                expectedCount: 1,
              },
            },
            { "X-Hezi-Token": session.token },
          )
        ).status,
        200,
      );
    const market = await fetch(
      app.url + "/api/analytics/market?mode=recent",
    ).then((r) => r.json());
    assert.equal(market.items[0].delta, 2);
    assert.equal(market.items[0].valueIndexMinor, 1000);
    assert.equal(market.items[0].canPublish, false);
    const monthly = await fetch(
      app.url + "/api/analytics/market?mode=recent&window=30",
    ).then((r) => r.json());
    assert.equal(monthly.items.length, 0);
    const evidence = await fetch(
      app.url +
        "/api/analytics/evidence/" +
        encodeURIComponent(market.items[0].id),
    ).then((r) => r.json());
    assert.equal(evidence.observations.length, 2);
    assert.equal(
      (await fetch(app.url + "/api/analytics/orders/template")).status,
      200,
    );
    const state = await fetch(app.url + "/api/state").then((r) => r.json());
    assert.equal(state.jobs.length, 0);
  } finally {
    await app.stop();
    await rm(dir, { recursive: true, force: true });
  }
});
