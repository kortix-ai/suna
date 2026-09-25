---
recorded: 2026-09-25T16:46:46Z
incident_date: 2026-09-25
commit: a6e219fdda
---
# A retired Enforcer names its keeper here, in the same PR

**Rule:** When a PR deletes or renames a test file that an entry below names as
its Enforcer, append the keeper that now proves the rule in that same PR, and
prove the keeper with a mutation. A stale Enforcer line reads as a fact and
sends the next reader to a file that does not exist. **Trigger surface:** a
test-pruning PR; `git grep <retired-file>` across `.claude/skills/` must be empty
or answered here.

**Near-miss:** test-audit PR #7662 (api-billing-gateway) retired two named
Enforcers without an append. Moved enforcers:
- "A wrapper error hides its cause" (2026-09-10): `credit-duplicate-error.test.ts`
  and its "naive check would have missed it" row are gone. The Enforcer is
  `tests/migration/wallet-ledger.test.ts` "a replayed reset key is a silent
  no-op": real PostgreSQL raises `kortix_unique_stripe_event` through a Drizzle
  wrapper, because `reset_expiring_credits` has no event pre-check. It goes red
  when `isDuplicateCreditGrantError` stops walking `cause`.
  `apps/api/src/billing/wallet/duplicate-error.test.ts` keeps the constraint
  and non-duplicate rows.
- "Guest must fetch the managed set on every boot" (2026-08-19):
  `managed-scope.test.ts` is gone. The Enforcers are
  `apps/api/src/llm-gateway/internal-routes.test.ts` "POST /models managedOnly"
  (exact managed lineup, payload `< 20_000` bytes, free tier empty) and
  `packages/llm-gateway/src/create-gateway.test.ts` "gateway.listModels — scope
  plumbing". They go red when the route ignores `managedOnly`.
