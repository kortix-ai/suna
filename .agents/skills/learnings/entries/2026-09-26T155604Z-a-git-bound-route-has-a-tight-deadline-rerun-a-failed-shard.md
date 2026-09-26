---
recorded: 2026-09-26T15:56:04Z
incident_date: 2026-09-08
---
# A git-bound route has a tight deadline — rerun a failed shard alone before reading a gate 503 as a regression

**Rule:** when a deployed-gate flow fails with `503` around a ~55s mark on a
route that rewrites the project manifest or syncs channel connectors (install,
update, or delete a Slack/Teams/email channel installation), do not treat it as
a product regression on first read. Those routes clone, commit and push the
managed repo (`reconcileChannelConnectors` in `apps/api/src/connectors/sync.ts`
and its channel route callers); the call normally takes ~10-13s, but under many
parallel gate shards the same call can cross a fixed request deadline. Rerun
the failed shard alone before concluding anything broke.

**Trigger surface:** a deployed release-gate run where a channel-connector
flow (install/update/delete) fails `503` near the shard's per-request budget.

**Incident:** v0.13.12 gate, 2026-09-08 00:40-02:00 UTC: two channel flows
failed three gate runs in a row and passed when dispatched alone.

**Enforcement:** none — the long-term fix is fewer git round-trips inside
`reconcileChannelConnectors`, not a longer deadline. A step-level budget
assertion in the channel flows is the TODO.
