# Agent contribution contract

This repository automates a stateful external publishing workflow. Treat source identity, authorization, prices, media, persisted state, and external write outcomes as evidence-bearing data. Never fill an unknown value to make a workflow pass.

## Ownership and architecture

- `src/browser/` owns page adaptation and authenticated browser interaction. Credentials and cookies stay in the user's browser session.
- `src/store.ts` owns durable SQLite state. Schema changes require forward migration, compatibility notes, rollback notes, and representative tests.
- `src/engine.ts` and `src/worker.ts` own workflow transitions. Preserve pending intent before external writes, independent read-back after writes, and reconciliation for unknown outcomes.
- `src/analytics/` and `web/` may read and aggregate local facts. Analytics must not redefine operational truth, mutate publishing state, or expose private records by default.
- Tests mirror behavior under `test/`. Prefer focused regression coverage for changed invariants.
- Read `docs/architecture.md` before changing runtime boundaries.

## Data and privacy

Never commit `.hezi/`, SQLite databases or sidecars, browser profiles, cookies, credentials, customer or order records, raw shop research, private reports, real operational exports, or reversible business identifiers. Commit only fabricated fixtures or deliberately sanitized aggregate examples.

Do not place sensitive operational evidence in issues, pull requests, test snapshots, logs, or documentation. Use the minimum redacted evidence that proves behavior.

## Development workflow

Create a short-lived branch from `main`. Keep changes scoped and preserve unrelated work. For behavior changes, add a failing regression test when practical, implement the smallest coherent fix, then run:

```sh
npm run build
npm test
npm run demo
node scripts/check-repository-policy.mjs
npm run format:check
```

Open a pull request with observable behavior, acceptance evidence, privacy impact, external-write risk, migration, rollback, and unresolved limitations. Never bypass a failing safety check.

## Releases and recovery

Release from a reviewed green commit on `main`. Tag intentional versions and record schema/config changes and recovery steps. Back up operational SQLite state consistently before migration. Roll code back through Git; never roll external platform state backward by deleting records or repeating an uncertain write.
