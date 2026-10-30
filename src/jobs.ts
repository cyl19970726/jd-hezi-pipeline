import { randomUUID } from "node:crypto";
import { Store } from "./store.js";
import { parseSku, PipelineError } from "./model.js";
export type JobStatus =
  | "QUEUED"
  | "RUNNING"
  | "NEEDS_INPUT"
  | "UNKNOWN_OUTCOME"
  | "DONE"
  | "CANCELLED";
export interface Recipe {
  source?: "browser" | "android";
  brandId: string;
  categoryId: string;
  policyId: string;
  unit: string;
  through: "draft" | "submit";
}
export interface Job {
  id: string;
  sku: string;
  status: JobStatus;
  stage: string;
  productId: string | null;
  recipe: Recipe;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  attempt: number;
}
export class Jobs {
  constructor(
    readonly store: Store,
    readonly shop: string,
  ) {
    store.db.exec(
      `CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,shop TEXT NOT NULL,sku TEXT NOT NULL,status TEXT NOT NULL,stage TEXT NOT NULL,product_id TEXT,recipe TEXT NOT NULL,error TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,attempt INTEGER NOT NULL DEFAULT 0,UNIQUE(shop,sku));CREATE TABLE IF NOT EXISTS batches(id TEXT PRIMARY KEY,created_at TEXT NOT NULL);CREATE TABLE IF NOT EXISTS batch_jobs(batch_id TEXT REFERENCES batches(id),job_id TEXT REFERENCES jobs(id),PRIMARY KEY(batch_id,job_id));CREATE TABLE IF NOT EXISTS job_events(seq INTEGER PRIMARY KEY AUTOINCREMENT,job_id TEXT REFERENCES jobs(id),stage TEXT NOT NULL,kind TEXT NOT NULL,at TEXT NOT NULL,duration_ms INTEGER,detail TEXT NOT NULL);CREATE INDEX IF NOT EXISTS idx_jobs_queue ON jobs(shop,status,created_at,id);CREATE INDEX IF NOT EXISTS idx_job_events_job ON job_events(job_id,seq);PRAGMA optimize;`,
    );
  }
  private decode(r: any): Job {
    return {
      id: r.id,
      sku: r.sku,
      status: r.status,
      stage: r.stage,
      productId: r.product_id,
      recipe: JSON.parse(r.recipe),
      error: r.error,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      attempt: r.attempt,
    };
  }
  list() {
    return this.store.db
      .prepare("SELECT * FROM jobs WHERE shop=? ORDER BY created_at DESC,id")
      .all(this.shop)
      .map((r) => this.decode(r));
  }
  get(id: string) {
    const r = this.store.db
      .prepare("SELECT * FROM jobs WHERE id=? AND shop=?")
      .get(id, this.shop);
    if (!r) throw new PipelineError("NEEDS_INPUT", "任务不存在");
    return this.decode(r);
  }
  enqueue(
    inputs: string[],
    recipe: Recipe,
    source?: { runId: string; brandId: string; waveKey?: string },
  ) {
    if (!inputs.length || inputs.length > 200)
      throw new PipelineError("NEEDS_INPUT", "每批需要1至200条链接");
    const skus = [...new Set(inputs.map(parseSku))];
    return this.store.tx(() => {
      let wave: any = null;
      if (source?.waveKey) {
        wave = this.store.meta(source.waveKey);
        if (
          !wave ||
          typeof wave !== "object" ||
          !Array.isArray(wave.candidates)
        )
          throw new PipelineError(
            "NEEDS_INPUT",
            "受控批次计划不存在或格式无效",
          );
        for (const sku of skus) {
          const candidates = wave.candidates.filter(
            (candidate: any) => candidate?.sku === sku,
          );
          if (candidates.length !== 1)
            throw new PipelineError(
              "NEEDS_INPUT",
              `${sku}不属于该受控批次或候选记录不唯一`,
            );
          const candidate = candidates[0];
          if (
            candidate.brandId !== source.brandId ||
            candidate.brandId !== recipe.brandId ||
            candidate.evidence?.runId !== source.runId ||
            (candidate.suggestedCategoryId !== undefined &&
              candidate.suggestedCategoryId !== recipe.categoryId)
          )
            throw new PipelineError(
              "NEEDS_INPUT",
              `${sku}的品牌、来源或类目与受控批次计划不一致`,
            );
        }
        if (wave.groups !== undefined && !Array.isArray(wave.groups))
          throw new PipelineError("NEEDS_INPUT", "受控批次分组记录格式无效");
      }
      const batch = randomUUID(),
        now = new Date().toISOString();
      this.store.db.prepare("INSERT INTO batches VALUES(?,?)").run(batch, now);
      const items = skus.map((sku) => {
        let r = this.store.db
          .prepare("SELECT * FROM jobs WHERE shop=? AND sku=?")
          .get(this.shop, sku);
        const reused = !!r;
        if (r && source) {
          const prior = JSON.parse(String(r.recipe)) as Recipe;
          if (
            (Object.keys(recipe) as (keyof Recipe)[]).some(
              (k) => prior[k] !== recipe[k],
            )
          )
            throw new PipelineError(
              "NEEDS_INPUT",
              `${sku}已有任务使用不同上架规则，不能静默替换`,
            );
        }
        if (!r) {
          const id = randomUUID();
          this.store.db
            .prepare("INSERT INTO jobs VALUES(?,?,?,?,?,?,?,?,?,?,?)")
            .run(
              id,
              this.shop,
              sku,
              "QUEUED",
              "queued",
              null,
              JSON.stringify(recipe),
              null,
              now,
              now,
              0,
            );
          r = this.store.db.prepare("SELECT * FROM jobs WHERE id=?").get(id);
        }
        if (source && (!reused || source.waveKey))
          this.event(String(r!.id), "queued", "source-assigned", null, {
            ...source,
            sku,
          });
        this.store.db
          .prepare("INSERT INTO batch_jobs VALUES(?,?)")
          .run(batch, String(r!.id));
        return { id: String(r!.id), sku, reused, status: r!.status };
      });
      if (source?.waveKey) {
        wave.groups = [
          ...(wave.groups ?? []),
          { batch, items, startedAt: now },
        ];
        wave.status = "in-progress";
        this.store.setMeta(source.waveKey, wave);
      }
      return { batch, items };
    });
  }
  update(
    id: string,
    status: JobStatus,
    stage: string,
    error: string | null = null,
    productId?: string,
  ) {
    this.get(id);
    this.store.db
      .prepare(
        "UPDATE jobs SET status=?,stage=?,error=?,product_id=COALESCE(?,product_id),updated_at=? WHERE id=?",
      )
      .run(
        status,
        stage,
        error,
        productId ?? null,
        new Date().toISOString(),
        id,
      );
  }
  claim(allowed: (job: Job) => boolean = () => true) {
    return this.store.tx(() => {
      const r = this.store.db
        .prepare(
          "SELECT * FROM jobs WHERE shop=? AND status='QUEUED' ORDER BY created_at,id",
        )
        .all(this.shop)
        .find((r) => allowed(this.decode(r)));
      if (!r) return null;
      this.store.db
        .prepare(
          "UPDATE jobs SET status='RUNNING',attempt=attempt+1,updated_at=? WHERE id=?",
        )
        .run(new Date().toISOString(), String(r.id));
      return this.get(String(r.id));
    });
  }
  source(id: string, source: "browser" | "android") {
    const j = this.get(id);
    if (
      !["QUEUED", "NEEDS_INPUT", "CANCELLED"].includes(j.status) ||
      (j.productId &&
        (this.store.pending(j.productId) ||
          this.store.get(j.productId).remoteId))
    )
      throw new PipelineError(
        "NEEDS_INPUT",
        "仅未发布且无未决写入的任务可切换采集入口",
      );
    this.store.tx(() => {
      this.store.db
        .prepare("UPDATE jobs SET recipe=? WHERE id=?")
        .run(JSON.stringify({ ...j.recipe, source }), id);
      this.update(id, "QUEUED", "queued");
      this.event(id, "collect", "source-selected", null, { source });
    });
    return this.get(id);
  }
  recover() {
    for (const j of this.list().filter((j) => j.status === "RUNNING")) {
      const uncertain = j.productId && this.store.pending(j.productId);
      this.update(
        j.id,
        uncertain ? "UNKNOWN_OUTCOME" : "NEEDS_INPUT",
        j.stage,
        uncertain
          ? "服务中断，先对账确认写入结果"
          : "服务中断，可从已保存的数据继续",
      );
    }
  }
  retry(id: string) {
    const j = this.get(id);
    if (!["NEEDS_INPUT", "CANCELLED"].includes(j.status))
      throw new PipelineError(
        "NEEDS_INPUT",
        "该任务不能重试；未知写入必须先对账",
      );
    if (j.productId && this.store.pending(j.productId))
      throw new PipelineError("UNKNOWN_OUTCOME", "必须先对账");
    this.update(id, "QUEUED", "queued");
  }
  event(
    id: string,
    stage: string,
    kind: string,
    duration: number | null = null,
    detail: unknown = null,
  ) {
    this.store.db
      .prepare(
        "INSERT INTO job_events(job_id,stage,kind,at,duration_ms,detail) VALUES(?,?,?,?,?,?)",
      )
      .run(
        id,
        stage,
        kind,
        new Date().toISOString(),
        duration,
        JSON.stringify(detail),
      );
  }
  events(id: string) {
    this.get(id);
    return this.store.db
      .prepare("SELECT * FROM job_events WHERE job_id=? ORDER BY seq")
      .all(id);
  }
  async stage<T>(id: string, name: string, fn: () => Promise<T>): Promise<T> {
    this.update(id, "RUNNING", name);
    this.event(id, name, "started");
    const start = performance.now();
    try {
      const result = await fn();
      this.event(id, name, "completed", Math.round(performance.now() - start));
      return result;
    } catch (e) {
      this.event(
        id,
        name,
        "failed",
        Math.round(performance.now() - start),
        String(e),
      );
      throw e;
    }
  }
}
