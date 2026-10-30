import { z } from "zod";
import { digest, PipelineError } from "../model.js";
import type { OpportunityExecution } from "../opportunity-execution.js";
import type { AnalyticsStore } from "./core.js";

const snapshotSchema = z.object({
  candidateId: z.string().min(1),
  observationIds: z.array(z.string().min(1)).min(1).max(2),
});

const transferSchema = z.object({
  selections: z
    .array(
      z.object({
        id: z.string().min(1),
        revision: z.number().int().positive(),
        evidence: snapshotSchema,
      }),
    )
    .min(1)
    .max(50),
});

export type AnalyticsEvidenceSnapshot = z.infer<typeof snapshotSchema>;

type OperationalReader = () => {
  rows: Array<Record<string, any> & { opportunityId: string }>;
};

/**
 * Validates the analytics-side immutable revision and evidence snapshot before
 * handing the resolved identities to the existing operational ledger.
 */
export class AnalyticsOpportunityHandoff {
  constructor(
    private readonly analytics: AnalyticsStore,
    private readonly ledger: OpportunityExecution,
    private readonly shop: string,
    private readonly readOperational: OperationalReader,
  ) {}

  snapshot(candidateId: string): AnalyticsEvidenceSnapshot | null {
    const evidence = this.analytics.getEvidence(candidateId);
    if (!evidence) return null;
    return {
      candidateId,
      observationIds: [evidence.candidate.start, evidence.candidate.end]
        .filter((item): item is NonNullable<typeof item> => item !== null)
        .map((item) => item.id),
    };
  }

