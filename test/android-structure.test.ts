import test from "node:test";
import assert from "node:assert/strict";
import { detailImageNodes, priceFromOffer } from "../src/android-structure.js";
test("detail assets are scoped to introduction, preserving even offscreen image order", () => {
  const xml =
    '<node><node class="android.widget.TextView"/><node resource-id="IntroductionModule"><node resource-id="scale-wei2-wd"><node><node index="0" class="android.widget.TextView" bounds="[0,0][0,0]"/><node index="1" class="android.widget.TextView" bounds="[0,400][1080,1200]"/></node></node></node><node text="店内优选"><node class="android.widget.TextView"/></node></node>';
  assert.deepEqual(
    detailImageNodes(xml).map((n) => n.index),
    ["0", "1"],
  );
  assert.throws(() => detailImageNodes("<node/>"), /未识别/);
});
test("offer OCR binds JD price to its nearby label, rejects bare prices and promotions", () => {
  const line = (text: string, x: number, y: number, width = 0.15) => ({
    text,
    x,
    y,
    width,
    height: 0.02,
    confidence: 0.99,
  });
  const lines = [
    line("优惠", 0.4, 0.2),
    line("PLUS到手价", 0.5, 0.3),
    line("¥31.16", 0.3, 0.3),
    line("= ¥34.9", 0.28, 0.45, 0.18),
    line("京东价", 0.33, 0.48),
    line("促销¥3.74", 0.55, 0.45),
  ];
  assert.deepEqual(priceFromOffer(lines), {
    value: "34.9",
    basis: "jd-price",
    label: "京东价",
  });
  assert.equal(priceFromOffer(lines.filter((l) => l.text !== "京东价")), null);
  assert.equal(priceFromOffer([...lines, line("¥30", 0.32, 0.45)]), null);
});

test("offer OCR prefers a unique daily or JD price and does not recover subsidy after a regular conflict", () => {
  const line = (text: string, x: number, y: number) => ({
    text,
    x,
    y,
    width: 0.15,
    height: 0.02,
    confidence: 0.99,
  });
  const context = [line("优惠", 0.4, 0.2), line("到手价", 0.5, 0.3)];
  const subsidy = [line("= ¥29.9", 0.28, 0.55), line("补贴价", 0.33, 0.58)];
  assert.deepEqual(
    priceFromOffer([
      ...context,
      line("= ¥34.9", 0.28, 0.45),
      line("日常价", 0.33, 0.48),
      ...subsidy,
    ]),
    { value: "34.9", basis: "jd-price", label: "日常价" },
  );
  assert.deepEqual(priceFromOffer([...context, ...subsidy]), {
    value: "29.9",
    basis: "subsidy",
    label: "补贴价",
  });
  assert.equal(
    priceFromOffer([...context, line("日常价", 0.33, 0.48), ...subsidy]),
    null,
  );
  assert.equal(
    priceFromOffer([
      ...context,
      line("= ¥34.9", 0.28, 0.45),
      line("京东价", 0.33, 0.48),
      line("= ¥35.9", 0.58, 0.45),
      line("日常价", 0.63, 0.48),
      ...subsidy,
    ]),
    null,
  );
  assert.deepEqual(
    priceFromOffer([
      ...context,
      line("= ¥59", 0.28, 0.45),
      line("日常价", 0.33, 0.48),
      line("= ¥59.00", 0.58, 0.45),
      line("京东价", 0.63, 0.48),
    ]),
    { value: "59", basis: "jd-price", label: "日常价" },
  );
});

test("JD album duplicate filenames are valid, foreign paths and malformed records are rejected", async () => {
  const { parseAlbumEntries } = await import("../src/android-session.js");
  const rows = parseAlbumEntries(
    "/sdcard/Pictures/JDImage/abc (1).jpg|1789026585|339222\n",
  );
  assert.equal(
    rows.get("/sdcard/Pictures/JDImage/abc (1).jpg"),
    "1789026585|339222",
  );
  assert.throws(
    () => parseAlbumEntries("/sdcard/DCIM/other.jpg|1789026585|339222"),
    /异常/,
  );
  assert.throws(
    () =>
      parseAlbumEntries(
        "/sdcard/Pictures/JDImage/../other.jpg|1789026585|339222",
      ),
    /异常/,
  );
});

test("known variant selection excludes other sections and refuses ambiguous captions", async () => {
  const { variantOption } = await import("../src/android-navigation.js");
  const xml =
    '<node text="500mL 2瓶 茉莉"/><node text="规格(7)"/><node text="500mL 2瓶 茉莉杀虫剂" bounds="[0,500][500,600]"/>';
  assert.equal(
    variantOption(xml, "500mL 2瓶 茉莉")?.text,
    "500mL 2瓶 茉莉杀虫剂",
  );
  assert.equal(
    variantOption(
      xml + '<node text="500mL 2瓶 茉莉其他商品"/>',
      "500mL 2瓶 茉莉",
    ),
    null,
  );
});

test("offer title icon OCR noise does not discard a clearly labelled JD price", () => {
  const line = (text: string, x: number, y: number, confidence = 1) => ({
    text,
    x,
    y,
    width: 0.15,
    height: 0.02,
    confidence,
  });
  const rows = [
    line("优惠 ①", 0.4, 0.2, 0.3),
    line("已享受优惠", 0.1, 0.25),
    line("可再享优惠", 0.4, 0.25),
    line("PLUS到手价", 0.5, 0.3, 0.5),
    line("¥34.9", 0.3, 0.45, 0.5),
    line("京东价", 0.32, 0.48),
  ];
  assert.deepEqual(priceFromOffer(rows), {
    value: "34.9",
    basis: "jd-price",
    label: "京东价",
  });
});

test("image scent facts must explicitly match the selected sales variant", async () => {
  const { scentFromImage } = await import("../src/android-image-facts.js");
  assert.equal(scentFromImage("500mL 2瓶 茉莉", ["清新茉莉香"]), "茉莉香");
  assert.equal(scentFromImage("500mL 2瓶 薄荷", ["清新茉莉香"]), null);
  assert.equal(scentFromImage("500mL 2瓶 茉莉", ["香味清新"]), null);
});

test("observed jasmine original heading supplies its exact scent", async () => {
  const { scentFromImage } = await import("../src/android-image-facts.js");
  assert.equal(scentFromImage("500mL 2瓶 茉莉", ["茉莉花香"]), "茉莉花香");
});
