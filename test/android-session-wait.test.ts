import test from "node:test";
import assert from "node:assert/strict";
import { AndroidSession } from "../src/android-session.js";
import { androidProductMainReady } from "../src/android.js";
import { PipelineError } from "../src/model.js";

test("fast hierarchy observations wait for loaded content instead of accepting the selected tab", async () => {
  const session = new AndroidSession("unused", "unused");
  let observations = 0;
  session.dump = async () =>
    ++observations < 5 ? "tab-selected-content-loading" : "exact-sku-content";
  assert.equal(
    await session.wait("details", (x) => x === "exact-sku-content"),
    "exact-sku-content",
  );
  assert.equal(observations, 5);
});
test("unready content has a bounded observation count", async () => {
  const session = new AndroidSession("unused", "unused");
  let observations = 0;
  session.dump = async () => {
    observations++;
    return "loading";
  };
  await assert.rejects(
    session.wait("details", () => false),
    /手机页面未就绪/,
  );
  assert.equal(observations, 10);
});
test("risk gate interrupts observation without further polling", async () => {
  const session = new AndroidSession("unused", "unused");
  let observations = 0;
  session.dump = async () => {
    observations++;
    throw new PipelineError("RATE_LIMITED", "risk");
  };
  await assert.rejects(
    session.wait("details", () => false, {
      timeoutMs: 15000,
      maxObservations: 30,
    }),
    /risk/,
  );
  assert.equal(observations, 1);
});

test("post-navigation loading waits for a complete product shell without treating its caption as SKU proof", async () => {
  const loading = `<hierarchy><node content-desc="已选中款式 旧商品" /></hierarchy>`;
  const loaded = `<hierarchy>
    <node content-desc="已选中款式 任意当前规格" />
    <node content-desc="共7款" />
  </hierarchy>`;
  assert.equal(androidProductMainReady("<hierarchy/>"), false);
  assert.equal(androidProductMainReady(loading), false);
  assert.equal(androidProductMainReady(loaded), true);

  const session = new AndroidSession("unused", "unused");
  let observations = 0;
  session.dump = async () => (++observations < 4 ? loading : loaded);
  assert.equal(
    await session.wait("main", androidProductMainReady, {
      timeoutMs: 15000,
      maxObservations: 30,
    }),
    loaded,
  );
  assert.equal(observations, 4);
});

test("extended loading observation remains bounded", async () => {
  const session = new AndroidSession("unused", "unused");
  let observations = 0;
  session.dump = async () => {
    observations++;
    return "<hierarchy/>";
  };
  await assert.rejects(
    session.wait("main", androidProductMainReady, {
      timeoutMs: 15000,
      maxObservations: 30,
    }),
    /手机页面未就绪：main/,
  );
  assert.equal(observations, 30);
});
