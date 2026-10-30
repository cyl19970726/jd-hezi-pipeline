import { digest, PipelineError } from "./model.js";
import type { Jobs } from "./jobs.js";
import type { Store } from "./store.js";

export type AcceptanceStatus = "incomplete" | "failed" | "passed";

export interface FreezeAcceptanceInput {
  id: string;
  jobIds: string[];
  releaseId: string;
  targetCount: number;
  minCategories: number;
}

type FrozenCandidate = {
  jobId: string;
  sku: string;
  categoryId: string;
  recipeHash: string;
};

const finalStates = new Set(["SUBMITTED", "APPROVED", "ON_SALE"]);
const submitStatuses = new Set([
  "待审核",
  "审核中",
  "已上架",
  "上架",
  "在售",
  "审核通过",
  "SUBMITTED",
  "APPROVED",
  "ON_SALE",
]);

function iso(value: number | string | Date) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime()))
    throw new PipelineError("NEEDS_INPUT", "验收冻结时间无效");
  return date.toISOString();
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function json(value: unknown): any | null {
  try {
    return JSON.parse(String(value));
  } catch {
    return null;
  }
}

function ensureTables(store: Store) {
  store.db.exec(`
    CREATE TABLE IF NOT EXISTS automation_acceptances(
      id TEXT PRIMARY KEY,
      shop TEXT NOT NULL,
      release_id TEXT NOT NULL,
      target_count INTEGER NOT NULL,
      min_categories INTEGER NOT NULL,
      frozen_at TEXT NOT NULL,
      baseline_event_seq INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS automation_acceptance_candidates(
      acceptance_id TEXT NOT NULL REFERENCES automation_acceptances(id),
      ordinal INTEGER NOT NULL,
      job_id TEXT NOT NULL REFERENCES jobs(id),
      sku TEXT NOT NULL,
      category_id TEXT NOT NULL,
      recipe_hash TEXT NOT NULL,
      PRIMARY KEY(acceptance_id, job_id),
      UNIQUE(acceptance_id, ordinal),
      UNIQUE(acceptance_id, sku)
    );
    CREATE TRIGGER IF NOT EXISTS automation_acceptances_immutable_update
      BEFORE UPDATE ON automation_acceptances BEGIN SELECT RAISE(ABORT, 'acceptance is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS automation_acceptances_immutable_delete
      BEFORE DELETE ON automation_acceptances BEGIN SELECT RAISE(ABORT, 'acceptance is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS automation_acceptance_candidates_immutable_update
      BEFORE UPDATE ON automation_acceptance_candidates BEGIN SELECT RAISE(ABORT, 'acceptance candidate is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS automation_acceptance_candidates_immutable_delete
      BEFORE DELETE ON automation_acceptance_candidates BEGIN SELECT RAISE(ABORT, 'acceptance candidate is immutable'); END;
  `);
}

/**
 * Freeze a never-attempted release population. The worker must later append:
 *   stage="release", kind="release-start", detail={"releaseId":"..."}
 * before executing each job. Operator-assisted edits must append stage="manual"
 * (or kind data-updated/plan-updated/evidence-added) and can never auto-pass.
 */
