---
name: hezi-pipeline
description: Operate this auditable source-to-supplier publishing workflow with Ego Browser.
---

Read `README.md`, `docs/architecture.md`, `docs/operations.md`, and `docs/recovery.md` before changing runtime behavior. Follow the currently installed Ego Browser skill for browser APIs.

This skill belongs to this repository. Keep new project skills under `.agents/skills/`; do not install them globally.

## Execution

1. Confirm whether the requested endpoint is read-only, draft, submit, or reconciliation. Do not infer broader authority.
2. Reuse the configured task space and page labels. Do not create a second browser or a new state directory to recover from a blocked page.
3. Capture and normalize the exact source SKU and selected sales variant before planning.
4. Verify current shop, brand, category, authorization validity, duplicate coverage, price evidence, assets, and class template.
5. Persist pending intent before any external write. After a write, reopen the original platform identity and compare normalized persisted state.
6. Treat an uncertain write as `UNKNOWN_OUTCOME`. Reconcile read-only; never create a replacement or repeat the write from a guess.
7. Keep submitted-for-review and on-sale as separate facts.

## Rules

- Never invent missing product facts, prices, stock, shelf life, packaging, model, origin, or authorization.
- Use only source evidence and explicit operator policy. A model may help with a bounded textual ambiguity, but cannot decide identity, price, authorization, media correctness, or publication status.
- Limit page actions and respect platform rate limits. Stop on login, verification, risk, policy interceptor, or user control. Do not bypass access controls.
- For rejected products, use the platform edit path and the original remote identity when available. Preserve the complete rejection reason.
- Keep credentials, cookies, browser profiles, `.hezi/`, SQLite state, orders, customers, and real operational exports out of Git.
- Report actual state and evidence coverage. A completed job is not proof of review approval or sale.

## Verification

Run `npm run build`, `npm test`, `npm run demo`, `node scripts/check-repository-policy.mjs`, and `npm run format:check`. For external-write changes, perform a controlled draft test and read-back before broader execution.
