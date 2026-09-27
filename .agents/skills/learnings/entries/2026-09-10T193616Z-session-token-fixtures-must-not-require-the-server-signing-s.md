---
recorded: 2026-09-10T19:36:16Z
incident_date: 2026-09-10
commit: 404655d736
---
# Session-token fixtures must not require the server signing secret

**Incident.** Release run `34510198802` API shard 4 finished its flows at
18:44 UTC but remained alive until cancellation at 19:24 UTC. CONN-27 opened
a PostgreSQL connection, then skipped outside its cleanup block because
`KE2E_API_KEY_SECRET` was absent. The connection kept the process alive.

**Rule.** Mint test credentials through the public token API. Bind fixture
metadata in the database without copying server signing secrets into test
environments. Acquire database connections inside the cleanup scope. Do not
hide a leaked connection by forcing the test process to exit.

**Enforcement.** CONN-27 uses `POST /v1/accounts/tokens`, enters `try/finally`
before connecting, and deletes the minted token by `token_id`. Preview test
configuration no longer exports the signing secret; its unit test rejects
that export. The flow allows five minutes for managed Git writes and ten
sequential manifest reads; all existing assertions remain required.
