import test from "node:test";
import assert from "node:assert/strict";
import { mainGalleryViewerReady } from "../src/android-gallery.js";

test("dedicated JD main-image viewer requires its root and exact page counter", () => {
  const viewer =
    '<hierarchy><node resource-id="com.jingdong.app.mall:id/euk"><node text="4/8" /></node></hierarchy>';
  assert.equal(mainGalleryViewerReady(viewer, 4, 8), true);
  assert.equal(mainGalleryViewerReady(viewer, 3, 8), false);
});

test("Discovery story page is rejected despite an underlying product and bare counter", () => {
  const story = [
    "<hierarchy>",
    '<node resource-id="com.jd.lib.Discovery.feature:id/cv"><node text="4/8" /></node>',
    '<node resource-id="com.jd.lib.productdetail.feature:id/cc" text="图集1/8" />',
    '<node content-desc="已选中款式 500mL 1瓶" />',
    "</hierarchy>",
  ].join("");
  assert.throws(
    () =>
      mainGalleryViewerReady(story, 4, 8, {
        sku: "5773954",
        variant: "红色 1件",
        parserVersion: "jd-product-v1",
      }),
    (error: any) => {
      assert.equal(error.code, "UNSUPPORTED_MEDIA");
      assert.deepEqual(
        {
          reason: error.details.reason,
          stage: error.details.stage,
          sku: error.details.sku,
          variant: error.details.variant,
          parserVersion: error.details.parserVersion,
        },
        {
          reason: "discovery-story",
          stage: "main-gallery",
          sku: "5773954",
          variant: "红色 1件",
          parserVersion: "jd-product-v1",
        },
      );
      return true;
    },
  );
});

test("Discovery cannot authorize fallback without current SKU and variant proof", () => {
  const story =
    '<hierarchy><node resource-id="com.jd.lib.Discovery.feature:id/cv"><node text="1/4" /></node></hierarchy>';
  assert.throws(
    () => mainGalleryViewerReady(story, 1, 4),
    (error: any) =>
      error.code === "NEEDS_INPUT" && /缺少当前SKU规格证明/.test(error.message),
  );
});

test("a bare matching counter without the dedicated viewer fails closed", () => {
  const ambiguous = '<hierarchy><node text="4/8" /></hierarchy>';
  assert.throws(
    () => mainGalleryViewerReady(ambiguous, 4, 8),
    /无法确认处于京东主图查看器/,
  );
});
