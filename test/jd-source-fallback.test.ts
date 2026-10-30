import test from "node:test";
import assert from "node:assert/strict";
import { PipelineError } from "../src/model.js";
import { unsupportedMediaFallback } from "../src/jd-source-fallback.js";
import {
  bindCanonicalBrowserSource,
  canonicalSourceBinding,
} from "../src/jd-source-fallback.js";

const details = {
  reason: "discovery-story",
  stage: "main-gallery",
  sku: "5773954",
  variant: "红色 1件",
  parserVersion: "jd-product-v1",
  observedAt: new Date().toISOString(),
};

test("fallback accepts only the exact structured media capability outcome", () => {
  assert.deepEqual(
    unsupportedMediaFallback(
      new PipelineError("UNSUPPORTED_MEDIA", "unsupported", details),
      { sku: "5773954", parserVersion: "jd-product-v1" },
    ),
    details,
  );
  for (const error of [
    new PipelineError("AUTH_REQUIRED", "auth", details),
    new PipelineError("RATE_LIMITED", "rate", details),
    new PipelineError("PAUSED", "paused", details),
    new PipelineError("UNSUPPORTED_MEDIA", "wrong sku", {
      ...details,
      sku: "900000000006",
    }),
    new PipelineError("UNSUPPORTED_MEDIA", "wrong stage", {
      ...details,
      stage: "detail-gallery",
    }),
    new PipelineError("UNSUPPORTED_MEDIA", "missing variant", {
      ...details,
      variant: "",
    }),
  ])
    assert.equal(
      unsupportedMediaFallback(error, {
        sku: "5773954",
        parserVersion: "jd-product-v1",
      }),
      null,
    );
});

test("canonical browser provenance is bound to the exact saved product hash and URL", () => {
  const product = {
    sku: "5773954",
    url: "https://item.jd.com/5773954.html",
    dataHash: "hash-a",
  };
  const binding = bindCanonicalBrowserSource(product);
  assert.deepEqual(canonicalSourceBinding(binding, product), binding);
  assert.equal(
    canonicalSourceBinding(binding, { ...product, dataHash: "hash-b" }),
    null,
  );
  assert.equal(
    canonicalSourceBinding(binding, {
      ...product,
      url: "https://item.jd.com/900000000006.html",
    }),
    null,
  );
});
