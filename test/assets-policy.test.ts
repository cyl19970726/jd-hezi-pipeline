import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { example } from "../src/demo.js";
import { downloadAssets, type AssetDownloadMetric } from "../src/assets.js";

test("network gate covers fetch and complete body consumption, then reports bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "hezi-asset-policy-"));
  const originalFetch = globalThis.fetch;
  const bytes = await sharp({
    create: { width: 120, height: 120, channels: 3, background: "#1255aa" },
  })
    .png()
    .toBuffer();
  let gateOpen = false,
    fetches = 0;
  const metrics: AssetDownloadMetric[] = [];
  try {
    globalThis.fetch = (async () => {
      assert.equal(gateOpen, true);
      fetches++;
      return new Response(
        new ReadableStream({
          pull(controller) {
            assert.equal(gateOpen, true);
            controller.enqueue(bytes);
            controller.close();
          },
        }),
        { headers: { "content-type": "image/png" } },
      );
    }) as typeof fetch;
    const product = {
      ...example().product,
      assets: [
        {
          role: "detail" as const,
          url: "https://img.360buyimg.com/policy.png",
          order: 0,
        },
      ],
    };
    const policy = {
      async runNetwork<T>(_context: unknown, operation: () => Promise<T>) {
        assert.equal(gateOpen, false);
        gateOpen = true;
        try {
          return await operation();
        } finally {
          gateOpen = false;
        }
      },
      onMetric(metric: AssetDownloadMetric) {
        metrics.push(metric);
      },
    };
    await downloadAssets(product, root, policy);
    assert.equal(gateOpen, false);
    assert.equal(fetches, 1);
    assert.deepEqual(metrics, [
      {
        kind: "download",
        source: "network",
        bytes: bytes.length,
        sku: product.sku,
        role: "detail",
        order: 0,
        url: product.assets[0].url,
      },
    ]);
    metrics.length = 0;
    await downloadAssets(product, root, policy);
    assert.equal(fetches, 1);
    assert.equal(metrics[0]?.kind, "cache-hit");
    assert.equal(metrics[0]?.source, "url-cache");
    assert.equal(metrics[0]?.bytes, 0);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
  }
});

test("network failures leave the caller gate and emit no successful metric", async () => {
  const root = await mkdtemp(join(tmpdir(), "hezi-asset-policy-fail-"));
  const originalFetch = globalThis.fetch;
  let gateOpen = false,
    metrics = 0;
  try {
    globalThis.fetch = (async () =>
      new Response("no", { status: 503 })) as typeof fetch;
    const product = {
      ...example().product,
      assets: [
        {
          role: "main" as const,
          url: "https://img.360buyimg.com/fail.png",
          order: 0,
        },
      ],
    };
    await assert.rejects(
      downloadAssets(product, root, {
        async runNetwork<T>(_context, operation: () => Promise<T>) {
          gateOpen = true;
          try {
            return await operation();
          } finally {
            gateOpen = false;
          }
        },
        onMetric() {
          metrics++;
        },
      }),
      /HTTP 503/,
    );
    assert.equal(gateOpen, false);
    assert.equal(metrics, 0);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
  }
});
