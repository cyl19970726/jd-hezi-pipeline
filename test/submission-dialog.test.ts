import test from "node:test";
import assert from "node:assert/strict";
import {
  completeSubmissionDialogs,
  type SubmissionDialogAction,
  type SubmissionDialogObservation,
} from "../src/browser/submission-dialog.js";

function driver(states: SubmissionDialogObservation[]) {
  let index = 0;
  const clicks: SubmissionDialogAction[] = [];
  return {
    clicks,
    driver: {
      async observe() {
        return states[index];
      },
      async click(action: SubmissionDialogAction) {
        clicks.push(action);
      },
      async waitChange() {
        if (index < states.length - 1) index++;
      },
    },
  };
}

test("handles the two known dialogs and requires observed completion", async () => {
  const scenario = driver([
    { kind: "dialog", text: "是否 应用目前商品命名？" },
    { kind: "dialog", text: "确认提交该商品" },
    { kind: "completed", evidence: "status=待审核" },
  ]);
  const result = await completeSubmissionDialogs(scenario.driver);
  assert.equal(result.evidence, "status=待审核");
  assert.deepEqual(scenario.clicks, [
    "apply-current-product-name",
    "confirm-submit",
  ]);
});

test("rejects an unknown or ambiguous dialog without clicking", async () => {
  for (const text of ["请先阅读新协议", "应用目前商品命名并确认提交"]) {
    const scenario = driver([{ kind: "dialog", text }]);
    await assert.rejects(
      completeSubmissionDialogs(scenario.driver),
      /未识别或不唯一/u,
    );
    assert.deepEqual(scenario.clicks, []);
  }
});

test("rejects a known dialog that does not change after its click", async () => {
  const scenario = driver([{ kind: "dialog", text: "确认提交" }]);
  await assert.rejects(
    completeSubmissionDialogs(scenario.driver),
    /点击后提交弹窗未变化/u,
  );
  assert.deepEqual(scenario.clicks, ["confirm-submit"]);
});

test("bounded known-dialog changes cannot be mistaken for success", async () => {
  const scenario = driver([
    { kind: "dialog", text: "应用目前商品命名" },
    { kind: "dialog", text: "确认提交" },
    { kind: "dialog", text: "应用目前商品命名？" },
  ]);
  await assert.rejects(
    completeSubmissionDialogs(scenario.driver, 2),
    /超过有界步数/u,
  );
  assert.equal(scenario.clicks.length, 2);
});

test("absence of a dialog is not treated as completion", async () => {
  const scenario = driver([{ kind: "pending", evidence: "仍显示待提交" }]);
  await assert.rejects(
    completeSubmissionDialogs(scenario.driver),
    /提交状态未确认/u,
  );
  assert.deepEqual(scenario.clicks, []);
});
