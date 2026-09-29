---
recorded: 2026-09-29T05:56:38Z
incident_date: 2026-09-29
---
# Close a relay socket with a credential-rejection code only when the credential is bad; use 1011/1013 for the relay's own faults

**Rule:** A relay closes an agent socket with a credential-rejection code (4001/4003) only after the secret itself failed verification. Its own faults (auth timeout, database error, send failure) close with 1011/1013. An agent treats 4001 with a relay-fault reason as retryable, and a supervised agent never exits 0 on a rejection: it waits and re-checks.

**Trigger surface:** `packages/agent-tunnel/src/server/ws-handler.ts` close codes, `agent.ts` close handling, any relay or daemon that authenticates long-lived agents, deploys that restart the API while agents are connected.

**Incident:** 2026-09-29, found while building PR #8168. An API restart failed an in-flight WS auth (DB unavailable during shutdown); the relay closed with 4001 'authentication error'; the agent read it as a revoked credential and its background service exited 0, which launchd never restarts. Every connected computer went offline until someone re-ran it by hand. Shipped fix: PR #8168.

**Enforcement:** `packages/agent-tunnel/src/server/ws-handler.test.ts` (throwing authenticator → 1011, auth timeout → 1013) and `src/agent/agent.test.ts` (`isCredentialRejection`; a relay-fault 4001 reconnects; a refused secret still stops). The chaos soak in PR #8168 (API kill + restart, 69 fault cycles, all online ≤ 31 s).
