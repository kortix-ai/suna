---
recorded: 2026-08-19T12:15:05Z
incident_date: 2026-08-19
commit: a93db436c8
---
# `CREATE INDEX CONCURRENTLY` under a 5-second `lock_timeout` cannot land on live prod

**When:** writing or applying any `.concurrent` migration; responding to a `55P03`
("canceling statement due to lock timeout") during `Apply DB migrations to prod`.

v0.13.0's deploy-prod (run 32248002434) failed its migration job twice, both times
on a `.concurrent` migration that did `set lock_timeout = '5s'` then
`create index concurrently …` — first on `kortix.iam_roles` (6 rows, 80 kB),
then on `kortix.account_tokens` (30k rows). The table size is irrelevant:
`CREATE INDEX CONCURRENTLY` has to wait for EVERY transaction in the database
that started before it (it takes a ShareLock on each one's virtual transaction
id), and `lock_timeout` governs that wait. On live prod — audit_events writers
on every request, multi-second session-turn transactions — some transaction
outlives a 5-second budget almost every time, so the CIC is cancelled and leaves
an INVALID index behind, which makes a plain re-run fail with "already exists".
The 2–5 s house value exists to keep DDL from blocking prod; CIC's wait blocks
nobody, so that rationale does not apply to it.

The rule: **in a `.concurrent` migration, set `lock_timeout` long enough for a
live system — 2–3 minutes — and note why in the file.** The one lock a CIC
holds (ShareUpdateExclusive on the table) only excludes other DDL/VACUUM; a long
wait on virtual transaction ids hurts no user.

Recovery when it has already failed (used twice tonight, ~2 min each):
1. `select indexrelname from pg_stat_user_indexes s join pg_index i on
   i.indexrelid=s.indexrelid where not i.indisvalid` — find the INVALID leftover.
2. `drop index concurrently if exists <it>`.
3. Hand-run the migration's exact statements in `psql` with
   `set lock_timeout='180s'; set statement_timeout='30min'`; confirm `indisvalid`.
4. `insert into kortix_migrations.pgmigrations (name, run_on) values ('<file
   basename without extension>', now())` — the ledger must match what is live.
5. `gh run rerun <deploy-prod run> --failed` — the migrate step sees nothing
   pending and the roll proceeds.
Migration files are immutable once merged (CI enforces it), so do not edit the
failing file; fix the template/house rule for the next one.
*Incident:* v0.13.0 deploy-prod run 32248002434, migrations
`20260819015724600_rbac_canonical_indexes.concurrent` and
`20260819015726000_account_tokens_session_id_index.concurrent`; ~30 min of
release delay. Prod also carries four pre-existing INVALID legacy indexes
(`public.idx_messages_*`, old Suna table) that predate this and were left alone.
