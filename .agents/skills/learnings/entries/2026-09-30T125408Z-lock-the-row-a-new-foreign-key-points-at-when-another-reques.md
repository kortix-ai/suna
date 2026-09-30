---
recorded: 2026-09-30T12:54:08Z
incident_date: 2026-09-30
---
# Lock the row a new foreign key points at when another request can delete it, and treat a gone row as a normal outcome

**Rule:** When a transaction inserts or updates a row whose foreign key points
at a row that another request can delete, lock the referenced row with
`SELECT … FOR KEY SHARE` in the same transaction before the write. When the lock
finds no row, return "gone" and let the caller answer as for an unknown row. A
plain existence check before the write is still racy: a delete that commits
between the check and the write fails the write with Postgres 23503, and the
request answers 500.

**Trigger surface:** Writing `connector_connections.tunnel_id`
(`attachComputerConnection` in `apps/api/src/connectors/computers.ts`), or any
new insert or update that references a row a concurrent route deletes, when the
referenced row was read outside the writing transaction or without a lock.

**Incident:** 2026-09-30 near-miss. Flow MCP-5 failed in 2 of 4 full local
`pnpm test` runs: `GET /v1/connectors/projects/:id/catalog` answered 500 (pg
23503). `ensureProjectComputer` attached the owner's machine while a concurrent
flow unpaired it. `POST /v1/projects/:id/computers` had the same gap between its
machine lookup and the attach. Any user who unpairs a computer while another
request lists connectors could get the 500. No production report.

**Enforcement:** `apps/api/src/__tests__/integration-computer-attach-race.test.ts`
deletes the machine on a second connection, lets the attach block on that row,
then commits (`apps/api/src/__tests__/helpers/interleave.ts`). Without the lock,
both tests fail with 23503 and 500. With a lock-free existence check, they fail
the same way.
