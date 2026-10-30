import { Store } from "./store.js";
import {
  digest,
  parseSku,
  productSchema,
  type Product,
  type Asset,
} from "./model.js";

export const JD_CAPTURE_PARSER = "jd-product-v2-regular-price";
export const DEFAULT_PRICE_FRESH_MS = 30 * 60 * 1000;
export const DEFAULT_PAGE_FRESH_MS = 10 * 60 * 1000;

export interface CaptureContext {
  shop: string;
  sku: string;
  source: "browser" | "android" | "discovery";
  parserVersion?: string;
  accountContext?: string;
  regionContext?: string;
}
export interface CapturePolicy {
  priceFreshMs?: number;
  pageFreshMs?: number;
  now?: number;
}
const key = (c: CaptureContext) => [
  c.shop,
  c.sku,
  c.source,
  c.parserVersion ?? JD_CAPTURE_PARSER,
];

const locallyDerivedFields = new Set([
  "规格",
  "类别",
  "包装名称",
  "包装数量",
  "加热器数量",
  "净含量",
  "总净含量",
  "香型",
  "商品毛重",
]);

function hasLocalRuleMarker(evidence: string) {
  return (
    /销售文字规则 sale-text\/\d+/.test(evidence) ||
    /jd-product-normalization\/\d+/.test(evidence) ||
    /标准化规则 normalization-v\d+/.test(evidence) ||
    evidence.includes("产品家族事实复用")
  );
}

function locallyDerivedFact(
  field: string,
  fact: { sourceUrl: string; evidence: string },
  product: Product,
) {
  return (
    locallyDerivedFields.has(field) &&
    fact.sourceUrl === product.url &&
    hasLocalRuleMarker(fact.evidence)
  );
}

