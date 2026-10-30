import { Store } from "./store.js";
import { PipelineError, type RemoteRecord } from "./model.js";

export interface SourceAbsenceProof {
  scanId: number;
  shop: string;
  sku: string;
  startedAt: string;
  finishedAt: string;
  coverage: { partition: string; expected: number; seen: number }[];
  itemCount: number;
}
export interface SourceScanCheckpoint {
  partition: string;
  expected: number | null;
  pages: number | null;
  nextPage: number;
  seen: string[];
  page: {
    number: number;
    total: number;
    pages: number;
    items: any[];
    nextDetail: number;
  } | null;
  complete: boolean;
}
export class SourceIndex {
  constructor(readonly store: Store) {
    store.db.exec(
      `CREATE TABLE IF NOT EXISTS source_scans(id INTEGER PRIMARY KEY AUTOINCREMENT,shop TEXT NOT NULL,started_at TEXT NOT NULL,finished_at TEXT,status TEXT NOT NULL,coverage TEXT NOT NULL);CREATE TABLE IF NOT EXISTS source_items(shop TEXT NOT NULL,item_id TEXT NOT NULL,revision TEXT NOT NULL,record TEXT NOT NULL,skus TEXT NOT NULL,resolved INTEGER NOT NULL,scan_id INTEGER NOT NULL REFERENCES source_scans(id),PRIMARY KEY(shop,item_id));CREATE TABLE IF NOT EXISTS source_scan_checkpoints(scan_id INTEGER NOT NULL REFERENCES source_scans(id),partition TEXT NOT NULL,checkpoint TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(scan_id,partition));`,
    );
  }
  begin(shop: string) {
    return Number(
      this.store.db
        .prepare(
          "INSERT INTO source_scans(shop,started_at,status,coverage) VALUES(?,?,'running','[]')",
        )
        .run(shop, new Date().toISOString()).lastInsertRowid,
    );
  }
  beginOrResume(shop: string, now = Date.now()) {
    const row: any = this.store.db
      .prepare(
        "SELECT id,started_at FROM source_scans WHERE shop=? AND status='running' ORDER BY id DESC LIMIT 1",
      )
      .get(shop);
    const resumable =
      row &&
      Number.isFinite(Date.parse(String(row.started_at))) &&
      now - Date.parse(String(row.started_at)) >= 0 &&
      now - Date.parse(String(row.started_at)) < 20 * 60 * 60 * 1000;
    if (row && !resumable) {
      this.store.db
        .prepare(
          "UPDATE source_scans SET status='partial',finished_at=? WHERE id=?",
        )
        .run(new Date(now).toISOString(), row.id);
      throw Error("来源扫描已超过新鲜度边界；旧扫描已终止，请重新执行");
    }
    return resumable
      ? { scan: Number(row.id), resumed: true }
      : { scan: this.begin(shop), resumed: false };
  }
  checkpoint(scan: number, partition: string): SourceScanCheckpoint | null {
    const row: any = this.store.db
      .prepare(
        "SELECT checkpoint FROM source_scan_checkpoints WHERE scan_id=? AND partition=?",
      )
      .get(scan, partition);
    if (!row) return null;
    try {
      const value = JSON.parse(String(row.checkpoint));
      if (
        value?.partition !== partition ||
        !Array.isArray(value.seen) ||
        value.seen.some((id: unknown) => typeof id !== "string" || !id) ||
        new Set(value.seen).size !== value.seen.length ||
        !Number.isInteger(value.nextPage) ||
        value.nextPage < 1 ||
        (value.expected !== null &&
          (!Number.isInteger(value.expected) || value.expected < 0)) ||
        (value.pages !== null &&
          (!Number.isInteger(value.pages) || value.pages < 0)) ||
        (value.complete &&
          (value.expected === null ||
            value.pages === null ||
            value.page !== null ||
            value.nextPage <= value.pages ||
            value.seen.length !== value.expected))
      )
        throw Error("来源扫描检查点损坏");
      return value;
    } catch {
      throw Error("来源扫描检查点损坏");
    }
  }
  saveCheckpoint(scan: number, checkpoint: SourceScanCheckpoint) {
    this.store.db
      .prepare(
        `INSERT INTO source_scan_checkpoints VALUES(?,?,?,?)
         ON CONFLICT(scan_id,partition) DO UPDATE SET checkpoint=excluded.checkpoint,updated_at=excluded.updated_at`,
      )
      .run(
        scan,
        checkpoint.partition,
        JSON.stringify(checkpoint),
        new Date().toISOString(),
      );
  }
  cached(shop: string, itemId: string, revision: string) {
    if (!revision) return null;
    const r = this.store.db
      .prepare(
        "SELECT * FROM source_items WHERE shop=? AND item_id=? AND revision=? AND resolved=1",
      )
      .get(shop, itemId, revision);
    return r ? (JSON.parse(String(r.skus)) as string[]) : null;
  }
  put(
    scan: number,
    shop: string,
    record: RemoteRecord,
    revision: string,
    skus: string[],
    resolved: boolean,
  ) {
    this.store.db
      .prepare(
        "INSERT INTO source_items VALUES(?,?,?,?,?,?,?) ON CONFLICT(shop,item_id) DO UPDATE SET revision=excluded.revision,record=excluded.record,skus=excluded.skus,resolved=excluded.resolved,scan_id=excluded.scan_id WHERE excluded.scan_id >= source_items.scan_id",
      )
      .run(
        shop,
        record.itemId,
        revision,
        JSON.stringify(record),
        JSON.stringify([...new Set(skus)]),
        Number(resolved),
        scan,
      );
  }
  finish(
    scan: number,
    coverage: { partition: string; expected: number; seen: number }[],
    failed = false,
  ) {
    const complete =
      !failed &&
      coverage.length === 4 &&
      [
        "visible-normal",
        "visible-draft",
        "hidden-normal",
        "hidden-draft",
      ].every((p) => coverage.some((c) => c.partition === p)) &&
      new Set(coverage.map((c) => c.partition)).size === 4 &&
      coverage.every((c) => c.expected === c.seen) &&
      Number(
        this.store.db
          .prepare("SELECT COUNT(*) AS n FROM source_items WHERE scan_id=?")
          .get(scan)?.n,
      ) ===
        coverage
          .filter((c) => c.partition.endsWith("-normal"))
          .reduce((n, c) => n + c.seen, 0) &&
      !this.store.db
        .prepare("SELECT 1 FROM source_items WHERE scan_id=? AND resolved=0")
        .get(scan);
    this.store.db
      .prepare(
        "UPDATE source_scans SET status=?,coverage=?,finished_at=? WHERE id=?",
      )
      .run(
        complete ? "complete" : "partial",
        JSON.stringify(coverage),
        new Date().toISOString(),
        scan,
      );
    return complete;
  }
  lookup(shop: string, sku: string) {
    return this.lookupMany(shop, [sku]).get(sku)!;
  }
  proveAbsent(
    scanId: number,
    shop: string,
    sku: string,
    after: string,
    now = Date.now(),
  ): SourceAbsenceProof {
    const scan: any = this.store.db
      .prepare("SELECT * FROM source_scans WHERE id=? AND shop=?")
      .get(scanId, shop);
    const latest: any = this.store.db
      .prepare(
        "SELECT id FROM source_scans WHERE shop=? ORDER BY id DESC LIMIT 1",
      )
      .get(shop);
    const started = Date.parse(String(scan?.started_at));
    const finished = Date.parse(String(scan?.finished_at));
    const boundary = Date.parse(after);
    if (
      !scan ||
      latest?.id !== scanId ||
      scan.status !== "complete" ||
      !Number.isFinite(started) ||
      !Number.isFinite(finished) ||
      !Number.isFinite(boundary) ||
      started <= boundary ||
      finished < started ||
      finished > now
    )
      throw new PipelineError(
        "UNKNOWN_OUTCOME",
        "指定来源扫描不是写入失败后的最新完整观察",
      );
    let coverage: SourceAbsenceProof["coverage"];
    try {
      coverage = JSON.parse(String(scan.coverage));
    } catch {
      coverage = [];
    }
    const partitions = [
      "visible-normal",
      "visible-draft",
      "hidden-normal",
      "hidden-draft",
    ];
    if (
      !Array.isArray(coverage) ||
      coverage.length !== 4 ||
      new Set(coverage.map((entry) => entry?.partition)).size !== 4 ||
      !partitions.every((partition) =>
        coverage.some((entry) => entry?.partition === partition),
      ) ||
      coverage.some(
        (entry) =>
          !Number.isInteger(entry?.expected) ||
          entry.expected < 0 ||
          entry.seen !== entry.expected,
      )
    )
      throw new PipelineError("UNKNOWN_OUTCOME", "指定来源扫描覆盖不完整");
    const rows: any[] = this.store.db
      .prepare("SELECT * FROM source_items WHERE shop=? AND scan_id=?")
      .all(shop, scanId);
    const expectedItems = coverage
      .filter((entry) => entry.partition.endsWith("-normal"))
      .reduce((sum, entry) => sum + entry.expected, 0);
    let matches = 0;
    try {
      for (const row of rows) {
        const record = JSON.parse(String(row.record));
        const skus = JSON.parse(String(row.skus));
        if (
          row.resolved !== 1 ||
          record?.shop !== shop ||
          String(record?.itemId) !== String(row.item_id) ||
          !Array.isArray(skus) ||
          skus.some((value) => !/^\d+$/.test(String(value))) ||
          new Set(skus).size !== skus.length
        )
          throw new Error("invalid source item");
        matches += skus.filter((value) => String(value) === sku).length;
      }
    } catch {
      throw new PipelineError(
        "UNKNOWN_OUTCOME",
        "指定来源扫描含未解析或身份无效的商品",
      );
    }
    if (rows.length !== expectedItems)
      throw new PipelineError(
        "UNKNOWN_OUTCOME",
        "指定来源扫描条数与覆盖不一致",
      );
    if (matches !== 0)
      throw new PipelineError(
        "UNKNOWN_OUTCOME",
        "指定来源扫描已发现目标SKU，不能确认写入未发生",
      );
    return {
      scanId,
      shop,
      sku,
      startedAt: String(scan.started_at),
      finishedAt: String(scan.finished_at),
      coverage,
      itemCount: rows.length,
    };
  }
  lookupMany(shop: string, skus: string[]) {
    const scan = this.store.db
      .prepare(
        "SELECT * FROM source_scans WHERE shop=? ORDER BY id DESC LIMIT 1",
      )
      .get(shop);
    if (
      !scan ||
      scan.status !== "complete" ||
      Date.now() - Date.parse(String(scan.started_at)) > 86400000
    )
      throw new PipelineError(
        "NEEDS_INPUT",
        "全店来源索引尚未完整同步或已过期",
      );
    const rows = this.store.db
      .prepare("SELECT * FROM source_items WHERE shop=? AND scan_id=?")
      .all(shop, scan.id);
    const result = new Map<string, RemoteRecord[]>(
      [...new Set(skus)].map((sku) => [sku, []]),
    );
    for (const row of rows) {
      const matches = (JSON.parse(String(row.skus)) as string[]).filter((sku) =>
        result.has(sku),
      );
      if (!matches.length) continue;
      const record = JSON.parse(String(row.record));
      for (const sku of matches) result.get(sku)!.push({ ...record, sku });
    }
    return result;
  }
}
