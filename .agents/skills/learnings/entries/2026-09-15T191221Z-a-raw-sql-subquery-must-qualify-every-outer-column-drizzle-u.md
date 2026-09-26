---
recorded: 2026-09-15T19:12:21Z
incident_date: 2026-09-15
commit: 86065cd21f
---
# A raw `sql` subquery must QUALIFY every outer column — Drizzle unqualifies them in a single-table select

**When:** writing `` sql`(select … from ${inner} where … = ${outer.col})` `` as a
column of `db.select({...}).from(outer)`, or anywhere the template may later be
placed there. Drizzle renders column references in a single-table selection
WITHOUT their table, so `${outer.col}` becomes `"col"`, Postgres binds it to the
INNER table, and the correlation is a tautology that returns the first row of the
inner table for every outer row. Use a typed `leftJoin`, or wrap every outer column
in `qualifiedColumn()` (`apps/api/src/shared/sql-qualified-column.ts`). *Incident:*
prod v0.13.16 and earlier, from ~2026-09-07: `loadSandbox`
(`sandbox-proxy/backend.ts`) read the session agent this way, so every proxied
request got another customer's agent (`chief-of-staff`, the first
`project_sessions` tuple). Agent-less prompts re-pointed session tokens at it —
344 tokens in unrelated projects lost CLI and connector access; the admin project
list showed global session counts per project. *Automation:*
`sql-correlated-subquery-guard.test.ts` fails on any raw subquery that references
a `@kortix/db` table column it does not select from;
`integration-correlated-subquery-isolation.test.ts` proves the `loadSandbox` join on real rows; `isLaunchableAgentName` + the proxy/re-mint guards refuse
any agent name the session's own manifest does not declare.
