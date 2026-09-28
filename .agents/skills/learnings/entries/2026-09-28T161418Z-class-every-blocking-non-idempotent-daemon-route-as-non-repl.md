---
recorded: 2026-09-28T16:14:18Z
incident_date: 2026-09-28
---
# Class every blocking, non-idempotent daemon route as non-replayable in the sandbox proxy

**Rule:** When a new caller reaches a daemon route through `/v1/p/<id>/8000`, and that route answers only after its work finishes and is not safe to run twice, add it in the same commit to the proxy's non-replayable set (`uploadDelivery` in `sandbox-proxy/routes/preview.ts`) and to the long-attempt branch of `proxyAttemptTimeoutMs`. The generic path aborts after 15 s and replays up to 3 times.

**Trigger surface:** exposing a daemon route (`/kortix/*`, `/file/*`, OpenCode `/session/*`) to a new client through the API's sandbox proxy, for example an MCP tool, an SDK method, or a CLI command.

**Incident:** 2026-09-28, near-miss, found while PR #7994 routed MCP `run_command` through `POST /kortix/env-rpc` `{op:"exec"}`. That route blocks until the shell command exits. The proxy gave it the 15 s connect cap and retried after an abort or a 502, so any command longer than 15 s would have run up to 4 times. No user was affected, because no client called env-rpc through the proxy before this PR. This is the fourth instance of the class: `/command` (2026-08-11, one submit ran 4 turns), `/summarize` (2026-08-26), and `/file/upload` and `/file/import` (duplicate files).

**Enforcement:** `sandbox-proxy/routes/forward.test.ts` → "POST /kortix/env-rpc": one attempt past the 15 s cap, and a 502 is not replayed (`fetchCalls === 1`). It fails with 2 attempts when `isEnvRpcRequest` is removed from `uploadDelivery`. None yet for a future route: the enforcer to build is a route table in the daemon that marks each POST idempotent or not, with a test that fails when the proxy has no class for a non-idempotent route.