  transfer(input: unknown) {
    const { selections } = transferSchema.parse(input);
    if (new Set(selections.map((item) => item.id)).size !== selections.length)
      throw new PipelineError("NEEDS_INPUT", "转交机会不能重复");

    const resolved = selections.map((selection) => {
      const row: any = this.analytics.db
        .prepare("SELECT * FROM analytics_opportunities WHERE id=?")
        .get(selection.id);
      if (!row) throw new PipelineError("NEEDS_INPUT", "分析机会不存在");
      if (Number(row.revision) !== selection.revision)
        throw new PipelineError(
          "NEEDS_INPUT",
          "分析机会版本已更新，请刷新后重试",
        );
      const snapshot = this.snapshot(String(row.candidate_id));
      if (!snapshot)
        throw new PipelineError("NEEDS_INPUT", "分析机会缺少可冻结的市场证据");
      if (digest(snapshot) !== digest(selection.evidence))
        throw new PipelineError(
          "NEEDS_INPUT",
          "分析机会证据已更新或不属于所选机会",
        );
      const evidence = this.analytics.getEvidence(snapshot.candidateId)!;
      const candidate = evidence.candidate;
      if (!candidate.itemId || !candidate.shop || !candidate.skuId)
        throw new PipelineError(
          "NEEDS_INPUT",
          "分析证据缺少市场商品、店铺或销售SKU身份",
        );
      return {
        id: String(row.id),
        revision: Number(row.revision),
        updatedAt: String(row.updated_at),
        snapshot,
        candidate,
        rank: row.demand_rank === null ? null : Number(row.demand_rank),
      };
    });

    const requestIntentKey = digest({
      shop: this.shop,
      opportunities: resolved
        .slice()
        .sort((a, b) => a.id.localeCompare(b.id))
        .map((item) => this.transferPayload(item)),
    });
    return this.ledger.store.tx(() => {
      const existing = new Map<string, any>();
      const novel = [] as typeof resolved;
      for (const item of resolved) {
        const matches: any[] = this.ledger.store.db
          .prepare(
            `SELECT r.*,c.shop FROM opportunity_rows r
             JOIN opportunity_cohorts c ON c.cohort_key=r.cohort_key
             WHERE c.shop=? AND r.opportunity_id=? ORDER BY c.imported_at,r.id`,
          )
          .all(this.shop, item.id);
        if (!matches.length) {
          novel.push(item);
          continue;
        }
        if (
          matches.some(
            (row) =>
              String(row.market_item_id) !== item.candidate.itemId ||
              String(row.market_shop_id) !== item.candidate.shop ||
              String(row.market_sku_id) !== item.candidate.skuId,
          )
        )
          throw new PipelineError(
            "NEEDS_INPUT",
            "该分析机会存在多个不同的冻结市场身份，需要人工解决",
          );
        const payload = this.transferPayload(item);
        const bindings = matches.flatMap((row) =>
          this.ledger.store.db
            .prepare(
              "SELECT payload FROM opportunity_evidence WHERE row_id=? AND kind='analytics-transfer' ORDER BY observed_at,id",
            )
            .all(row.id),
        ) as Array<{ payload: string }>;
        if (
          bindings.some(
            (bound) =>
              digest(JSON.parse(String(bound.payload))) !== digest(payload),
          )
        )
          throw new PipelineError(
            "NEEDS_INPUT",
            "该分析机会已有不同版本或证据的转交记录，需要人工解决",
          );
        const jobIds = new Set(
          matches.map((row) => row.job_id).filter((id) => id !== null),
        );
        if (jobIds.size > 1 || (jobIds.size === 0 && matches.length > 1))
          throw new PipelineError(
            "NEEDS_INPUT",
            "该分析机会对应多个运营关系，需要人工对账后再转交",
          );
        const row =
          matches.find((candidate) => candidate.job_id !== null) ?? matches[0];
        existing.set(item.id, row);
      }

      const ordered = novel.slice().sort((a, b) => a.id.localeCompare(b.id));
      const frozen = ordered.map((item) => this.transferPayload(item));
      const intentHash = digest({ shop: this.shop, opportunities: frozen });
      const cohortKey = ordered.length ? `analytics-${intentHash}` : null;
      const importedAt = ordered
        .map((item) => item.updatedAt)
        .sort()
        .at(-1);
      const result = ordered.length
        ? this.ledger.importCohort({
            cohortKey: cohortKey!,
            shop: this.shop,
            sourceReportId: `analytics-opportunities-${intentHash}`,
            importedAt: importedAt!,
            rows: ordered.map((item, index) => ({
              opportunityId: item.id,
              marketItemId: item.candidate.itemId,
              marketShopId: item.candidate.shop,
              marketSkuId: item.candidate.skuId,
              rank: item.rank && item.rank > 0 ? item.rank : index + 1,
              targetSku: null,
              title: item.candidate.title,
              ...(item.candidate.brand ? { brand: item.candidate.brand } : {}),
              unit: item.candidate.saleUnit,
            })),
          })
        : {
            cohortKey: String([...existing.values()][0].cohort_key),
            reused: true,
            rowCount: 0,
          };
      const rows = new Map(existing);
      if (cohortKey)
        for (const row of this.ledger.rows(cohortKey))
          rows.set(row.opportunityId, row);
      for (const item of ordered) {
        const row = rows.get(item.id)!;
        const payload = this.transferPayload(item);
        const evidenceId = digest({
          rowId: row.id,
          kind: "analytics-transfer",
          observedAt: item.updatedAt,
          payload,
        });
        this.ledger.store.db
          .prepare(
            "INSERT OR IGNORE INTO opportunity_evidence(id,row_id,kind,observed_at,payload) VALUES(?,?,?,?,?)",
          )
          .run(
            evidenceId,
            row.id,
            "analytics-transfer",
            item.updatedAt,
            JSON.stringify(payload),
          );
      }
      // A pre-existing manifest row acquires the same immutable analytics
      // binding, but its operational identity and cohort remain untouched.
      for (const item of resolved.filter((candidate) =>
        existing.has(candidate.id),
      )) {
        const row = rows.get(item.id)!;
        const already: any = this.ledger.store.db
          .prepare(
            "SELECT 1 FROM opportunity_evidence WHERE row_id=? AND kind='analytics-transfer'",
          )
          .get(row.id);
        if (!already) this.bindTransferEvidence(row.id, item);
      }
      return {
        ...result,
        reused: ordered.length === 0 || result.reused,
        existingCount: existing.size,
        intentKey: requestIntentKey,
        cohortIds: [
          ...new Set(
            [...existing.values()]
              .map((row) => row.cohort_key)
              .concat(cohortKey ? [cohortKey] : []),
          ),
        ],
      };
    });
  }

