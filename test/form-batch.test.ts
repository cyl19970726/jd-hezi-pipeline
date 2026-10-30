import { test } from "node:test";
import assert from "node:assert/strict";
import { parseHTML } from "linkedom";
import { formBatch } from "../src/browser/form-batch.js";
function dom(html: string) {
  const { window } = parseHTML(html);
  Object.assign(globalThis, {
    document: window.document,
    HTMLInputElement: window.HTMLInputElement,
    HTMLTextAreaElement: window.HTMLTextAreaElement,
    Event: window.Event,
    FocusEvent: window.Event,
  });
  window.HTMLElement.prototype.getBoundingClientRect = () => ({
    width: 100,
    height: 20,
    top: 0,
    left: 0,
    bottom: 20,
    right: 100,
    x: 0,
    y: 0,
    toJSON() {},
  });
  return window.document;
}
test("batch updates multiple form inputs with native events and reads them back", async () => {
  const d = dom(
    '<div class="ant-form-item"><label>商品名称</label><input value="old"></div><div class="ant-form-item"><label>产地</label><input value="old"></div>',
  );
  let events = 0;
  d.addEventListener("input", () => events++);
  assert.deepEqual(await formBatch({ values: { title: "new", origin: "" } }), {
    title: "new",
    origin: "",
  });
  assert.equal(events, 2);
});
test("ambiguous field fails before writing any earlier field", async () => {
  const d = dom(
    '<div class="ant-form-item"><label>商品名称</label><input value="old"></div><div class="ant-form-item"><label>产地</label><input><input></div>',
  );
  await assert.rejects(
    formBatch({ values: { title: "new", origin: "value" } }),
  );
  assert.equal(d.querySelector("input")!.value, "old");
});
test("number formatting by the platform preserves weight meaning", async () => {
  const d = dom(
    '<div class="ant-form-item"><label>商品重量</label><input value="1"></div>',
  );
  d.addEventListener("input", () => {
    const e = d.querySelector("input")!;
    e.value = Number(e.value).toFixed(3);
  });
  const actual = await formBatch({ values: { weight: "0.02" } });
  assert.equal(actual.weight, "0.020");
});
test("disabled title rejects the entire batch before any input event", async () => {
  const d = dom(
    '<div class="ant-form-item"><label>商品名称</label><input value="automatic"></div><div class="ant-form-item"><label>产地</label><input value="old"></div>',
  );
  Object.defineProperty(d.querySelector("input")!, "disabled", { value: true });
  let inputs = 0;
  d.addEventListener("input", () => inputs++);
  await assert.rejects(
    formBatch({ values: { origin: "changed", title: "custom" } }),
    /Field rejects value: title/,
  );
  assert.equal(inputs, 0);
  assert.equal(d.querySelectorAll("input")[1].value, "old");
});
