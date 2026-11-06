---
recorded: 2026-11-05T18:44:16Z
incident_date: 2026-11-05
---
# Give every agent-facing route an allow branch in the project-scope gate, with a test that calls it as a session token

**Rule:** When a CLI command or tool is meant to run inside a session, add its route to `enforceTokenProjectScope` (`apps/api/src/middleware/auth-scope.ts`) in the same PR, and test it with a project-scoped PAT. The gate denies every route it does not list. A Supabase-JWT test does not exercise it. Also: a permission fallback that cannot decide a call must not ask when no restricted pattern can match it. An `ask` blocks an unattended session with no end.

**Trigger surface:** Adding a `kortix` command, a Kortix tool or a skill instruction that an agent runs with `$KORTIX_TOKEN`. Changing `bashCommands` / `resolveRule` in `apps/kortix-sandbox-agent-server/src/harness/pi/interactions.ts`.

**Incident:** 2026-11-05. A prod agent session tried `kortix feedback` to report a permission bug and got `403 Project-scoped token cannot call this surface [check=token-project-scope:default-deny path=/v1/feedback]`. `POST /v1/feedback` (#9389, 2026-10-10) shipped for agents, but its only tests used a JWT and a stored-login PAT. The bug it tried to report: a policy with any deny pattern made every bash line with an unbalanced quote (heredoc body, apostrophe in a comment) resolve to `ask`, and the same session blocked on the prompt twice that day.

**Enforcement:** `apps/api/src/middleware/auth.test.ts` (session-bound and project PATs file `POST /v1/feedback`; GET and a lookalike path stay 403). Flow `FB-1` step "an agent session files with its project-scoped token" runs the real CLI with `KORTIX_TOKEN` alone. `apps/kortix-sandbox-agent-server/src/__tests__/permission-precedence.test.ts` covers heredocs, comments and the scoped fallback for an unparseable line. None yet for the general rule: a route-manifest check that every route an agent-facing CLI command calls is admitted by the gate.
