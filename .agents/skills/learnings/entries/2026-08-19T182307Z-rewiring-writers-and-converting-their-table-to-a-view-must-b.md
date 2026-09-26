---
recorded: 2026-08-19T18:23:07Z
incident_date: 2026-08-19
commit: 53c1940195
---
# Rewiring writers and converting their table to a view must be TWO releases

**When:** an expand/contract store swap (table -> compatibility view). The
migration applies BEFORE the new image rolls, so old pods run against the view
for the whole build+rollout window — and any of their `INSERT ... ON CONFLICT
(cols)` writers 42P10 for that entire window (INSTEAD OF triggers cannot help;
conflict inference precedes them). Locally it is worse: the shared Supabase DB
is cutover'd the moment the migration runs, and EVERY other worktree still on
pre-cutover code breaks until it merges main.
The rule: **release N rewires every ON CONFLICT writer off the table; release
N+1 converts it to a view.** If they must ship together, size the window
explicitly (dev: minutes; prod: pod drain + build — unacceptable for hot
writers) and schedule the promote accordingly. After cutting over a shared
local DB, tell every other active session to merge main IMMEDIATELY.
*Incident:* RBAC cutover #6594 — dev's grant/invite/SSO-JIT/SCIM upserts
42P10'd from migration-apply until the API rollout landed; every local
worktree session on pre-cutover code broke against the shared DB at once.
*Enforcer:* none — prose only. The promote runbook must carry this check.
