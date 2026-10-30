export type Coverage = "complete" | "partial";

export interface CollectionRunInput {
  id: string;
  source: string;
  observedAt: string;
  coverage: Coverage;
  expectedCount?: number;
}

export interface ObservationInput {
  platform: string;
  shop: string;
  itemId: string;
  skuId: string;
  title: string;
  brand?: string | null;
  category?: string | null;
  packaging?: string | null;
  saleUnit: string;
  sourceEntry: string;
  field: string;
  fieldVersion: string;
  semanticsVersion: string;
  currency: string;
  value: number;
  priceMinor?: number | null;
  sourceEventAt?: string | null;
  raw?: unknown;
}

export interface ImportResult {
  runId: string;
  received: number;
  inserted: number;
  duplicates: number;
  conflicts: number;
  rejected: number;
  status: "accepted" | "needs-review";
}

export type ComparisonStatus = "comparable" | "incomparable" | "anomalous";
export type MarketScope = "recent" | "historical";

export interface MarketQuery {
  scope: MarketScope;
  page?: number;
  pageSize?: number;
  startAt?: string;
  endAt?: string;
  toleranceMs?: number;
  coverage?: Coverage | "all";
  platform?: string;
  shop?: string;
  brand?: string;
  category?: string;
  saleUnit?: string;
  sourceEntry?: string;
  status?: ComparisonStatus;
  search?: string;
  minPriceMinor?: number;
  maxPriceMinor?: number;
}

export interface ObservationEvidence {
  id: string;
  runId: string;
  observedAt: string;
  value: number;
  priceMinor: number | null;
  sourceEventAt: string | null;
  raw: unknown;
  coverage: Coverage;
}

export interface MarketCandidate {
  id: string;
  platform: string;
  shop: string;
  itemId: string;
  skuId: string;
  title: string;
  brand: string | null;
  category: string | null;
  packaging: string | null;
  saleUnit: string;
  sourceEntry: string;
  field: string;
  fieldVersion: string;
  semanticsVersion: string;
  currency: string;
  scope: MarketScope;
  status: ComparisonStatus;
  reason: string | null;
  start: ObservationEvidence | null;
  end: ObservationEvidence;
  delta: number | null;
  valueIndexMinor: number | null;
  coverage: Coverage;
  sampleScope: string | null;
  evidencePath: string | null;
}

export interface Page<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
  pages: number;
  available: boolean;
  unavailableReason?: string;
  facets?: Record<
    string,
    Array<{
      value: string;
      count: number;
      percent: number;
      denominator: number;
    }>
  >;
}

export interface EvidenceResult {
  candidate: MarketCandidate;
  observations: ObservationEvidence[];
  conflicts: Array<{
    id: string;
    runId: string;
    detectedAt: string;
    incoming: unknown;
  }>;
}

export type OpportunityRoute = "prepare" | "bd" | "maintain" | "review";
export type OpportunityStatus = "open" | "selected" | "paused" | "completed";

export interface OpportunityQuery {
  page?: number;
  pageSize?: number;
  brand?: string;
  route?: OpportunityRoute;
  status?: OpportunityStatus;
  search?: string;
}

export interface Opportunity {
  id: string;
  identityKey: string;
  candidateId: string;
  brand: string | null;
  route: OpportunityRoute;
  status: OpportunityStatus;
  owner: string | null;
  nextAction: string;
  reason: string;
  demandRank: number | null;
  authorizationStatus: "verified" | "historical" | "missing" | "needs-review";
  ownMatchStatus: "none" | "exact" | "candidate" | "needs-review";
  decisionId: string | null;
  revision: number;
  updatedAt: string;
}

export type OpportunityPatch = Partial<
  Pick<
    Opportunity,
    "route" | "status" | "owner" | "nextAction" | "reason" | "decisionId"
  >
> & { expectedRevision?: number };

export interface OpportunitySeed {
  brand?: string | null;
  route: OpportunityRoute;
  status?: OpportunityStatus;
  owner?: string | null;
  nextAction: string;
  reason: string;
  demandRank?: number | null;
  authorizationStatus: Opportunity["authorizationStatus"];
  ownMatchStatus: Opportunity["ownMatchStatus"];
  decisionId?: string | null;
}

export interface BrandTaskPatch {
  status?:
    | "pending"
    | "contacting"
    | "materials"
    | "verification"
    | "usable"
    | "expired";
  owner?: string | null;
  nextFollowUpAt?: string | null;
  resultReason?: string | null;
  scope?: string | null;
  authorizationValidUntil?: string | null;
  authorizationVerifiedAt?: string | null;
  identitySource?: "api" | "title" | "single-brand-shop" | "manual" | "unknown";
  identityVerified?: boolean;
}

export interface BrandAuthorizationProjection {
  scope: string;
  validUntil: string;
  verifiedAt: string;
  source: "platform";
  sourceRef: string;
}

export interface BrandSummary extends BrandTaskPatch {
  brand: string;
  opportunityCount: number;
  unlockableCount: number;
  readiness:
    "ready" | "needs-identity-review" | "needs-authorization" | "expired";
  updatedAt: string | null;
}

export interface AnalyticsHealth {
  status: "ok" | "needs-review" | "empty";
  runs: number;
  completeRuns: number;
  partialRuns: number;
  observations: number;
  conflicts: number;
  latestObservedAt: string | null;
}

export interface AnalyticsOverview {
  marketCandidates: number;
  recentComparable: number | null;
  recentAnomalous: number | null;
  opportunities: number;
  readyOpportunities: number;
  bdOpportunities: number;
  brandsNeedingAction: number;
}
