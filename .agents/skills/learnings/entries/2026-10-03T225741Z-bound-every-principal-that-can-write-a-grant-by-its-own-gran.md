---
recorded: 2026-10-03T22:57:41Z
incident_date: 2026-10-03
---
# Bound every principal that can write a grant by its own grant

**Rule:** A principal that can write a grant may add to it only what it holds itself. Check the ADDED items of every agent's grant against the writer's own effective grant (`authorize` for permissions; the writer's connector, secret and App lists for the rest) on EVERY write path. A permission that lets a principal rewrite its own limit otherwise equals `all`.

**Trigger surface:** adding or changing a route, merge gate or push path that writes `kortix_permissions`, `connectors`, `secrets` or `apps` of any agent; changing the agent ceiling or `HUMAN_ONLY_ACTIONS`.

**Incident:** 2026-10-03, staging promotion #9016. Strix found that #9002 ("permissions decide for agents as for people") let a governed agent with `project.gitops.merge` + `project.agent.write` merge a CR raising itself to `all` (HIGH), and let an agent with a narrow `secrets:` list grant itself any other secret (MEDIUM). The default agent ceiling is every grantable permission, so the manifest grant was the only limit and the agent could rewrite it. The release was held until the fix shipped.

**Enforcement:** `apps/api/src/iam/agent-grant-ceiling.ts` (`assertNoGrantEscalation`, `holdsEveryGrant`), called from the agent-config PUT, the scope PUT, the secret-grant POST, the CR merge and the default-branch push gate. `agent-grant-ceiling.test.ts` (unit) and flow `AGP-10` (black box: CR self-raise 403 `agent_grant_escalation`, secret self-grant 403, default-branch push refused). Each AGP-10 case was run red with the checks disabled.
