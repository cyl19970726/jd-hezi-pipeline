export type SubmissionDialogAction =
  "apply-current-product-name" | "confirm-submit";

export type SubmissionDialogObservation =
  | { kind: "completed"; evidence: string }
  | { kind: "dialog"; text: string }
  | { kind: "pending"; evidence: string };

export type SubmissionDialogDriver = {
  observe(): Promise<SubmissionDialogObservation>;
  click(
    action: SubmissionDialogAction,
    observation: Extract<SubmissionDialogObservation, { kind: "dialog" }>,
  ): Promise<void>;
  waitChange(previous: SubmissionDialogObservation): Promise<void>;
};

function actionFor(text: string): SubmissionDialogAction {
  const normalized = text.replace(/\s+/gu, "");
  const applyName = normalized.includes("应用目前商品命名");
  const confirm = normalized.includes("确认提交");
  if (applyName === confirm)
    throw new Error(`未识别或不唯一的提交弹窗：${text}`);
  return applyName ? "apply-current-product-name" : "confirm-submit";
}

function sameObservation(
  left: SubmissionDialogObservation,
  right: SubmissionDialogObservation,
) {
  if (left.kind !== right.kind) return false;
  if (left.kind === "dialog" && right.kind === "dialog")
    return left.text.replace(/\s+/gu, "") === right.text.replace(/\s+/gu, "");
  if (left.kind === "completed" && right.kind === "completed")
    return left.evidence === right.evidence;
  if (left.kind === "pending" && right.kind === "pending")
    return left.evidence === right.evidence;
  return false;
}

/**
 * Handles only the two submission dialogs observed on the platform. Completion
 * must be positively observed; exhausting the bounded loop is never success.
 */
export async function completeSubmissionDialogs(
  driver: SubmissionDialogDriver,
  maxSteps = 4,
): Promise<Extract<SubmissionDialogObservation, { kind: "completed" }>> {
  if (!Number.isInteger(maxSteps) || maxSteps < 1)
    throw new Error("提交弹窗最大步数必须是正整数");

  let observation = await driver.observe();
  for (let step = 0; step < maxSteps; step++) {
    if (observation.kind === "completed") return observation;
    if (observation.kind !== "dialog")
      throw new Error(`提交状态未确认：${observation.evidence}`);

    const action = actionFor(observation.text);
    await driver.click(action, observation);
    await driver.waitChange(observation);
    const next = await driver.observe();
    if (sameObservation(observation, next))
      throw new Error(`点击后提交弹窗未变化：${observation.text}`);
    observation = next;
  }
  if (observation.kind === "completed") return observation;
  throw new Error("提交弹窗处理超过有界步数，未观察到完成状态");
}
