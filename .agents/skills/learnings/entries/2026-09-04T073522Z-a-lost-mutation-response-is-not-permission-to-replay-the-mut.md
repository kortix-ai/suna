---
recorded: 2026-09-04T07:35:22Z
incident_date: 2026-09-04
commit: 77681271d3
---
# A lost mutation response is not permission to replay the mutation

**When:** retrying RPC after a socket close, reset, pipe failure, or timeout.
**Incident:** `KortixExecutionEnv.rpc()` retried every socket-shaped failure, so an environment
mutation that committed before its response dropped could execute twice despite the outer guard.
**Rule:** retry only an explicit, fail-closed set of read operations. Unknown operations mutate.
**Enforcer:** `kortix-env.test.ts` commits a side effect, drops the response, and requires one call.
