import test from "node:test";
import assert from "node:assert/strict";
import { remoteProductState } from "../src/remote-status.js";

test("remote status mapping recognizes explicit rejection and never guesses unknown states", () => {
  assert.equal(remoteProductState("审核不通过"), "REJECTED");
  assert.equal(remoteProductState("已驳回"), "REJECTED");
  assert.equal(remoteProductState("待审核"), "SUBMITTED");
  assert.equal(remoteProductState("审核通过"), "APPROVED");
  assert.equal(remoteProductState("在售"), "ON_SALE");
  assert.equal(remoteProductState("新的未知状态"), null);
});
