import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { digest } from "./model.js";
import type { Store } from "./store.js";

export type TextAgentInput = {
  jobId: string;
  shop: string;
  sku: string;
  title: string;
  selectedVariant?: string | null;
  parameters?: Record<string, string>;
  packaging?: string | null;
};

export type PreparedTextInput = {
  jobId: string;
  shop: string;
  sku: string;
  title: string;
  selectedVariant: string | null;
  parameters: Record<string, string>;
  packaging: string | null;
};

export type TextAgentSource = { field: string; quote: string };
export type TextAgentResult = {
  value: string;
  sources: TextAgentSource[];
};

export type TextAgentTaskStatus =
  "pending" | "running" | "complete" | "cached" | "failed" | "stale";

export type TextAgentTask = {
  id: string;
  jobId: string;
  shop: string;
  sku: string;
  inputHash: string;
  taskType: string;
  version: string;
  model: string;
  status: TextAgentTaskStatus;
  result: TextAgentResult | null;
  error: string | null;
  durationMs: number | null;
  attempts: number;
  createdAt: string;
  updatedAt: string;
};

export type TextAgentRunner = (
  task: Readonly<{
    id: string;
    taskType: string;
    version: string;
    model: string;
    input: PreparedTextInput;
  }>,
) => Promise<unknown>;

export function prepare(input: TextAgentInput): PreparedTextInput {
  if (
    !input.jobId?.trim() ||
    !input.shop?.trim() ||
    !input.sku?.trim() ||
    !input.title?.trim()
  )
    throw new Error("文本任务缺少jobId、店铺、SKU或标题");
  const parameters: Record<string, string> = {};
  for (const key of Object.keys(input.parameters ?? {}).sort()) {
    const value = input.parameters?.[key];
    if (key.trim() && typeof value === "string" && value.trim())
      parameters[key.trim()] = value.trim();
  }
  return {
    jobId: input.jobId.trim(),
    shop: input.shop.trim(),
    sku: input.sku.trim(),
    title: input.title.trim(),
    selectedVariant: input.selectedVariant?.trim() || null,
    parameters,
    packaging: input.packaging?.trim() || null,
  };
}

function sourceFields(input: PreparedTextInput) {
  return new Map<string, string>([
    ["title", input.title],
    ["selectedVariant", input.selectedVariant ?? ""],
    ["packaging", input.packaging ?? ""],
    ...Object.entries(input.parameters).map(
      ([key, value]) => [`parameters.${key}`, value] as [string, string],
    ),
  ]);
}

function numberTokens(value: unknown): string[] {
  return JSON.stringify(value).match(/\d+(?:\.\d+)?/g) ?? [];
}

export function validateTextAgentResult(
  raw: unknown,
  input: PreparedTextInput,
): TextAgentResult {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new Error("Luna结果不是对象");
  const value = (raw as any).value,
    sources = (raw as any).sources;
  if (typeof value !== "string" || !value.trim())
    throw new Error("Luna结果缺少文本value");
  if (!Array.isArray(sources) || !sources.length)
    throw new Error("Luna结果缺少来源引用");
  const fields = sourceFields(input),
    checked: TextAgentSource[] = sources.map((source: any) => {
      const text = fields.get(source?.field);
      if (
        !source ||
        typeof source.field !== "string" ||
        typeof source.quote !== "string" ||
        !source.quote ||
        text === undefined ||
        !text.includes(source.quote)
      )
        throw new Error("Luna结果包含输入白名单以外的来源引用");
      return { field: source.field, quote: source.quote };
    });
  const supported = new Set(
    checked.flatMap((source) => numberTokens(source.quote)),
  );
  for (const token of numberTokens(value))
    if (!supported.has(token))
      throw new Error(`Luna结果含无来源数字规格：${token}`);
  return { value, sources: checked };
}

