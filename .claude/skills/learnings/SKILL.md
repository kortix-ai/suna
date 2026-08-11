---
name: learnings
description: "The project's hard-won incident learnings — durable rules extracted from real outages and near-misses, each with the incident that taught it. Load WHENEVER you write or review a DB migration or schema change, touch deploy/release workflows (.github/workflows/deploy-*, promote.yml, vercel config), plan a promote/release, respond to a prod incident, or when another skill references a learning. ALSO load after resolving any incident: this file is append-only and every new incident MUST deposit its rule here."
---

# Project learnings

Rules paid for with real downtime. Each entry: the rule first, the incident that
taught it second. This register is **append-only** — when an incident or
near-miss resolves, add its rule here in the same session, newest first. Keep
entries under ~8 lines; deep detail goes in the incident's memory/RCA and is
linked, not inlined.

## How to add a learning

1. Write the RULE as an imperative a developer can obey while coding.
2. Name the trigger surface (what someone is doing when it applies).
3. One-line incident citation (date, version, blast radius).
4. Reference any enforcing automation (lint, CI gate, workflow) — a learning
   with an enforcer is a fact; one without is a TODO to build the enforcer.

## Register

### A per-turn hot path must not contain an unbounded third-party round-trip (2026-08-11)

**When:** adding an `await` to the prompt path — `syncSandboxEnvForPrompt`
(`apps/api/src/projects/lib/sandbox-env-sync.ts`) and everything it calls. The
network-boundary sync ran a FULL provider re-arm before every turn: manifest
resolve, GET/PUT sandbox secrets, `ensureSecret` per binding, then
`waitUntilArmed` at 40 × 250 ms — up to ~10 s, past the proxy budget. One egress
secret therefore broke every agent turn in the project. Arm once at session
start or in the background, bound the wait, and fail soft ONLY where a skipped
call cannot widen access (a boundary value never enters the guest, so the worst
case is a 401 upstream, not a leak). It also ran before `postEnvToDaemon`, so its
failure skipped the ordinary runtime-secret push too.
*Incident:* 2026-08-11 — same session, same sandbox: egress secret active →
`prompt_async` 502 in 5.2 s, disabled → 200 in 1.2 s. Found only when the product
owner said "I cannot test this on dev"; the symptom was a spinner stuck on
"Considering next steps…", naming neither secrets nor the provider.
*Enforcer:* none — build it.

### A deploy workflow must not cancel a build it cannot outrun (2026-08-10)

**When:** setting `concurrency.cancel-in-progress` on any
`.github/workflows/deploy-*`. A workflow-wide group with `true` starves the
SLOWEST surface, because every surface shares the group: a frontend-only push
kills an in-flight multi-arch API build (~23 min) whenever `main` lands faster
than that build takes (~10–20 min by day). Queue instead — GitHub holds one
pending run and cancels the previous pending one, so a burst still collapses to a
single deploy and the newest commit still wins. `true` also lets an unrelated
push kill `migrate-db` mid-migration.
*Incident:* 2026-08-10 — 19 of 30 Deploy Dev runs cancelled, `dev-api` pinned to
`d1ed3589` for 3.5 h with 5 API commits stranded; it landed only once the trunk
went quiet that evening.
*Enforcer:* none — and `deploy-staging` is still `true`, where a cancelled
`migrate-db` would hit `STAGING_DATABASE_URL`. Build the guard.

### One CREATE INDEX CONCURRENTLY per table at a time (2026-08-10)

**When:** building indexes on a live table (runbooks, .concurrent.ts migrations).
Two concurrent CIC builds on the same table starve each other's
lock-acquisition points — every acquisition 55P03s until one finishes. Build
strictly serially. If a builder's client process dies, its CIC keeps running
SERVER-side, holds ShareUpdateExclusive, and its final commit is unreliable —
find it in `pg_stat_progress_create_index`, `pg_terminate_backend` it, and
`DROP INDEX CONCURRENTLY` the INVALID shell before rebuilding (`IF NOT EXISTS`
silently keeps invalid shells).
*Incident:* v0.12.7 audit-v2 index pass — parallel lanes 55P03-thrashed, a
killed lane left an orphaned build that starved the retry run.

### The Vercel prod build must be handed the release version (2026-08-10)

**When:** touching deploy-prod's Vercel deploy or apps/web/next.config version
resolution. The Vercel build (rootDirectory apps/web) cannot reliably read the
repo-root VERSION file, so runtime-config reports "dev" and
frontend-auth-proof's `VERSION === X.Y.Z` check fails. Pass
`--build-env NEXT_PUBLIC_KORTIX_VERSION=<version>` on every prod deploy (the
`deploy-web-vercel` job does); the project env `NEXT_PUBLIC_KORTIX_VERSION` is
a static fallback that goes stale — the build-env override wins.
*Incident:* v0.12.7 frontend served VERSION "dev"; gate exhausted 30 attempts;
fixed by `vercel redeploy` after setting the env.

### An audit reconstruction trigger is only safe with its dedup index (2026-08-10)

