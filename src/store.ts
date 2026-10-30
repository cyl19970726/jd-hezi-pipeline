import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  digest,
  identity,
  PipelineError,
  type Plan,
  type Product,
  type Row,
  type State,
} from "./model.js";

export class Store {
  db: DatabaseSync;
  constructor(path: string) {
    if (path !== ":memory:")
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db
      .exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS products(id TEXT PRIMARY KEY,shop TEXT NOT NULL,sku TEXT NOT NULL,variant TEXT NOT NULL,state TEXT NOT NULL,product TEXT,plan TEXT,data_hash TEXT NOT NULL,remote_id TEXT,remote_code TEXT,verified_hash TEXT,error TEXT,revision INTEGER NOT NULL DEFAULT 1,updated_at TEXT NOT NULL,media_refs TEXT,UNIQUE(shop,sku,variant));
      CREATE UNIQUE INDEX IF NOT EXISTS unique_remote ON products(shop,remote_id) WHERE remote_id IS NOT NULL;
      CREATE TABLE IF NOT EXISTS operations(id TEXT PRIMARY KEY,product_id TEXT NOT NULL REFERENCES products(id),kind TEXT NOT NULL,data_hash TEXT NOT NULL,status TEXT NOT NULL,receipt TEXT,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT,product_id TEXT,event TEXT NOT NULL,detail TEXT NOT NULL,at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS replacements(product_id TEXT PRIMARY KEY REFERENCES products(id),old_id TEXT NOT NULL,old_code TEXT NOT NULL,new_id TEXT,status TEXT NOT NULL,evidence TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS locks(name TEXT PRIMARY KEY,owner TEXT NOT NULL,pid INTEGER NOT NULL,created_at TEXT NOT NULL);
      INSERT OR IGNORE INTO meta VALUES('schemaVersion','1');`);
  }
  close() {
    this.db.close();
  }
  tx<T>(fn: () => T): T {
    if (this.transactionDepth > 0) {
      const name = `hezi_nested_${this.transactionDepth++}`;
      this.db.exec(`SAVEPOINT ${name}`);
      try {
        const result = fn();
        this.db.exec(`RELEASE SAVEPOINT ${name}`);
        return result;
      } catch (error) {
        this.db.exec(`ROLLBACK TO SAVEPOINT ${name}`);
        this.db.exec(`RELEASE SAVEPOINT ${name}`);
        throw error;
      } finally {
        this.transactionDepth--;
      }
    }
    this.db.exec("BEGIN IMMEDIATE");
    this.transactionDepth++;
    try {
      const r = fn();
      this.db.exec("COMMIT");
      return r;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    } finally {
      this.transactionDepth--;
    }
  }
  private transactionDepth = 0;
  event(id: string | null, event: string, detail: unknown) {
    this.db
      .prepare("INSERT INTO events(product_id,event,detail,at) VALUES(?,?,?,?)")
      .run(id, event, JSON.stringify(detail), new Date().toISOString());
  }
  meta(key: string): any {
    const r = this.db.prepare("SELECT value FROM meta WHERE key=?").get(key);
    return r ? JSON.parse(String(r.value)) : null;
  }
  setMeta(key: string, value: unknown) {
    this.db
      .prepare(
        "INSERT INTO meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(key, JSON.stringify(value));
  }
  private decode(r: any): Row {
    return {
      id: r.id,
      shop: r.shop,
      sku: r.sku,
      variant: r.variant,
      state: r.state,
      product: r.product ? JSON.parse(r.product) : null,
      plan: r.plan ? JSON.parse(r.plan) : null,
      dataHash: r.data_hash,
      remoteId: r.remote_id,
      remoteCode: r.remote_code,
      verifiedHash: r.verified_hash,
      error: r.error,
      revision: r.revision,
      mediaReferences: r.media_refs ? JSON.parse(r.media_refs) : null,
    };
  }
  get(id: string): Row {
    const r = this.db.prepare("SELECT * FROM products WHERE id=?").get(id);
    if (!r) throw new PipelineError("NEEDS_INPUT", "商品记录不存在：" + id);
    return this.decode(r);
  }
  list(): Row[] {
    return this.db
      .prepare("SELECT * FROM products ORDER BY updated_at,id")
      .all()
      .map((r) => this.decode(r));
  }
  put(shop: string, product: Product): Row {
    const id = identity(shop, product.sku, product.variant);
    return this.tx(() => {
      const old = this.db.prepare("SELECT * FROM products WHERE id=?").get(id);
      const plan = old?.plan ? JSON.parse(String(old.plan)) : null;
      const hash = digest({ product, plan });
      if (old && old.data_hash === hash) return this.decode(old);
      if (old && this.pending(id))
        throw new PipelineError(
          "UNKNOWN_OUTCOME",
          "先对账未完成操作，再修改输入。",
        );
      this.db
        .prepare(
          `INSERT INTO products(id,shop,sku,variant,state,product,data_hash,updated_at) VALUES(?,?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET product=excluded.product,data_hash=excluded.data_hash,state='EXTRACTED',verified_hash=NULL,media_refs=NULL,error=NULL,revision=revision+1,updated_at=excluded.updated_at`,
        )
        .run(
          id,
          shop,
          product.sku,
          product.variant,
          "EXTRACTED",
          JSON.stringify(product),
          hash,
          new Date().toISOString(),
        );
      this.event(id, "SOURCE_UPDATED", { hash });
      return this.get(id);
    });
  }
  resetUnpublishedPlan(id: string, reason: string): Row {
    return this.tx(() => {
      const row = this.get(id);
      if (!reason.trim() || !row.product)
        throw new PipelineError("NEEDS_INPUT", "重建计划需要商品及原因");
      if (
        row.remoteId ||
        this.pending(id) ||
        [
          "DRAFT_SAVED",
          "DRAFT_VERIFIED",
          "SUBMIT_REQUESTED",
          "SUBMITTED",
          "APPROVED",
          "ON_SALE",
        ].includes(row.state)
      )
        throw new PipelineError(
          "BUSINESS_BLOCKED",
          "已写入或有未决操作的商品不能重建未发布计划",
        );
      const hash = digest({ product: row.product, plan: null });
      this.db
        .prepare(
          "UPDATE products SET plan=NULL,data_hash=?,verified_hash=NULL,state='EXTRACTED',revision=revision+1,updated_at=? WHERE id=?",
        )
        .run(hash, new Date().toISOString(), id);
      this.event(id, "UNPUBLISHED_PLAN_RESET", {
        reason,
        previousPlan: row.plan,
      });
      return this.get(id);
    });
  }
  setPlan(id: string, plan: Plan): Row {
    return this.tx(() => {
      const row = this.get(id);
      if (row.shop !== plan.shop)
        throw new PipelineError("ACCOUNT_CHANGED", "规则店铺与商品身份不一致");
      if (this.pending(id))
        throw new PipelineError(
          "UNKNOWN_OUTCOME",
          "先对账未完成操作，再修改规则",
        );
      const hash = digest({ product: row.product, plan });
      if (hash === row.dataHash) return row;
      this.db
        .prepare(
          "UPDATE products SET plan=?,data_hash=?,verified_hash=NULL,state='EXTRACTED',error=NULL,revision=revision+1,updated_at=? WHERE id=?",
        )
        .run(JSON.stringify(plan), hash, new Date().toISOString(), id);
      this.event(id, "PLAN_UPDATED", {
        rulesVersion: plan.rulesVersion,
        hash,
        invalidated: row.verifiedHash,
      });
      return this.get(id);
    });
  }
  state(id: string, state: State, detail: unknown = null) {
    this.db
      .prepare(
        "UPDATE products SET state=?,error=?,revision=revision+1,updated_at=? WHERE id=?",
      )
      .run(
        state,
        detail ? JSON.stringify(detail) : null,
        new Date().toISOString(),
        id,
      );
    this.event(id, state, detail);
  }
  bind(id: string, remoteId: string, code: string) {
    if (!/^\d+$/.test(remoteId) || !/^\d+$/.test(code))
      throw new PipelineError("UI_CHANGED", "商品ID或编码格式无效，拒绝绑定");
    const row = this.get(id);
    if (row.remoteId && row.remoteId !== remoteId)
      throw new PipelineError("UNKNOWN_OUTCOME", "已有远端身份不能静默替换");
    this.db
      .prepare("UPDATE products SET remote_id=?,remote_code=? WHERE id=?")
      .run(remoteId, code, id);
    this.event(id, "REMOTE_BOUND", { remoteId, code });
  }
  replacement(id: string) {
    return this.db
      .prepare("SELECT * FROM replacements WHERE product_id=?")
      .get(id);
  }
  beginReplacement(
    id: string,
    evidence: {
      itemId: string;
      hasOrderInfo: number;
      status: string;
      reason: string;
    },
  ) {
    return this.tx(() => {
      const row = this.get(id);
      if (
        this.replacement(id) ||
        this.pending(id) ||
        row.remoteId !== evidence.itemId ||
        evidence.hasOrderInfo !== 0 ||
        !["草稿", "待提交"].includes(evidence.status) ||
        !evidence.reason
      )
        throw new PipelineError(
          "BUSINESS_BLOCKED",
          "替代前置条件不满足，旧记录保持不变",
        );
      this.db
        .prepare("INSERT INTO replacements VALUES(?,?,?,?,?,?,?)")
        .run(
          id,
          row.remoteId,
          row.remoteCode,
          null,
          "pending",
          JSON.stringify(evidence),
          new Date().toISOString(),
        );
      this.event(id, "LEGACY_QUARANTINED", evidence);
      return this.intent(id, "save");
    });
  }
  completeReplacement(
    id: string,
    op: string,
    receipt: {
      itemId: string;
      code: string;
      shop: string;
      sku: string;
      mediaReferences?: unknown;
    },
  ) {
    this.tx(() => {
      const row = this.get(id),
        replacement = this.replacement(id);
      if (
        !replacement ||
        replacement.status !== "pending" ||
        replacement.old_id !== row.remoteId ||
        receipt.itemId === row.remoteId ||
        receipt.shop !== row.shop ||
        receipt.sku !== row.sku ||
        !/^\d+$/.test(receipt.itemId) ||
        !/^\d+$/.test(receipt.code)
      )
        throw new PipelineError("UNKNOWN_OUTCOME", "替代回执身份不符");
      if (this.pending(id)?.id !== op)
        throw new PipelineError("UNKNOWN_OUTCOME", "替代操作不匹配");
      this.db
        .prepare(
          "UPDATE products SET remote_id=?,remote_code=?,verified_hash=NULL,media_refs=?,state='DRAFT_SAVED' WHERE id=?",
        )
        .run(
          receipt.itemId,
          receipt.code,
          JSON.stringify(receipt.mediaReferences ?? null),
          id,
        );
      this.db
        .prepare(
          "UPDATE replacements SET new_id=?,status='bound' WHERE product_id=?",
        )
        .run(receipt.itemId, id);
      this.receipt(op, receipt);
      this.event(id, "LEGACY_REPLACED", {
        oldId: replacement.old_id,
        newId: receipt.itemId,
      });
    });
  }
  verified(id: string, hash: string) {
    if (this.get(id).dataHash !== hash)
      throw new PipelineError("UNKNOWN_OUTCOME", "验证期间输入版本已变化");
    this.db
      .prepare(
        "UPDATE products SET state='DRAFT_VERIFIED',verified_hash=?,error=NULL WHERE id=?",
      )
      .run(hash, id);
    this.event(id, "DRAFT_VERIFIED", { hash });
  }
  media(id: string, refs: unknown) {
    this.db
      .prepare("UPDATE products SET media_refs=? WHERE id=?")
      .run(JSON.stringify(refs), id);
  }
  pending(id: string) {
    return this.db
      .prepare(
        "SELECT * FROM operations WHERE product_id=? AND status='pending' ORDER BY created_at LIMIT 1",
      )
      .get(id);
  }
  intent(id: string, kind: "save" | "submit" | "withdraw"): string {
    if (this.pending(id))
      throw new PipelineError("UNKNOWN_OUTCOME", "有未完成操作，必须先对账");
    const op = randomUUID();
    this.db
      .prepare("INSERT INTO operations VALUES(?,?,?,?,?,?,?)")
      .run(
        op,
        id,
        kind,
        this.get(id).dataHash,
        "pending",
        null,
        new Date().toISOString(),
      );
    this.event(id, "OPERATION_STARTED", { op, kind });
    return op;
  }
  receipt(op: string, value: unknown) {
    this.db
      .prepare("UPDATE operations SET status='observed',receipt=? WHERE id=?")
      .run(JSON.stringify(value), op);
  }
  /**
   * Reasons are kept separately from the legacy pause key.  The latter remains
   * a truthy, human-readable projection so old callers and already-paused
   * production databases stay fail-closed.
   */
  pauseReasons(scope: string): Record<string, unknown> {
    const stored = this.meta("pause-reasons:" + scope);
    if (
      stored &&
      typeof stored === "object" &&
      !Array.isArray(stored) &&
      stored.version === 1 &&
      stored.reasons &&
      typeof stored.reasons === "object" &&
      !Array.isArray(stored.reasons)
    )
      return { ...stored.reasons };
    const legacy = this.meta("pause:" + scope);
    return legacy === null ? {} : { legacy };
  }
  isPaused(scope: string) {
    return Object.keys(this.pauseReasons(scope)).length > 0;
  }
  private writePauseReasons(scope: string, reasons: Record<string, unknown>) {
    const keys = Object.keys(reasons);
    if (!keys.length) {
      this.db
        .prepare("DELETE FROM meta WHERE key IN (?,?)")
        .run("pause:" + scope, "pause-reasons:" + scope);
      return;
    }
    this.setMeta("pause-reasons:" + scope, { version: 1, reasons });
    // Preserve the former meta value's useful shape when there is one cause;
    // show every cause when independent safety stops overlap.
    this.setMeta(
      "pause:" + scope,
      keys.length === 1 ? reasons[keys[0]] : { reasons },
    );
  }
  pause(scope: string, reason: unknown, reasonId = "legacy") {
    this.tx(() => {
      const reasons = this.pauseReasons(scope);
      reasons[reasonId] = reason;
      this.writePauseReasons(scope, reasons);
      this.event(null, "PAUSED", { scope, reason, reasonId });
    });
  }
  /** Explicit legacy/operator recovery: remove every reason in this scope. */
  resume(scope: string) {
    this.tx(() => {
      this.writePauseReasons(scope, {});
      this.event(null, "RESUMED", { scope });
    });
  }
  /** Clear only a reason whose recovery was independently verified. */
  resumeReason(scope: string, reasonId: string) {
    return this.tx(() => {
      const reasons = this.pauseReasons(scope);
      if (!Object.hasOwn(reasons, reasonId)) return false;
      delete reasons[reasonId];
      this.writePauseReasons(scope, reasons);
      this.event(null, "RESUMED", { scope, reasonId });
      return true;
    });
  }
  assertScopes(...scopes: string[]) {
    for (const scope of scopes) {
      const reasons = this.pauseReasons(scope);
      if (Object.keys(reasons).length)
        throw new PipelineError("PAUSED", "队列已暂停", { scope, reasons });
    }
  }
  assertRunning(shop: string) {
    this.assertScopes("all", shop);
  }
  lock(name: string): () => void {
    const owner = randomUUID();
    try {
      this.db
        .prepare("INSERT INTO locks VALUES(?,?,?,?)")
        .run(name, owner, process.pid, new Date().toISOString());
    } catch {
      throw new PipelineError(
        "LOCKED",
        "已有执行者持有锁。崩溃后请运行 recover-locks；不会自动抢锁。",
      );
    }
    return () => {
      this.db
        .prepare("DELETE FROM locks WHERE name=? AND owner=?")
        .run(name, owner);
    };
  }
  recoverLocks() {
    return this.tx(() => {
      let count = 0;
      for (const r of this.db.prepare("SELECT * FROM locks").all()) {
        try {
          process.kill(Number(r.pid), 0);
        } catch (e: any) {
          if (e.code === "ESRCH") {
            this.db
              .prepare("DELETE FROM locks WHERE name=?")
              .run(String(r.name));
            count++;
          }
        }
      }
      this.event(null, "LOCK_RECOVERY", { count });
      return count;
    });
  }
  events(): any[] {
    return this.db
      .prepare("SELECT * FROM events ORDER BY seq")
      .all()
      .map((r) => ({ ...r, detail: JSON.parse(String(r.detail)) }));
  }
}
