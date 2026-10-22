---
recorded: 2026-10-03T03:25:00Z
incident_date: 2026-10-03
commit: e84ac9f546
---
# A DB migration that names a nonexistent column merges unverified and blocks EVERY dev deploy

**When:** auto-merging a factory DB-migration PR. The factory worker runs in a
Docker-less sandbox, so its `db-suites` lane records `skipped-no-db`; the merge
gate (after the db-wait removal) treats that as green and merges without ever
applying the migration. A migration that references a column present in no
migration — here legacy `public.projects.is_public` in an
`agent_runs_select_policy` re-create — passes every non-DB gate, lands on main,
then halts `node-pg-migrate` on the dev deploy (`column ... does not exist`).
Because "Apply DB migrations to dev" halts-on-failure, EVERY later dev deploy
then fails too: one bad migration is a shared-blast-radius outage, not a
single-PR problem. It also masks the NEXT migration error until the first is
cleared (here an out-of-order migration sat behind it).

**Rule:** never treat `db-suites: skipped-no-db` as green for a migration-touching
PR — a migration must be applied against a real Postgres before it can merge.
Detection today is only the dev-deploy migration step, which is slow (hours) and
has no alert. Enforce by giving the factory worker a real migration-apply check
(a lightweight Postgres or a Docker-capable migration lane), or hold migration
PRs until staging/a human applies them; at minimum, alert on the first
"Apply DB migrations to dev" failure. Related: the entry on node-pg-migrate
checkOrder being index-wise on ledger run order.

*Incident:* 2026-10-03, dev deploys failed ~00:00–03:20Z on
`20261002213456346_agent_runs_select_policy_initplan.sql` (references nonexistent
`public.projects.is_public`), stacked behind an out-of-order migration. Fixed by
removing the broken migration (#8852) and re-dating the out-of-order one (#8846);
dev deploy then green on e84ac9f546. Root enabler: the merge gate's db-wait
removal auto-merging DB PRs on `skipped-no-db`.
