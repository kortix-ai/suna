---
recorded: 2026-11-04T06:54:09Z
incident_date: 2026-11-04
---
# Read settled gateway session days from a rollup, not the full request log window

**Rule:** Aggregate closed gateway session days once in the worker. Read only marked days from the rollup, and keep the partial leading day and every unmarked day on the raw path. Preserve the shared spend and pricing expressions.

**Trigger surface:** Changing the gateway sessions list, its settlement worker, or the spend/value rules.

**Incident:** KRTX-4021: the production sessions route reached its 25-second deadline while gateway log volume grew roughly fivefold in a week. Successful requests were also slow. A covering index still leaves a month of requests to aggregate on each read.

**Enforcement:** `session-costs-service.test.ts` checks merged sessions and raw fallback; `session-rollup.integration.test.ts` checks real PostgreSQL settlement, parity with the raw reader and marked/unmarked boundaries. Pricing-rule changes must invalidate the marks in a forward migration. The 24-hour production error-rate check remains required after deployment.