export function freezeAcceptance(
  store: Store,
  jobs: Jobs,
  input: FreezeAcceptanceInput,
  now: number | string | Date = Date.now(),
) {
  ensureTables(store);
  const frozenAt = iso(now);
  if (!text(input.id) || !text(input.releaseId))
    throw new PipelineError("NEEDS_INPUT", "验收ID和发布版本不能为空");
  if (
    !Number.isInteger(input.targetCount) ||
    input.targetCount < 1 ||
    !Number.isInteger(input.minCategories) ||
    input.minCategories < 1 ||
    input.minCategories > input.targetCount ||
    input.jobIds.length !== input.targetCount ||
    new Set(input.jobIds).size !== input.jobIds.length
  )
    throw new PipelineError("NEEDS_INPUT", "验收数量、类目数或任务ID无效");

  return store.tx(() => {
    if (
      store.db
        .prepare("SELECT 1 FROM automation_acceptances WHERE id=?")
        .get(input.id)
    )
      throw new PipelineError("NEEDS_INPUT", "验收批次已冻结，不能覆盖");

    const candidates: FrozenCandidate[] = input.jobIds.map((jobId) => {
      const job = jobs.get(jobId);
      if (
        job.status !== "QUEUED" ||
        job.attempt !== 0 ||
        job.productId !== null
      )
        throw new PipelineError(
          "NEEDS_INPUT",
          `${job.sku}不是从未尝试的全新排队任务`,
        );
      const existing = store.db
        .prepare("SELECT 1 FROM products WHERE shop=? AND sku=? LIMIT 1")
        .get(jobs.shop, job.sku);
      if (existing)
        throw new PipelineError(
          "NEEDS_INPUT",
          `${job.sku}已有商品事实、方案或远端记录`,
        );
      return {
        jobId,
        sku: job.sku,
        categoryId: job.recipe.categoryId,
        recipeHash: digest(job.recipe),
      };
    });
    if (new Set(candidates.map((c) => c.sku)).size !== input.targetCount)
      throw new PipelineError("NEEDS_INPUT", "冻结任务的SKU必须唯一");
    if (
      candidates.some((c) => !text(c.categoryId)) ||
      new Set(candidates.map((c) => c.categoryId)).size < input.minCategories
    )
      throw new PipelineError("NEEDS_INPUT", "冻结任务未覆盖要求的类目数");

    const max = store.db
      .prepare("SELECT COALESCE(MAX(seq),0) seq FROM job_events")
      .get() as { seq: number };
    store.db
      .prepare("INSERT INTO automation_acceptances VALUES(?,?,?,?,?,?,?)")
      .run(
        input.id,
        jobs.shop,
        input.releaseId,
        input.targetCount,
        input.minCategories,
        frozenAt,
        Number(max.seq),
      );
    const insert = store.db.prepare(
      "INSERT INTO automation_acceptance_candidates VALUES(?,?,?,?,?,?)",
    );
    candidates.forEach((candidate, ordinal) =>
      insert.run(
        input.id,
        ordinal,
        candidate.jobId,
        candidate.sku,
        candidate.categoryId,
        candidate.recipeHash,
      ),
    );
    return {
      id: input.id,
      releaseId: input.releaseId,
      frozenAt,
      baselineEventSeq: Number(max.seq),
      targetCount: input.targetCount,
      minCategories: input.minCategories,
      candidates,
    };
  });
}

function manualEvent(stage: string, kind: string, detail: any) {
  return (
    stage === "manual" ||
    (["data", "plan", "evidence"].includes(stage) && kind === "updated") ||
    kind === "data-updated" ||
    kind === "plan-updated" ||
    kind === "evidence-added" ||
    kind === "source-selected" ||
    kind.startsWith("manual-") ||
    detail?.manual === true ||
    detail?.actor === "operator"
  );
}

