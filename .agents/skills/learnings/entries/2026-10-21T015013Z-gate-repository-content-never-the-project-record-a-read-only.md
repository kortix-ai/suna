---
recorded: 2026-10-21T01:50:13Z
incident_date: 2026-10-21
---
# Gate repository content, never the project record: a read-only route that returns no repository data must not sit behind the session repository-access gate

**Rule:** Put `assertAgentSessionWorkspaceAllowsRepository` only on routes that return repository content or location. A route that serves the project record answers a repo-less session with the repository fields empty, and a CLI in a box reads its flags from `KORTIX_FEATURE_FLAGS`, not from an API call that a workspace policy can refuse.

**Trigger surface:** adding or moving the repository-access gate in `apps/api/src/projects/routes/*`; a CLI command that reads `GET /projects/:id` inside a session box.

**Incident:** 2026-10-21, dev `0.14.4-dev`. An agent session without repository access could not run `kortix goals new`, `kortix projects use` or `kortix projects features ls`: `GET /projects/:id` returned 403, and the CLI printed a `kortix_permissions` fix no session can apply. The agent rebuilt the goal by hand. Fixed in #10599 (`14fb0a98a2`).

**Enforcement:** flow SCOPE-9 (`tests/src/flows/session-scope.flow.ts`) asserts 200 with empty repository fields for a runtime-workspace credential and 403 `session_repository_access_denied` on repository routes; `apps/cli/src/commands/goals.test.ts` runs `kortix goals new` against an API that refuses the project record.
