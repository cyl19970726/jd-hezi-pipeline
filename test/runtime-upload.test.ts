import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyUploadedMedia,
  locateSingleAddedMedia,
  MEDIA_UPLOAD_MAX_ATTEMPTS,
  mediaUploadFailureDetails,
} from "../src/browser/runtime.js";

const image = (src: string, complete = true, naturalWidth = 800) => ({
  src,
  complete,
  naturalWidth,
});

test("uploaded media accepts only the complete expected HTTP image sequence", () => {
  assert.equal(
    classifyUploadedMedia(
      [image("https://cdn.example/1.jpg"), image("https://cdn.example/2.jpg")],
      2,
    ),
    "ready",
  );
  assert.equal(
    classifyUploadedMedia([image("https://cdn.example/1.jpg")], 2),
    "pending",
  );
  assert.equal(
    classifyUploadedMedia([image("https://cdn.example/1.jpg", false, 0)], 1),
    "pending",
  );
});

test("uploaded media rejects the observed undefined placeholder immediately", () => {
  assert.equal(
    classifyUploadedMedia(
      [image("https://b.csgmall.com.cn/shop-view/undefined", true, 0)],
      1,
    ),
    "invalid",
  );
});

test("uploaded media rejects non-HTTP and completed broken images", () => {
  for (const broken of [
    image("undefined", true, 0),
    image("data:image/png;base64,abc"),
    image("https://cdn.example/broken.jpg", true, 0),
  ])
    assert.equal(classifyUploadedMedia([broken], 1), "invalid");
});

test("retry cleanup locates only the newly added occurrence", () => {
  const duplicate = "https://cdn.example/same.jpg";
  assert.equal(
    locateSingleAddedMedia(
      [duplicate, "https://cdn.example/kept.jpg"],
      [
        image(duplicate),
        image("https://cdn.example/undefined", true, 0),
        image("https://cdn.example/kept.jpg"),
      ],
    ),
    1,
  );
  assert.equal(
    locateSingleAddedMedia([duplicate], [image(duplicate), image(duplicate)]),
    1,
  );
  assert.equal(locateSingleAddedMedia([], [image("a"), image("b")]), null);
});

test("pre-save upload failure carries stable not-applied identity", () => {
  assert.equal(MEDIA_UPLOAD_MAX_ATTEMPTS, 2);
  assert.deepEqual(
    mediaUploadFailureDetails("sku-1", "shop-1", { attempt: 2 }),
    {
      phase: "media-upload",
      saveDispatched: false,
      sku: "sku-1",
      shop: "shop-1",
      attempt: 2,
    },
  );
});