/** Durable field-level JD state. This stores observations only and never replays requests. */
export class JdCaptureStore {
  constructor(readonly store: Store) {
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS jd_capture_checkpoints(shop TEXT NOT NULL,sku TEXT NOT NULL,source TEXT NOT NULL,parser_version TEXT NOT NULL,stage TEXT NOT NULL,product_json TEXT,missing_json TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(shop,sku,source,parser_version));
      CREATE TABLE IF NOT EXISTS jd_capture_facts(shop TEXT NOT NULL,sku TEXT NOT NULL,field TEXT NOT NULL,value_json TEXT NOT NULL,source_url TEXT NOT NULL,evidence TEXT NOT NULL,observed_at TEXT NOT NULL,parser_version TEXT NOT NULL,PRIMARY KEY(shop,sku,field));
      CREATE TABLE IF NOT EXISTS jd_price_snapshots(shop TEXT NOT NULL,sku TEXT NOT NULL,source TEXT NOT NULL,parser_version TEXT NOT NULL,basis TEXT NOT NULL,value TEXT NOT NULL,source_url TEXT NOT NULL,evidence TEXT NOT NULL,account_context TEXT NOT NULL,region_context TEXT NOT NULL,observed_at TEXT NOT NULL,PRIMARY KEY(shop,sku,source,parser_version));
      CREATE TABLE IF NOT EXISTS jd_page_observations(shop TEXT NOT NULL,sku TEXT NOT NULL,source TEXT NOT NULL,page_url TEXT NOT NULL,response_sku TEXT,account_context TEXT NOT NULL,region_context TEXT NOT NULL,observed_at TEXT NOT NULL,parser_version TEXT NOT NULL,PRIMARY KEY(shop,sku,source));
      CREATE TABLE IF NOT EXISTS jd_media_links(shop TEXT NOT NULL,sku TEXT NOT NULL,role TEXT NOT NULL,position INTEGER NOT NULL,source_url TEXT NOT NULL,original_sha256 TEXT,file_path TEXT,verified_at TEXT NOT NULL,PRIMARY KEY(shop,sku,role,position));
      CREATE TABLE IF NOT EXISTS jd_access_metrics(seq INTEGER PRIMARY KEY AUTOINCREMENT,shop TEXT NOT NULL,sku TEXT NOT NULL,source TEXT NOT NULL,stage TEXT NOT NULL,reason TEXT NOT NULL,navigations INTEGER NOT NULL DEFAULT 0,observable_requests INTEGER,downloads INTEGER NOT NULL DEFAULT 0,download_bytes INTEGER NOT NULL DEFAULT 0,cache_hits INTEGER NOT NULL DEFAULT 0,reused_fields INTEGER NOT NULL DEFAULT 0,duration_ms INTEGER,at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_jd_capture_metrics ON jd_access_metrics(shop,sku,at);
    `);
    const priceColumns = this.store.db
      .prepare("PRAGMA table_info(jd_price_snapshots)")
      .all()
      .map((row: any) => String(row.name));
    if (priceColumns.length && !priceColumns.includes("source")) {
      this.store.tx(() => {
        this.store.db.exec(`
          ALTER TABLE jd_price_snapshots RENAME TO jd_price_snapshots_legacy;
          CREATE TABLE jd_price_snapshots(shop TEXT NOT NULL,sku TEXT NOT NULL,source TEXT NOT NULL,parser_version TEXT NOT NULL,basis TEXT NOT NULL,value TEXT NOT NULL,source_url TEXT NOT NULL,evidence TEXT NOT NULL,account_context TEXT NOT NULL,region_context TEXT NOT NULL,observed_at TEXT NOT NULL,PRIMARY KEY(shop,sku,source,parser_version));
          INSERT INTO jd_price_snapshots(shop,sku,source,parser_version,basis,value,source_url,evidence,account_context,region_context,observed_at)
            SELECT shop,sku,'legacy-unknown',parser_version,basis,value,source_url,evidence,account_context,region_context,observed_at FROM jd_price_snapshots_legacy;
          DROP TABLE jd_price_snapshots_legacy;
        `);
      });
    }
  }
  saveProduct(c: CaptureContext, product: Product, stage = "facts") {
    if (product.sku !== c.sku || parseSku(product.url) !== c.sku)
      throw Error("采集检查点SKU身份不一致");
    const parsed = productSchema.parse(product),
      missing = captureMissing(parsed),
      parser = c.parserVersion ?? JD_CAPTURE_PARSER;
    const observedFacts = [
      ["title", parsed.title],
      ...Object.entries(parsed.specs).filter(
        ([field, fact]) => !locallyDerivedFact(field, fact, parsed),
      ),
    ] as [string, typeof parsed.title][];
    for (const [field, fact] of observedFacts) {
      const prior: any = this.store.db
        .prepare(
          "SELECT value_json,source_url,evidence FROM jd_capture_facts WHERE shop=? AND sku=? AND field=?",
        )
        .get(c.shop, c.sku, field);
      if (
        prior &&
        !locallyDerivedFact(
          field,
          {
            sourceUrl: String(prior.source_url ?? ""),
            evidence: String(prior.evidence),
          },
          parsed,
        ) &&
        JSON.parse(String(prior.value_json)) !== fact.value
      )
        throw Error(`京东字段来源冲突，停止复用：${field}`);
    }
    for (const asset of parsed.assets) {
      const prior: any = this.store.db
        .prepare(
          "SELECT original_sha256 FROM jd_media_links WHERE shop=? AND sku=? AND role=? AND position=?",
        )
        .get(c.shop, c.sku, asset.role, asset.order);
      if (
        prior?.original_sha256 &&
        asset.originalSha256 &&
        prior.original_sha256 !== asset.originalSha256
      )
        throw Error(
          `京东原图内容冲突，停止复用：${asset.role}[${asset.order}]`,
        );
    }
    const storedFacts = this.store.db
      .prepare("SELECT * FROM jd_capture_facts WHERE shop=? AND sku=?")
      .all(c.shop, c.sku) as any[];
    const derivedRows = storedFacts.filter((row) =>
      locallyDerivedFact(
        String(row.field),
        {
          sourceUrl: String(row.source_url),
          evidence: String(row.evidence),
        },
        parsed,
      ),
    );
    this.store.tx(() => {
      for (const row of derivedRows)
        this.store.db
          .prepare(
            "DELETE FROM jd_capture_facts WHERE shop=? AND sku=? AND field=?",
          )
          .run(c.shop, c.sku, row.field);
      if (derivedRows.length)
        this.store.event(null, "JD_DERIVED_FACTS_PRUNED", {
          shop: c.shop,
          sku: c.sku,
          facts: derivedRows.map((row) => ({
            field: row.field,
            value: JSON.parse(String(row.value_json)),
            sourceUrl: row.source_url,
            evidence: row.evidence,
            observedAt: row.observed_at,
            parserVersion: row.parser_version,
          })),
        });
      this.store.db
        .prepare(
          `INSERT INTO jd_capture_checkpoints VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(shop,sku,source,parser_version) DO UPDATE SET stage=excluded.stage,product_json=excluded.product_json,missing_json=excluded.missing_json,updated_at=excluded.updated_at`,
        )
        .run(
          ...key(c),
          stage,
          JSON.stringify(parsed),
          JSON.stringify(missing),
          parsed.capturedAt,
        );
      for (const [field, fact] of observedFacts)
        this.store.db
          .prepare(
            `INSERT INTO jd_capture_facts VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(shop,sku,field) DO UPDATE SET value_json=excluded.value_json,source_url=excluded.source_url,evidence=excluded.evidence,observed_at=excluded.observed_at,parser_version=excluded.parser_version`,
          )
          .run(
            c.shop,
            c.sku,
            field,
            JSON.stringify(fact.value),
            fact.sourceUrl,
            fact.evidence,
            fact.capturedAt,
            parser,
          );
      // Partial facts, normalization and media do not observe a new quote.
      // Preserve its original account/region provenance instead of relabeling it.
      if (parsed.price?.basis && (stage === "facts" || stage === "price"))
        this.store.db
          .prepare(
            `INSERT INTO jd_price_snapshots VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(shop,sku,source,parser_version) DO UPDATE SET basis=excluded.basis,value=excluded.value,source_url=excluded.source_url,evidence=excluded.evidence,account_context=excluded.account_context,region_context=excluded.region_context,observed_at=excluded.observed_at`,
          )
          .run(
            c.shop,
            c.sku,
            c.source,
            parser,
            parsed.price.basis,
            parsed.price.value,
            parsed.price.sourceUrl,
            parsed.price.evidence,
            c.accountContext ?? "",
            c.regionContext ?? "",
            parsed.price.capturedAt,
          );
      for (const asset of parsed.assets)
        this.saveMedia(c, asset, parsed.capturedAt);
    });
    return { missing };
  }
  /** Stable facts may be reused independently of the short-lived quote. */
  facts(c: CaptureContext): Product | null {
    const row: any = this.store.db
      .prepare(
        "SELECT product_json FROM jd_capture_checkpoints WHERE shop=? AND sku=? AND source=? AND parser_version=?",
      )
      .get(...key(c));
    if (!row?.product_json) return null;
    const product = productSchema.parse(JSON.parse(String(row.product_json)));
    const observed = Date.parse(product.capturedAt);
    if (
      product.sku !== c.sku ||
      parseSku(product.url) !== c.sku ||
      !Number.isFinite(observed) ||
      observed > Date.now()
    )
      return null;
    return product;
  }
  product(c: CaptureContext, policy: CapturePolicy = {}): Product | null {
    const product = this.facts(c);
    if (!product || (product.price && !this.price(c, policy, product.price)))
      return null;
    return product;
  }
  /** Evidence of a finished collection attempt, NOT proof that a missing field exists.
   * Used only to stop an identical whole-page retry and route to local preparation.
   * It never authorizes quote reuse or asserts that every source region was complete.
   */
  observedProduct(c: CaptureContext, product: Product): boolean {
    const row: any = this.store.db
      .prepare(
        "SELECT product_json FROM jd_capture_checkpoints WHERE shop=? AND sku=? AND source=? AND parser_version=?",
      )
      .get(...key(c));
    if (!row?.product_json) return false;
    let parsed: unknown;
    try {
      parsed = JSON.parse(String(row.product_json));
    } catch {
      return false;
    }
    const prior = productSchema.safeParse(parsed);
    if (!prior.success) return false;
    const p = prior.data;
    const observedAt = Date.parse(p.capturedAt);
    return (
      Number.isFinite(observedAt) &&
      observedAt <= Date.now() &&
      p.sku === product.sku &&
      p.url === product.url &&
      p.variant === product.variant &&
      p.capturedAt === product.capturedAt &&
      digest(p) === digest(product)
    );
  }
  price(
    c: CaptureContext,
    policy: CapturePolicy = {},
    embedded?: Product["price"],
  ) {
    if (!c.accountContext || !c.regionContext) return null;
    const row: any = this.store.db
      .prepare(
        "SELECT * FROM jd_price_snapshots WHERE shop=? AND sku=? AND source=? AND parser_version=?",
      )
      .get(...key(c));
    if (
      !row ||
      row.account_context !== (c.accountContext ?? "") ||
      row.region_context !== (c.regionContext ?? "")
    )
      return null;
    const age =
      (policy.now ?? Date.now()) - Date.parse(String(row.observed_at));
    if (age < 0 || age > (policy.priceFreshMs ?? DEFAULT_PRICE_FRESH_MS))
      return null;
    if (
      embedded &&
      (embedded.value !== row.value ||
        embedded.basis !== row.basis ||
        embedded.sourceUrl !== row.source_url ||
        embedded.evidence !== row.evidence ||
        embedded.capturedAt !== row.observed_at)
    )
      return null;
    return {
      value: row.value,
      basis: row.basis,
      sourceUrl: row.source_url,
      evidence: row.evidence,
      capturedAt: row.observed_at,
    };
  }
  observePage(
    c: CaptureContext,
    pageUrl: string,
    responseSku: string | null,
    observedAt = new Date().toISOString(),
  ) {
    if (
      parseSku(pageUrl) !== c.sku ||
      (responseSku !== null && responseSku !== c.sku)
    )
      throw Error("页面观察SKU身份不一致");
    this.store.db
      .prepare(
        `INSERT INTO jd_page_observations VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(shop,sku,source) DO UPDATE SET page_url=excluded.page_url,response_sku=excluded.response_sku,account_context=excluded.account_context,region_context=excluded.region_context,observed_at=excluded.observed_at,parser_version=excluded.parser_version`,
      )
      .run(
        c.shop,
        c.sku,
        c.source,
        pageUrl,
        responseSku,
        c.accountContext ?? "",
        c.regionContext ?? "",
        observedAt,
        c.parserVersion ?? JD_CAPTURE_PARSER,
      );
  }
  reusablePage(c: CaptureContext, pageUrl: string, policy: CapturePolicy = {}) {
    const row: any = this.store.db
      .prepare(
        "SELECT * FROM jd_page_observations WHERE shop=? AND sku=? AND source=?",
      )
      .get(c.shop, c.sku, c.source);
    if (
      !row ||
      row.page_url !== pageUrl ||
      parseSku(pageUrl) !== c.sku ||
      row.response_sku !== c.sku ||
      row.parser_version !== (c.parserVersion ?? JD_CAPTURE_PARSER) ||
      row.account_context !== (c.accountContext ?? "") ||
      row.region_context !== (c.regionContext ?? "")
    )
      return false;
    const age =
      (policy.now ?? Date.now()) - Date.parse(String(row.observed_at));
    return age >= 0 && age <= (policy.pageFreshMs ?? DEFAULT_PAGE_FRESH_MS);
  }
  private saveMedia(c: CaptureContext, asset: Asset, at: string) {
    this.store.db
      .prepare(
        `INSERT INTO jd_media_links VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(shop,sku,role,position) DO UPDATE SET source_url=excluded.source_url,original_sha256=excluded.original_sha256,file_path=excluded.file_path,verified_at=excluded.verified_at`,
      )
      .run(
        c.shop,
        c.sku,
        asset.role,
        asset.order,
        asset.url,
        asset.originalSha256 ?? null,
        asset.originalPath ?? null,
        at,
      );
  }
  metric(
    c: CaptureContext,
    value: {
      stage: string;
      reason: string;
      navigations?: number;
      observableRequests?: number | null;
      downloads?: number;
      downloadBytes?: number;
      cacheHits?: number;
      reusedFields?: number;
      durationMs?: number | null;
    },
  ) {
    this.store.db
      .prepare(
        "INSERT INTO jd_access_metrics(shop,sku,source,stage,reason,navigations,observable_requests,downloads,download_bytes,cache_hits,reused_fields,duration_ms,at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        c.shop,
        c.sku,
        c.source,
        value.stage,
        value.reason,
        value.navigations ?? 0,
        value.observableRequests ?? null,
        value.downloads ?? 0,
        value.downloadBytes ?? 0,
        value.cacheHits ?? 0,
        value.reusedFields ?? 0,
        value.durationMs ?? null,
        new Date().toISOString(),
      );
  }
}
export function captureMissing(product: Product) {
  const missing: string[] = [];
  if (!product.price?.basis) missing.push("price");
  if (!Object.keys(product.specs).length) missing.push("specs");
  if (!product.assets.some((a) => a.role === "main"))
    missing.push("main-media");
  if (!product.assets.some((a) => a.role === "detail"))
    missing.push("detail-media");
  return missing;
}
