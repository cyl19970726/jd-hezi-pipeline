import { Catalog } from "./catalog.js";
import { PipelineError, type RemoteRecord } from "./model.js";
import { SourceIndex } from "./source-index.js";
import type { Store } from "./store.js";

export interface OperationalReadinessInput {
  shop: string;
  brand?: { id: string; name: string } | null;
  category?: { id: string; path: string } | null;
  sourceSku?: string | null;
  hints?: { brandName?: string | null; categoryPath?: string | null };
}

export interface OperationalReadinessOptions {
  now?: number;
  catalogMaxAgeMs?: number;
}

export type OperationalReadinessResult = ReturnType<
  OperationalReadiness["evaluate"]
>;

/**
 * Read-only projection for the two operational checks shared by analytics and
 * opportunity execution. It deliberately does not imply price, preparation or
 * publish readiness.
 */
export class OperationalReadiness {
  private readonly catalog: Catalog;
  private readonly sources: SourceIndex;

  constructor(
    store: Store,
    authorities: { catalog?: Catalog; sources?: SourceIndex } = {},
  ) {
    this.catalog = authorities.catalog ?? new Catalog(store);
    this.sources = authorities.sources ?? new SourceIndex(store);
  }

  evaluate(
    input: OperationalReadinessInput,
    options: OperationalReadinessOptions = {},
  ) {
    const reasons: string[] = [];
    const now = options.now ?? Date.now();
    let authorization:
      | {
          status: "authorized";
          grantId: string;
          brandId: string;
          categoryId: string;
          checkedAt: string;
        }
      | { status: "blocked" | "needs-input"; reason: string };

    if (!input.brand?.id || !input.brand.name) {
      authorization = {
        status: "needs-input",
        reason: "缺少供应商目录品牌 ID 或名称",
      };
    } else if (!input.category?.id || !input.category.path) {
      authorization = {
        status: "needs-input",
        reason: "缺少供应商目录类目 ID 或路径",
      };
    } else {
      try {
        authorization = {
          status: "authorized",
          ...this.catalog.authorize(
            {
              shop: input.shop,
              brand: input.brand.name,
              categoryPath: input.category.path,
              catalogBinding: {
                brandId: input.brand.id,
                categoryId: input.category.id,
              },
            },
            now,
            options.catalogMaxAgeMs,
          ),
        };
      } catch (error) {
        authorization = {
          status:
            error instanceof PipelineError && error.code === "BUSINESS_BLOCKED"
              ? "blocked"
              : "needs-input",
          reason: error instanceof Error ? error.message : String(error),
        };
      }
    }
    if (authorization.status !== "authorized")
      reasons.push(authorization.reason);

    let sourceDuplicate:
      | {
          status: "clear" | "duplicate";
          sourceSku: string;
          matches: RemoteRecord[];
        }
      | { status: "needs-input"; sourceSku: string | null; reason: string };
    if (!input.sourceSku) {
      sourceDuplicate = {
        status: "needs-input",
        sourceSku: null,
        reason: "缺少精确供应来源 SKU，尚未查重",
      };
    } else {
      try {
        const matches = this.sources.lookup(input.shop, input.sourceSku);
        sourceDuplicate = {
          status: matches.length ? "duplicate" : "clear",
          sourceSku: input.sourceSku,
          matches,
        };
      } catch (error) {
        sourceDuplicate = {
          status: "needs-input",
          sourceSku: input.sourceSku,
          reason: error instanceof Error ? error.message : String(error),
        };
      }
    }
    if (sourceDuplicate.status === "needs-input")
      reasons.push(sourceDuplicate.reason);
    else if (sourceDuplicate.status === "duplicate")
      reasons.push("本店来源索引已有相同供应 SKU");

    const ready =
      authorization.status === "authorized" &&
      sourceDuplicate.status === "clear";
    return {
      scope: "authorization-and-exact-source-duplicate" as const,
      projectedAt: new Date(now).toISOString(),
      hints: {
        brandName: input.hints?.brandName ?? null,
        categoryPath: input.hints?.categoryPath ?? null,
        authority: "preliminary-name-hints-only" as const,
      },
      authorization,
      sourceDuplicate,
      eligibility: {
        ready,
        status: ready
          ? ("ready" as const)
          : authorization.status === "blocked" ||
              sourceDuplicate.status === "duplicate"
            ? ("blocked" as const)
            : ("needs-input" as const),
        reasons,
        nextChecks: [
          "source-facts",
          "price",
          "preparation",
          "publish-preflight",
        ],
      },
    };
  }
}