**When:** installing triggers that INSERT INTO audit_events with
source_ledger/source_record_id set. The prepare-trigger's duplicate check needs
`idx_audit_events_source_phase`; without it every triggered insert seq-scans
the whole table and times out the OUTER statement — cron trigger dispatch
failed prod-wide for ~80 min. Order in any reconcile: dedup index BEFORE (or
immediately after) trigger install, never "later with the other indexes."
*Incident:* v0.12.7 reconcile installed triggers at 17:56, index landed 19:29.

### Never backfill data inside a single-transaction migration (2026-08-10)

**When:** writing any `.sql` migration under `packages/db/migrations/`.
A plain `.sql` migration runs in ONE transaction, so its `ALTER TABLE`s hold
ACCESS EXCLUSIVE until COMMIT — top-level `UPDATE`/`INSERT INTO`/`DELETE
FROM`/data-modifying `WITH` in the same file turns milliseconds of lock into the
full backfill duration, blocking every writer on the table. Write data moves as
batched, incrementally-committed `.concurrent.ts` passes or a supervised
out-of-band runbook (short-tx DDL → triggers → chunked updates → CONCURRENTLY
indexes → ledger rows).
*Incident:* v0.12.7 promote — `centralized_audit_v2` rewrote 30.5M rows of
`audit_events` under lock; prod down ~30 min.
*Enforcer:* `lint-migrations.ts` backfill-DML guard (`-- backfill-safe:`
sign-off escape hatch; `backfill-grandfathered-migrations.json` snapshot).

### Cost every pending prod migration before promoting (2026-08-10)

**When:** preparing a release/promote.
Ordering-correct is not enough. Diff `kortix_migrations.pgmigrations` on prod
against the promoted tree, and for each pending migration ask what it does at
prod data volume. A tag tree containing a migration file is NOT proof the
migration ran — only the ledger is.
*Incident:* same v0.12.7 outage — the dangerous migration had been "shipped" in
v0.12.6's tag but never applied; nobody costed it before the promote.
*Enforcer:* kortix-release skill Step 3.6 (checklist); this rule is the reason.

### The prod frontend must never deploy before the API serves the release (2026-08-10)

**When:** touching `vercel.json`, `vercel-ignore.sh`, or `deploy-prod.yml`.
A push to `prod` must not auto-deploy kortix.com; the frontend deploys only from
deploy-prod's `deploy-web-vercel` job after `verify-live-version` proves the API
is on the release. A new frontend against an old API calls routes that do not
exist — every project load fails "before we could check your access".
*Incident:* v0.12.7 — Vercel auto-promoted the new frontend while the API stayed
back after its migration failed; second occurrence of the class (v0.10).
*Enforcer:* `deploymentEnabled.prod:false` + `deploy-web-vercel` job, pinned by
`tests/unit/web-ecs-workflow.test.ts`.

### node-pg-migrate checkOrder is index-wise on ledger run order (2026-08-10)

**When:** doing any out-of-band migration apply or ledger surgery.
`checkOrder` compares the ledger's run order (`ORDER BY run_on, id`) position by
position against filename order — appending an older-named migration to the end
of the ledger fails the NEXT migrate even though "everything is applied". Place
reconciled rows' `run_on` so ledger order matches file order.
*Incident:* staging deploy failed post-reconcile until the 7 audit-v2 rows were
re-timestamped before the two later migrations.

### Cancel the CI run before killing its DB backend (2026-08-10)

**When:** a deploy's migration step is wedging prod and you terminate it.
The migrate step (and `withMigrationDeadlockRetry`) retries: killing only the
Postgres backend re-locks the table minutes later. Order: cancel the workflow
run, then `pg_terminate_backend`, then verify no reconnect.
*Incident:* v0.12.7 — first kill was undone by a retry; prod degraded a second
time before the run was cancelled.

### Bot-pushed release PRs and repo Actions approval policy (2026-08-10)

**When:** a required check sits in `action_required`, or changing repo Actions
settings. `fork-pr-contributor-approval: all_external_contributors` holds EVERY
PR workflow whose actor lacks write access — including `github-actions[bot]` on
promote-created release PRs — stalling releases behind a manual approve click.
Keep it at `first_time_contributors` (org default) unless there is a concrete
reason, and never quietly stricter than the org.
*Incident:* v0.12.7 release gate stalled in `action_required`.

### Verify CI assertions against the real artifact format on the CI OS (2026-08-10)

**When:** writing shell assertions in workflows (grep/awk over curl output,
cookie jars, headers). curl's Netscape cookie-jar puts the domain in the FIRST
field with an `#HttpOnly_` prefix — a tab-anchored grep can never match; and GNU
grep -E treats `\t` in single quotes as a literal `t` while macOS grep interprets
it, so a locally-green pattern can be dead on ubuntu runners. Use ANSI-C
quoting (`$'\t'`) and test the exact pattern in an ubuntu container.
*Incident:* staging web verify failed twice on the same one-line assertion.