export class TextAgentTasks {
  constructor(readonly store: Store) {
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS agent_tasks(
        id TEXT PRIMARY KEY, job_id TEXT NOT NULL, shop TEXT NOT NULL, sku TEXT NOT NULL,
        input_hash TEXT NOT NULL, input TEXT NOT NULL, task_type TEXT NOT NULL,
        version TEXT NOT NULL, model TEXT NOT NULL, cache_key TEXT NOT NULL,
        status TEXT NOT NULL, result TEXT, error TEXT, duration_ms INTEGER,
        attempts INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS agent_tasks_request ON agent_tasks(job_id,cache_key);
      CREATE INDEX IF NOT EXISTS agent_tasks_queue ON agent_tasks(status,created_at);
      CREATE TABLE IF NOT EXISTS agent_task_cache(
        cache_key TEXT PRIMARY KEY, input_hash TEXT NOT NULL, task_type TEXT NOT NULL,
        version TEXT NOT NULL, model TEXT NOT NULL, result TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS agent_task_events(
        seq INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL,
        event TEXT NOT NULL, detail TEXT NOT NULL, at TEXT NOT NULL
      );
    `);
  }

  recoverRunning(): number {
    const changed = this.store.db
      .prepare(
        "UPDATE agent_tasks SET status='failed',error='recovery_required',updated_at=? WHERE status='running'",
      )
      .run(new Date().toISOString()).changes;
    return Number(changed);
  }

  enqueue(
    input: TextAgentInput,
    options: { taskType: string; version: string; model?: string },
  ): TextAgentTask {
    if (!options.taskType.trim() || !options.version.trim())
      throw new Error("文本任务缺少任务类型或规则版本");
    const prepared = prepare(input),
      { jobId, ...content } = prepared,
      inputHash = digest(content),
      model = options.model ?? "gpt-5.6-luna",
      cacheKey = digest({
        inputHash,
        taskType: options.taskType,
        version: options.version,
        model,
      });
    return this.store.tx(() => {
      const existing = this.store.db
        .prepare("SELECT id FROM agent_tasks WHERE job_id=? AND cache_key=?")
        .get(jobId, cacheKey);
      if (existing) return this.get(String(existing.id));
      const at = new Date().toISOString(),
        cached = this.store.db
          .prepare(
            "SELECT result FROM agent_task_cache WHERE cache_key=? AND input_hash=?",
          )
          .get(cacheKey, inputHash),
        id = randomUUID();
      this.store.db
        .prepare(
          "UPDATE agent_tasks SET status='stale',error='input_superseded',updated_at=? WHERE job_id=? AND shop=? AND sku=? AND task_type=? AND status IN ('pending','running') AND input_hash<>?",
        )
        .run(
          at,
          jobId,
          prepared.shop,
          prepared.sku,
          options.taskType,
          inputHash,
        );
      this.store.db
        .prepare(
          `INSERT INTO agent_tasks(id,job_id,shop,sku,input_hash,input,task_type,version,model,cache_key,status,result,error,duration_ms,attempts,created_at,updated_at)
           VALUES(?,?,?,?,?,?,?,?,?,?,?, ?,NULL,NULL,0,?,?)`,
        )
        .run(
          id,
          jobId,
          prepared.shop,
          prepared.sku,
          inputHash,
          JSON.stringify(prepared),
          options.taskType,
          options.version,
          model,
          cacheKey,
          cached ? "cached" : "pending",
          cached ? String(cached.result) : null,
          at,
          at,
        );
      return this.get(id);
    });
  }

  claim(id?: string): TextAgentTask | null {
    return this.store.tx(() => {
      const row = id
        ? this.store.db
            .prepare(
              "SELECT id FROM agent_tasks WHERE id=? AND status='pending'",
            )
            .get(id)
        : this.store.db
            .prepare(
              "SELECT id FROM agent_tasks WHERE status='pending' ORDER BY created_at,id LIMIT 1",
            )
            .get();
      if (!row) return null;
      const at = new Date().toISOString();
      this.store.db
        .prepare(
          "UPDATE agent_tasks SET status='running',attempts=attempts+1,error=NULL,updated_at=? WHERE id=? AND status='pending'",
        )
        .run(at, row.id);
      return this.get(String(row.id));
    });
  }

  retry(id: string): TextAgentTask {
    return this.store.tx(() => {
      const task = this.get(id);
      if (task.status === "stale")
        throw new Error("资料已更新的Luna任务不能重试，请按当前输入重新入队");
      if (task.status !== "failed") return task;
      const at = new Date().toISOString(),
        changed = this.store.db
          .prepare(
            "UPDATE agent_tasks SET status='pending',result=NULL,error=NULL,duration_ms=NULL,updated_at=? WHERE id=? AND status='failed'",
          )
          .run(at, id).changes;
      if (Number(changed) === 1)
        this.store.db
          .prepare(
            "INSERT INTO agent_task_events(task_id,event,detail,at) VALUES(?,'retry_requested',?,?)",
          )
          .run(
            id,
            JSON.stringify({
              previousError: task.error,
              previousAttempts: task.attempts,
            }),
            at,
          );
      return this.get(id);
    });
  }

  async runOne(
    runner: TextAgentRunner,
    id?: string,
  ): Promise<TextAgentTask | null> {
    const task = this.claim(id);
    if (!task) return null;
    const row = this.raw(task.id),
      input = JSON.parse(String(row.input)) as PreparedTextInput,
      started = Date.now();
    try {
      const raw = await runner({
        id: task.id,
        taskType: task.taskType,
        version: task.version,
        model: task.model,
        input,
      });
      const result = validateTextAgentResult(raw, input),
        duration = Date.now() - started,
        at = new Date().toISOString();
      this.store.tx(() => {
        const current = this.raw(task.id);
        if (current.status !== "running")
          throw new Error("文本任务运行状态已失效");
        const newer = this.store.db
          .prepare(
            "SELECT 1 FROM agent_tasks WHERE job_id=? AND shop=? AND sku=? AND task_type=? AND rowid>(SELECT rowid FROM agent_tasks WHERE id=?) AND input_hash<>? LIMIT 1",
          )
          .get(
            row.job_id,
            row.shop,
            row.sku,
            row.task_type,
            task.id,
            row.input_hash,
          );
        if (newer) {
          this.store.db
            .prepare(
              "UPDATE agent_tasks SET status='stale',error='input_superseded',duration_ms=?,updated_at=? WHERE id=?",
            )
            .run(duration, at, task.id);
          return;
        }
        this.store.db
          .prepare(
            "UPDATE agent_tasks SET status='complete',result=?,duration_ms=?,updated_at=? WHERE id=?",
          )
          .run(JSON.stringify(result), duration, at, task.id);
        this.store.db
          .prepare(
            "INSERT OR REPLACE INTO agent_task_cache VALUES(?,?,?,?,?,?,?)",
          )
          .run(
            row.cache_key,
            row.input_hash,
            row.task_type,
            row.version,
            row.model,
            JSON.stringify(result),
            at,
          );
      });
    } catch (error) {
      const current = this.raw(task.id);
      if (current.status === "running")
        this.store.db
          .prepare(
            "UPDATE agent_tasks SET status='failed',error=?,duration_ms=?,updated_at=? WHERE id=?",
          )
          .run(
            error instanceof Error ? error.message : String(error),
            Date.now() - started,
            new Date().toISOString(),
            task.id,
          );
    }
    return this.get(task.id);
  }

  get(id: string): TextAgentTask {
    const row = this.raw(id);
    return {
      id: String(row.id),
      jobId: String(row.job_id),
      shop: String(row.shop),
      sku: String(row.sku),
      inputHash: String(row.input_hash),
      taskType: String(row.task_type),
      version: String(row.version),
      model: String(row.model),
      status: row.status as TextAgentTaskStatus,
      result: row.result ? JSON.parse(String(row.result)) : null,
      error: row.error ? String(row.error) : null,
      durationMs: row.duration_ms == null ? null : Number(row.duration_ms),
      attempts: Number(row.attempts),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  list(filter: { jobId?: string; status?: TextAgentTaskStatus } = {}) {
    return (
      this.store.db
        .prepare("SELECT id FROM agent_tasks ORDER BY created_at,id")
        .all() as any[]
    )
      .map((row) => this.get(String(row.id)))
      .filter(
        (task) =>
          (!filter.jobId || task.jobId === filter.jobId) &&
          (!filter.status || task.status === filter.status),
      );
  }

  result(id: string): TextAgentResult | null {
    return this.get(id).result;
  }

  private raw(id: string): any {
    const row = this.store.db
      .prepare("SELECT * FROM agent_tasks WHERE id=?")
      .get(id);
    if (!row) throw new Error("文本任务不存在");
    return row;
  }
}

const outputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["value", "sources"],
  properties: {
    value: { type: "string" },
    sources: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["field", "quote"],
        properties: { field: { type: "string" }, quote: { type: "string" } },
      },
    },
  },
};

export function createCodexLunaRunner(options: {
  codexPath?: string;
  timeoutMs: number;
}): TextAgentRunner {
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)
    throw new Error("CLI runner必须配置有限超时");
  return async (task) => {
    const dir = mkdtempSync(join(tmpdir(), "hezi-luna-")),
      schema = join(dir, "schema.json"),
      output = join(dir, "result.json");
    try {
      writeFileSync(schema, JSON.stringify(outputSchema), { mode: 0o600 });
      const { jobId: _jobId, ...content } = task.input;
      const prompt = JSON.stringify({
        instruction:
          "仅按任务处理给定JSON。不得使用外部事实。sources.field只能是title、selectedVariant、packaging或现有parameters.<键>，quote必须是该字段的原文子串。normalize_title输出不超过80字，保留品牌、商品类别、所选规格的实际数量或容量；只可删除营销词，不得新增宣称或规格。不得新增输入引用没有的数字规格。",
        taskType: task.taskType,
        rulesVersion: task.version,
        input: content,
      });
      await new Promise<void>((resolve, reject) => {
        const child = spawn(
          options.codexPath ?? "codex",
          [
            "exec",
            "-m",
            task.model,
            "--ephemeral",
            "--ignore-user-config",
            "--ignore-rules",
            "--skip-git-repo-check",
            "--disable",
            "shell_tool",
            "--disable",
            "unified_exec",
            "--disable",
            "browser_use",
            "--disable",
            "browser_use_external",
            "--disable",
            "computer_use",
            "--disable",
            "in_app_browser",
            "--disable",
            "apps",
            "--disable",
            "plugins",
            "--disable",
            "remote_plugin",
            "--disable",
            "multi_agent",
            "-s",
            "read-only",
            "--output-schema",
            schema,
            "-o",
            output,
            "-",
          ],
          { cwd: dir, stdio: ["pipe", "ignore", "pipe"] },
        );
        let stderr = "";
        child.stderr.setEncoding("utf8");
        child.stderr.on("data", (chunk) => {
          stderr = (stderr + String(chunk)).slice(-4000);
        });
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          reject(new Error("Luna CLI运行超时"));
        }, options.timeoutMs);
        child.once("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
        child.once("exit", (code) => {
          clearTimeout(timer);
          code === 0
            ? resolve()
            : reject(
                new Error(`Luna CLI失败(${code}): ${stderr.slice(-1000)}`),
              );
        });
        child.stdin.on("error", (error: NodeJS.ErrnoException) => {
          if (error.code !== "EPIPE") reject(error);
        });
        child.stdin.end(prompt);
      });
      return JSON.parse(readFileSync(output, "utf8"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
}
