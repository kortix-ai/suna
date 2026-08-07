# Centralized audit v2 implementation plan

Spec: `docs/specs/2026-08-07-centralized-audit-v2.md`

1. Add RED database tests for the canonical fields, append-only enforcement,
   source-ledger idempotency, account deletion, and session sequencing.
2. Add the database migration and Drizzle schema. Add durable webhook deliveries.
3. Add RED API tests for trusted provenance, strict filters, session ordering,
   batch ingestion, export continuation, and reconciliation.
4. Implement the canonical serializer, authenticated runtime ingestion, strict
   queries, source-ledger projection, reconciliation, and webhook worker.
5. Add RED sandbox-agent tests for complete event forwarding, deterministic IDs,
   redaction, hashing, batching, retry, and sub-agent capture. Implement the relay.
6. Add RED SDK tests, then extend the compatible public types and clients. Run
   typecheck, the complete suite, and packed-install smoke.
7. Add RED CLI process tests, then implement project/session/filter/export parity.
8. Update the account and session audit UI through the SDK. Run the required
   design-system review, focused browser assertions, lint, and typecheck.
9. Run migration, local API, CLI, real sandbox/OpenCode, browser, deletion,
   failure-injection, resume, redaction, reconciliation, and performance proof.
10. Rebase, run full affected-package gates, push, open the PR, resolve every
    check, merge to `main`, follow Deploy Dev, prove the deployed SHA, and repeat
    API, CLI, and browser proof on Dev.
