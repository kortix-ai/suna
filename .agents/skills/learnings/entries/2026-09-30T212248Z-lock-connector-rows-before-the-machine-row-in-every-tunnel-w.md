---
recorded: 2026-09-30T21:22:48Z
incident_date: 2026-09-30
---
# Lock connector rows before the machine row in every tunnel write; one lock order per pair of tables

**Rule:** A transaction that writes `connector_connections` rows locks the `connectors` row first and the `tunnel_connections` row second, everywhere. The FK checks on `connector_connections` (tenant FK to `connectors`, `tunnel_id` FK to `tunnel_connections`) take key-share locks on both parents, so a write that never names a parent still takes its lock. Wrap a write that can still lose the race in `retryOnDeadlock`, as a complement, never as the fix.

**Trigger surface:** Adding or changing a writer of `connector_connections`, `tunnel_connections` or `connectors` (attach, unpair, pair, rename, sync).

**Incident:** 2026-09-30, PR #8515 core lane: `DELETE /v1/tunnel/connections/:id` answered 500 (40P01, flow TUN-4). `unpairMachine` locked the machine row, then its delete's SET NULL update took a key-share lock on the connector row. `attachComputerConnection` (#8383, #8396) holds the connector row and waits for the machine row. Zero prod occurrences in 30 days of logs. Fixed in this PR's unpair: connectors first, then the machine, plus a 3-try retry.

**Enforcement:** `apps/api/src/connectors/integration-tunnel-unpair-lock-order.test.ts` (real PostgreSQL, deadlocks on the old order). Flow TUN-4 covers the route.