export function reportAcceptance(store: Store, id: string) {
  ensureTables(store);
  const frozen = store.db
    .prepare("SELECT * FROM automation_acceptances WHERE id=?")
    .get(id) as any;
  if (!frozen) throw new PipelineError("NEEDS_INPUT", "验收批次不存在");
  const rows = store.db
    .prepare(
      "SELECT * FROM automation_acceptance_candidates WHERE acceptance_id=? ORDER BY ordinal",
    )
    .all(id) as any[];

  const candidates = rows.map((candidate) => {
    const failures: string[] = [];
    const job = store.db
      .prepare("SELECT * FROM jobs WHERE id=?")
      .get(candidate.job_id) as any;
    const events = store.db
      .prepare("SELECT * FROM job_events WHERE job_id=? AND seq>? ORDER BY seq")
      .all(candidate.job_id, frozen.baseline_event_seq) as any[];
    const parsedEvents = events.map((event) => ({
      ...event,
      parsed: json(event.detail),
    }));
    const releaseEvents = parsedEvents.filter(
      (event) => event.stage === "release" && event.kind === "release-start",
    );
    if (releaseEvents.length === 0) failures.push("missing-release-start");
    else if (
      releaseEvents.some(
        (event) => event.parsed?.releaseId !== frozen.release_id,
      )
    )
      failures.push("mismatched-release-start");
    const firstRelease = releaseEvents[0];
    if (
      firstRelease &&
      parsedEvents.some(
        (event) => event.kind === "started" && event.seq < firstRelease.seq,
      )
    )
      failures.push("late-release-start");
    if (
      parsedEvents.some((event) =>
        manualEvent(event.stage, event.kind, event.parsed),
      )
    )
      failures.push("manual-intervention");

    let recipe: any = null;
    try {
      recipe = JSON.parse(String(job?.recipe));
    } catch {}
    if (!job || !recipe || digest(recipe) !== candidate.recipe_hash)
      failures.push("recipe-version-changed");
    if (job && job.sku !== candidate.sku) failures.push("job-identity-changed");

    const product = job?.product_id
      ? (store.db
          .prepare("SELECT * FROM products WHERE id=?")
          .get(job.product_id) as any)
      : null;
    if (
      product &&
      (product.shop !== frozen.shop || product.sku !== candidate.sku)
    )
      failures.push("product-identity-mismatch");
    if (product && product.verified_hash !== product.data_hash)
      failures.push("unverified-current-version");
    if (product && !finalStates.has(String(product.state)))
      failures.push("remote-state-not-accepted");
    const pending = product
      ? store.db
          .prepare(
            "SELECT 1 FROM operations WHERE product_id=? AND status='pending' LIMIT 1",
          )
          .get(product.id)
      : null;
    if (pending) failures.push("pending-operation");

    const mediaRegistryExists = !!store.db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='automation_media_evidence'",
      )
      .get();
    if (mediaRegistryExists && product) {
      const mediaEvidence = store.db
        .prepare(
          `SELECT origin_json FROM automation_media_evidence
           WHERE shop=? AND product_id=? AND registered_at>=?`,
        )
        .all(frozen.shop, product.id, frozen.frozen_at) as any[];
      if (
        mediaEvidence.some(
          (evidence) => json(evidence.origin_json)?.kind === "manual",
        )
      )
        failures.push("manual-media-evidence");
    }

    const allOperations = product
      ? (store.db
          .prepare(
            "SELECT * FROM operations WHERE product_id=? AND created_at>=? ORDER BY created_at,id",
          )
          .all(product.id, frozen.frozen_at) as any[])
      : [];
    if (
      firstRelease &&
      allOperations.some((operation) => operation.created_at < firstRelease.at)
    )
      failures.push("late-release-start");
    const operations = allOperations.filter(
      (operation) => operation.status === "observed",
    );
    const matching = operations.filter(
      (operation) => operation.data_hash === product?.data_hash,
    );
    const validReceipt = (operation: any, submit: boolean) => {
      const receipt = json(operation.receipt);
      return (
        receipt &&
        text(receipt.itemId) === text(product?.remote_id) &&
        receipt.shop === frozen.shop &&
        receipt.sku === candidate.sku &&
        (!submit || submitStatuses.has(String(receipt.status)))
      );
    };
    const save = matching.find(
      (operation) =>
        ["save", "create"].includes(operation.kind) &&
        validReceipt(operation, false),
    );
    const submit = matching.find(
      (operation) =>
        operation.kind === "submit" &&
        validReceipt(operation, true) &&
        (!save || operation.created_at >= save.created_at),
    );
    if (!save) failures.push("missing-current-save-receipt");
    if (!submit) failures.push("missing-current-submit-receipt");

    const stageDurations: Record<string, number> = {};
    for (const event of events) {
      if (typeof event.duration_ms === "number" && event.duration_ms >= 0)
        stageDurations[event.stage] =
          (stageDurations[event.stage] ?? 0) + event.duration_ms;
    }
    const ready =
      !!job && job.status === "DONE" && !!product && failures.length === 0;
    const terminalFailure =
      failures.some((failure) =>
        [
          "manual-intervention",
          "manual-media-evidence",
          "mismatched-release-start",
          "late-release-start",
          "recipe-version-changed",
          "job-identity-changed",
          "product-identity-mismatch",
        ].includes(failure),
      ) ||
      ["NEEDS_INPUT", "UNKNOWN_OUTCOME", "CANCELLED"].includes(job?.status);
    return {
      jobId: candidate.job_id,
      sku: candidate.sku,
      categoryId: candidate.category_id,
      status: ready ? "passed" : terminalFailure ? "failed" : "incomplete",
      failures: [...new Set(failures)],
      attempt: Number(job?.attempt ?? 0),
      retries: Math.max(0, Number(job?.attempt ?? 0) - 1),
      stageDurations,
      remoteState: product?.state ?? null,
    };
  });
  const passed = candidates.filter(
    (candidate) => candidate.status === "passed",
  );
  const categoryCount = new Set(passed.map((candidate) => candidate.categoryId))
    .size;
  const failed = candidates.some((candidate) => candidate.status === "failed");
  const allPassed =
    candidates.length === frozen.target_count &&
    passed.length === frozen.target_count &&
    categoryCount >= frozen.min_categories;
  return {
    id: frozen.id,
    releaseId: frozen.release_id,
    frozenAt: frozen.frozen_at,
    targetCount: frozen.target_count,
    minCategories: frozen.min_categories,
    denominator: rows.length,
    passedCount: passed.length,
    categoryCount,
    status: allPassed ? "passed" : failed ? "failed" : "incomplete",
    candidates,
  } as const;
}
