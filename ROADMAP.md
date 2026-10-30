# Roadmap

This roadmap separates shipped capabilities from the next acceptance work. It is not a promise of unattended operation.

## Current baseline

- Exact source identity, sourced facts, cached media, and price evidence.
- Catalog, brand, category, and authorization checks.
- Durable jobs, serialized publisher lock, draft save, independent read-back, submit, and unknown-outcome reconciliation.
- Local CLI and workbench with sanitized task, pricing, failure, and timing projections.
- Analytics-to-operations handoff that does not redefine publishing truth.

## Next priorities

1. Complete a reusable batch-readiness queue so known blockers are separated before execution.
2. Finish the unified resume path for jobs that need additional evidence after entering the queue.
3. Add category-by-category page adapters and controlled batch acceptance.
4. Connect complete order and rejection projections without mixing them with speculative demand.
5. Expand multi-account operations only through explicit, compliant session management and audited limits.

Every new adapter starts with a read-only or draft-only acceptance run. Do not use fixtures alone as proof that an external workflow is ready.
