---
recorded: 2026-11-06T14:03:18Z
incident_date: 2026-11-06
---
# Treat every token bound to a session or an agent grant as an agent for HUMAN_ONLY, whatever its credential kind

**Rule:** Decide "is this an agent" from the token binding (`session_id` or `agent_grant` on the `account_tokens` row), never from `credential.kind === 'agent_session'` alone. A session token minted without a service account (the My Kortix coordinator, or a session whose service-account ensure failed) classifies as a `pat` and acts as its launcher; HUMAN_ONLY (minting credentials, moving money, deleting the workspace) must still refuse it.

**Trigger surface:** Adding or changing an agent wall, a credential classification in `iam/actor.ts`, or `mintSessionToken`.

**Incident:** 2026-11-06, PR #11857 before merge: a My Kortix-shaped session token could mint a service-account secret (201), configure auto-topup and delete the workspace (200), because `authorize` applied HUMAN_ONLY only to `agent_session`. Found in review; never shipped.

**Enforcement:** flow `WS-AUTH-8` (`tests/src/flows/workspace-auth.flow.ts`) and `apps/api/src/__tests__/integration-iam-workspace-scope.test.ts` ("a session token that names no service account").