  private transferPayload(item: {
    id: string;
    revision: number;
    snapshot: AnalyticsEvidenceSnapshot;
  }) {
    return {
      analyticsOpportunityId: item.id,
      revision: item.revision,
      evidence: item.snapshot,
    };
  }

  private bindTransferEvidence(
    rowId: string,
    item: {
      id: string;
      revision: number;
      updatedAt: string;
      snapshot: AnalyticsEvidenceSnapshot;
    },
  ) {
    const payload = this.transferPayload(item);
    const evidenceId = digest({
      rowId,
      kind: "analytics-transfer",
      observedAt: item.updatedAt,
      payload,
    });
    this.ledger.store.db
      .prepare(
        "INSERT OR IGNORE INTO opportunity_evidence(id,row_id,kind,observed_at,payload) VALUES(?,?,?,?,?)",
      )
      .run(
        evidenceId,
        rowId,
        "analytics-transfer",
        item.updatedAt,
        JSON.stringify(payload),
      );
  }

  project(opportunityIds: string[]) {
    const wanted = new Set(opportunityIds);
    const result = new Map<string, Record<string, unknown>>();
    const grouped = new Map<string, any[]>();
    for (const row of this.readOperational().rows) {
      if (!wanted.has(row.opportunityId)) continue;
      const rows = grouped.get(row.opportunityId) ?? [];
      rows.push(row);
      grouped.set(row.opportunityId, rows);
    }
    for (const [opportunityId, allRows] of grouped) {
      const bound = allRows.filter((row) => row.jobId || row.remoteId);
      const rows = bound.length ? bound : allRows;
      const components: any[][] = [];
      for (const row of rows) {
        const connected = components.filter((component) =>
          component.some(
            (other) =>
              (row.jobId && other.jobId === row.jobId) ||
              (row.remoteId && other.remoteId === row.remoteId),
          ),
        );
        if (!connected.length) components.push([row]);
        else {
          connected[0].push(row);
          for (const extra of connected.slice(1)) {
            connected[0].push(...extra);
            components.splice(components.indexOf(extra), 1);
          }
        }
      }
      if (components.length > 1) {
        result.set(opportunityId, {
          status: "CONFLICT",
          pending: true,
          needsReconciliation: true,
          cohortId: null,
          rowId: null,
          remoteId: null,
          jobId: null,
          updatedAt: null,
        });
        continue;
      }
      const component = components[0];
      const timestamp = (row: any) =>
        Date.parse(
          row.outcomeObservedAt ?? row.remoteObservedAt ?? row.updatedAt ?? "",
        );
      if (
        component.length > 1 &&
        component.some((row) => !Number.isFinite(timestamp(row)))
      ) {
        result.set(opportunityId, {
          status: "CONFLICT",
          pending: true,
          needsReconciliation: true,
          cohortId: null,
          rowId: null,
          remoteId: null,
          jobId: null,
          updatedAt: null,
        });
        continue;
      }
      component.sort((a, b) => timestamp(b) - timestamp(a));
      const row = component[0];
      if (
        component.length > 1 &&
        timestamp(component[0]) === timestamp(component[1]) &&
        component[0].status !== component[1].status
      ) {
        result.set(opportunityId, {
          status: "CONFLICT",
          pending: true,
          needsReconciliation: true,
          cohortId: null,
          rowId: null,
          remoteId: null,
          jobId: null,
          updatedAt: component[0].updatedAt ?? null,
        });
        continue;
      }
      const pending = ![
        "ON_SALE",
        "APPROVED",
        "SUBMITTED",
        "REJECTED",
        "CANCELLED",
        "EXISTING",
      ].includes(String(row.status));
      result.set(opportunityId, {
        cohortId: row.cohortId,
        rowId: row.id,
        status: row.status,
        pending,
        remoteId: row.remoteId ?? null,
        jobId: row.jobId ?? null,
        updatedAt: row.updatedAt,
      });
    }
    return result;
  }
}
