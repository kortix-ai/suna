---
recorded: 2026-09-03T09:26:29Z
incident_date: 2026-09-03
commit: 3a1a3e9e31
---
# Separate runtime principals require a separate RPC credential

Found 2026-09-03 on the `pi-worker` preview. Worker and environment PATs became
distinct runtime principals. `LazyKortixEnv` still signed environment RPC with
the worker PAT. The environment daemon still verified the signature with its
own PAT. Every Bash and file call therefore returned `401`, which the worker
rendered as a generic environment error. Unit tests used one shared token on
both sides and could not detect the broken boundary.

**Rules.**
1. A credential that identifies one runtime must not authenticate a different
   runtime's private endpoint.
2. Cross-runtime RPC must use a purpose-bound secret that grants no control-plane
   API access.
3. An integration test for two runtime principals must use different PAT values.
   A shared test token recreates the coupling that production removed.
4. A global project-scope gate and the route handler must accept the same runtime
   principal types. Handler support is unreachable when middleware denies first.

*Automation:* `env-rpc-worker-integration.test.ts` uses distinct worker PAT,
environment PAT, and RPC secret values across the real client and daemon router.
`env-rpc.test.ts` rejects an environment PAT as an RPC signature.
`project-audit-ingestion.test.ts` and `auth.test.ts` pin environment callbacks
and the session-bound boot-timeline middleware allowance.

*Incident:* The branch preview returned two environment tool errors before the
fix. No production or dev deployment received this branch. The affected preview
sessions were stopped after verification.
