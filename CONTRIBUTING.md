# Contributing

Contributions should preserve source evidence, stable identity, authorization freshness, media mapping, pending-after-write recovery, and independent read-back.

## Setup

```sh
npm ci
npm run build
npm test
npm run demo
node scripts/check-repository-policy.mjs
npm run format:check
```

## Pull requests

Use a short-lived branch and one coherent outcome. Describe:

- observable behavior before and after;
- focused tests or exact manual evidence;
- whether the change affects local state, schema, browser automation, or external writes;
- migration and rollback;
- privacy impact and whether any sample is fabricated.

Do not include real store names, platform IDs, SKU receipts, customer/order data, private reports, browser state, credentials, or operational logs.

## Scope

New class-specific behavior needs a source-backed fixture and a focused regression test. New categories need a real template acceptance run before batch use. Page selectors should fail closed when structure, login, store identity, or risk state is unknown.

Security reports belong in private GitHub Security Advisories. See [SECURITY.md](SECURITY.md).
