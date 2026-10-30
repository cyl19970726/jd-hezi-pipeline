## Change

Describe the concrete behavior before and after this change. Link the issue when one exists.

## Acceptance evidence

- [ ] `npm run build`
- [ ] `npm test`
- [ ] `npm run demo` when CLI/runtime behavior changes
- [ ] Added or updated meaningful tests for changed behavior, or explained why inspection is sufficient

Paste a concise result or link to CI. For external workflows, include sanitized read-back evidence and state whether the run was simulated, read-only, draft-only, or submitted.

## Data, privacy, and operational risk

- [ ] No `.hezi/`, SQLite database, cookie/profile, customer/order data, raw research, private report, credential, or real business identifier is included
- [ ] New stored data has an explicit source, retention boundary, and redaction behavior
- [ ] External writes preserve pending intent, idempotency, read-back, and unknown-outcome reconciliation invariants
- [ ] Not applicable; explain why below

Risk notes:

## Migration and rollback

Describe schema/config migration, backward compatibility, deployment order, and a concrete rollback or recovery path. Write `None` only when no persisted or external state can change.

## Reviewer focus

Call out ownership boundaries, assumptions, and the smallest areas that need careful review.
