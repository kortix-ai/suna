---
recorded: 2026-10-20T07:06:53Z
incident_date: 2026-10-20
---
# Return a typed not-found outcome when subscription sync references a missing Stripe object

**Rule:** Translate a missing stored Stripe subscription to BillingError(404), but preserve transient failures and local entitlements.

**Trigger surface:** POST /v1/billing/sync-subscription retrieves a stored subscription in the currently configured Stripe account.

**Incident:** 2026-10-19, KRTX-2882: one dev sync request returned a paging 500 after Stripe returned resource_missing.

**Enforcement:** apps/api/src/__tests__/billing/subscriptions.test.ts covers missing-object 404, unchanged billing state, transient errors, and successful sync.
