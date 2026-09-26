---
recorded: 2026-09-26T15:58:05Z
incident_date: 2026-09-10
---
# Inspect a cron write before retrying a request deadline

**Rule:** a request-deadline response (`503 request_deadline` or similar) does
not establish that the underlying operation stopped. Before retrying a write
(especially a cron/batch job), inspect its idempotency and read back its
result. Do not accept a deadline response alone as evidence a job completed
OR that it did not — check.

**Trigger surface:** any deployed-gate flow asserting on a cron-triggered
write (billing rotation, batch settlement, scheduled reconciliation) that can
answer a request-timeout status.

**Incident:** release run 34524663210, flow `BILL-13`: received
`503 request_deadline` after 55 seconds. A later isolated call to the same
route returned `200` in 0.7 seconds with an empty-but-valid result
(`{processed: 0, skipped: 0, errors: []}`). The failed shard passed on retry;
the exact cause of the first 55-second delay was never isolated.

**Enforcement:** `BILL-13` requires `200` and the rotation result fields on
its assertion; the deadline itself has no enforcer — reading back the
operation's actual effect before retrying is manual practice.
