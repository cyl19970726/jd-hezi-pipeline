import test from "node:test";
import assert from "node:assert/strict";
import { parseHTML } from "linkedom";
import { markRejectionSpec } from "../src/browser/rejection-fields.js";
function dom(html: string) {
  Object.assign(globalThis, {
    document: parseHTML("<html><body>" + html + "</body></html>").document,
  });
}
const row = '<tr><td>规格</td><td><input value="金色30cm"></td></tr>';
test("marks only existing exact spec preserving other controls", () => {
  dom(
    '<div class="ant-tabs-tabpane-active"><table>' +
      row +
      '<tr><td>型号</td><td><input value="C123"></td></tr></table></div>',
  );
  assert.equal(markRejectionSpec("金色30cm"), '[data-hezi-repair-spec="true"]');
  assert.equal(document.querySelectorAll("[data-hezi-repair-spec]").length, 1);
  assert.equal(
    (document.querySelector("[data-hezi-repair-spec]") as HTMLInputElement)
      .value,
    "金色30cm",
  );
});
test("refuses duplicate labels or changed prior values", () => {
  dom(
    '<div class="ant-tabs-tabpane-active"><table>' +
      row +
      row +
      "</table></div>",
  );
  assert.throws(() => markRejectionSpec("金色30cm"), /不唯一/);
  dom('<div class="ant-tabs-tabpane-active"><table>' + row + "</table></div>");
  assert.throws(() => markRejectionSpec("其他"), /已变化/);
});

test("repair content ignores observation time but retains logistics changes", async () => {
  const { rejectionContent } =
    await import("../src/browser/rejection-fields.js");
  const { digest } = await import("../src/model.js");
  const a = {
    fields: { price: "59" },
    specs: { 规格: "一个装" },
    mainImages: [],
    detailImages: [],
    logistics: {
      checkedAt: "2026-09-17T07:00:00Z",
      areas: [{ areaId: "1101" }],
    },
  } as any;
  const b = structuredClone(a);
  b.logistics.checkedAt = "2026-09-17T07:01:00Z";
  assert.equal(digest(rejectionContent(a)), digest(rejectionContent(b)));
  b.logistics.areas[0].areaId = "1201";
  assert.notEqual(digest(rejectionContent(a)), digest(rejectionContent(b)));
});
