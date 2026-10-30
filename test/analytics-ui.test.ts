import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parseHTML } from "linkedom";

const web = new URL("../web/", import.meta.url);

test("analytics workbench uses external assets and exposes every business view", async () => {
  const html = await readFile(new URL("analytics.html", web), "utf8");
  const { document } = parseHTML(html);

  assert.equal(document.querySelectorAll("script:not([src])").length, 0);
  assert.equal(
    document.querySelector('script[src="/analytics.js"]')?.getAttribute("type"),
    "module",
  );
  assert.ok(document.querySelector('link[href="/analytics.css"]'));
  assert.ok(document.querySelector('a[href="/api/analytics/orders/template"]'));
  assert.ok(document.querySelector("#transfer-opportunities"));
  assert.ok(document.querySelector("#clear-opportunity-selection"));
  assert.equal(
    document.querySelector("#market-source-field select")?.getAttribute("name"),
    "source",
  );

  const views = [
    "overview",
    "market",
    "opportunities",
    "brands",
    "orders",
    "batches",
    "health",
  ];
  assert.deepEqual(
    [...document.querySelectorAll("[data-view]")].map((node) =>
      node.getAttribute("data-view"),
    ),
    views,
  );
  for (const view of views) assert.ok(document.querySelector(`#view-${view}`));
});

test("analytics client keeps mutations same-origin and token guarded", async () => {
  const script = await readFile(new URL("analytics.js", web), "utf8");
  assert.match(script, /X-Hezi-Token/);
  assert.doesNotMatch(script, /https?:\/\//);
  assert.match(script, /textContent/);
  assert.match(script, /acceptedForTarget/);
  assert.match(script, /valueIndexMinor/);
  assert.match(script, /reconciliationId/);
  assert.match(script, /targetCents/);
  assert.match(script, /expectedRevision/);
  assert.match(script, /candidateId: item\.id/);
  assert.match(script, /result\.observations/);
  assert.match(script, /opportunities\/transfer/);
  assert.match(script, /evidenceSnapshot/);
  assert.match(script, /CONFLICT: "待对账"/);
  assert.match(script, /"needs-review": "待核验"/);
  assert.doesNotMatch(script, /name="notes"/);
});
