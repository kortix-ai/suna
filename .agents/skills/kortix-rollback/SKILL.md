---
name: kortix-rollback
description: "How to roll Kortix PRODUCTION back to an older already-released version — the inverse of a release. Covers the one-dispatch rollback-prod.yml engine (--ref prod, shares the deploy-prod concurrency group), the per-surface mechanics (api with KORTIX_PROCESS_ROLE=all and the worker scaled to 0, gateway and ECS frontend = immutable :X.Y.Z image; Vercel frontend = promote), what undoes a rollback (any deploy-prod run, any push to prod), the DB/migration-drift check that is the real blocker, and how a later promote returns prod to latest. Load WHENEVER the user wants to roll back / revert / downgrade / 'go back a version' on prod, asks how the rollback or the frontend rebuild-skip behavior works, or needs to run rollback-prod.yml. Pairs with kortix-release (the forward direction)."
---

# Kortix Rollback

The inverse of **kortix-release**. A release moves prod FORWARD onto new code; a
rollback re-points prod at an OLDER already-released `vX.Y.Z`, reusing that
release's prebuilt artifacts (zero rebuild). Use it when a shipped version is
breaking and the move is "go back now, fix forward later." The next forward
release still comes from `staging`, not directly from `dev`.

> A rollback is **temporary, never sticky.** It rolls ECS services and promotes
> an old Vercel build. It never pushes to `prod`, never touches `VERSION` or a
> branch, and never moves an image tag. The next `deploy-prod` run supersedes it
> and returns prod to the version in `prod:VERSION` (see §6).

## 1. The one command

```bash
gh workflow run rollback-prod.yml --repo kortix-ai/CompanyOS --ref prod \
  -f version=vX.Y.Z -f reason="<incident summary>" -f confirm="ROLLBACK PROD"
```

`--ref prod` is required: the job runs in `environment: prod`, which admits the
`prod` branch only. The run shares the `deploy-prod` concurrency group with
`deploy-prod.yml`, so a rollback dispatched during a release roll starts when
that roll ends. GitHub keeps one pending run per group: a rollback dispatched
while a `deploy-prod` run waits replaces the waiting run.

It plans each surface from the images that exist for `X.Y.Z` (a surface with no
`:X.Y.Z` image is skipped), then rolls in this order, one step after the other:

1. **api (ECS)**: `ecs-deploy.sh prod kortix/kortix-api:X.Y.Z --process-role all`.
   The api tasks run the scheduled jobs. After that rollout is stable the script
   scales `kortix-prod-worker` to 0. The worker is never rolled here.
2. **gateway (ECS)**: `kortix/kortix-gateway:X.Y.Z`.
3. **frontend (ECS)**: `kortix/kortix-frontend:X.Y.Z`, verified on
   `prod-fe-ecs.kortix.com/api/health`.
4. **frontend (Vercel)**: promotes the production deployment whose commit message
   names `release vX.Y.Z`. Skipped without `VERCEL_TOKEN`.

A failed step stops the run: the surfaces before it are on `X.Y.Z`, the ones
after it are on the current version. Read the step log, not the summary table:
the summary prints the plan, not the result. Re-run with `-f surfaces=<the rest>`.

What it does **not** do:
- It moves no image tag. `:latest`, `:prod` and `:stable` stay on the current
  version, so self-hosted boxes keep what they run.
- It opens no pull request and merges nothing into `prod` (the job has
  `contents: read`).
- It does not roll the database back (§4).

## 2. Per-surface mechanics

**Backend (API, worker, gateway) and the ECS frontend run immutable images on
ECS Fargate.** `infra/scripts/ecs-deploy.sh` registers a new task-definition
revision that points at the `:X.Y.Z` image and waits until the service is
stable. The image is frozen, so the roll is exact.

**The Vercel frontend is built by Vercel from the `prod` branch source.** There
is no image tag. A Vercel rollback is a **promote** of the old production
deployment. The branch still holds the newer frontend code.

## 3. What undoes a rollback

Nothing records that prod is rolled back: the state lives only in ECS and
Vercel. Each of these returns prod to the version in `prod:VERSION`:

- **Any `deploy-prod.yml` run.** A push to `prod` (a release merge) or a manual
  dispatch (`rebuild_desktop`, a re-run) rolls worker, api, gateway and web to
  `prod:VERSION` and switches the api back to `KORTIX_PROCESS_ROLE=web`. Do not
  dispatch `deploy-prod.yml` while prod is rolled back, unless you mean to roll
  forward.
- **A push to `prod` rebuilds the Vercel frontend** from branch source.
  `apps/web/scripts/vercel-ignore.sh` (`ignoreCommand` in `apps/web/vercel.json`)
  skips that build when the push changes only files under `infra/`, and builds
  on any doubt.

Until one of these runs, the worker stays at 0 and the api runs the scheduled
jobs (`KORTIX_PROCESS_ROLE=all`). Nothing expires that state: plan the roll
forward.

## 4. Safety check BEFORE you roll — DB / state drift is the real blocker

The image-reuse + Vercel-promote mechanics work for any released version. What
actually makes a rollback unsafe is **forward state the old code can't handle** —
overwhelmingly the **database**.

Migrations in this repo are **forward-only and additive by convention** (`ADD
COLUMN/VALUE`, `CREATE … IF NOT EXISTS`). Against additive migrations old code is
safe: the live schema is a strict **superset** of what the old version needs.
**Never reverse a migration** — that's what breaks things, not rolling code back.

The danger is a **destructive** migration between the target and current — a `DROP
COLUMN`, `RENAME`, `ALTER … TYPE`, or a new `NOT NULL`. Old code hitting that
breaks. The plan step prints how many migrations prod has that `vX.Y.Z` lacks,
and a `::warning::` names the files that contain one of those statements. It
does not refuse: a person decides. Check it before you dispatch:

```bash
git diff vX.Y.Z..origin/prod -- packages/db/migrations
```
- All additive (`ADD …`, `CREATE … IF NOT EXISTS`) → **DB-safe** to roll there.
- Any `DROP` / `RENAME` / `ALTER … TYPE` / new `NOT NULL` → **stop and think.**

Lesser, non-DB couplings (rare long tail): forward-written persisted state old code
can't parse (queue/cache formats), or external contract changes (Stripe API
version, webhook shapes).

### Kortix Apps: static hosting and retention do not roll back

Two Apps changes ship in one release and survive a code rollback:

1. **Static Apps go offline on an older api.** A static App is served by the api
   from storage (`apps/api/src/apps/static-site.ts`) and has no `app_runtimes`
   row. An api that predates that file requires a runtime, so every static App
   answers with a status page until the next promote. `rollback-prod.yml`
   refuses such an api target unless `static_apps_ack` is exactly
   `STATIC APPS OFFLINE`. Rolling only `gateway,frontend` is not affected.
2. **Retired deployments stay retired.** The first maintenance pass after the
   release retires every ready deployment beyond the active one and the newest
   `KORTIX_APPS_RETAINED_DEPLOYMENTS` (default 5), 50 Apps per pass. It tears
   down their runtimes and images; `reclaimAppArtifacts` deletes their archives
   24 h later. A rollback cannot bring them back. Before the first release,
   count what it will retire:

   ```sql
   select app_id, count(*) - 6 as retired
   from kortix.app_deployments where status = 'ready'
   group by 1 having count(*) > 6;
   ```

   To defer it, set `KORTIX_APPS_RETAINED_DEPLOYMENTS` high on prod for that
   release and lower it on the next one.

### Email: received mail waits for the roll-forward

From the release that stores each received email before the ack (KRTX-2235
step 3), the api puts Email on the `integration.events.email` job queue. An
older api never claims that queue, so emails stored before the rollback stay
`queued` until a later promote runs them; Resend got its 200 and does not
resend. Nothing is lost, only late. List what waits:

```sql
select job_key, created_at from kortix.job_queue
where queue = 'integration.events.email' and status = 'queued' order by created_at;
```

If a sender must not wait and the rollback target has the Resend route
(`POST /v1/webhooks/email/resend`, first shipped after v0.14.8), replay that
email from the Resend dashboard: the older api handles it, and the stored copy
is a no-op at the roll-forward (its session create already started, or its
follow-up key exists). A target without that route receives no Resend mail at
all; Resend's own retries (8 over about 31 h) then decide what arrives after
the roll-forward. Delete nothing.

## 5. Per-surface availability (the engine handles this)

You can't roll a surface BELOW where it existed. The gateway only entered prod
at ~v0.9.72 (image exists from 0.9.69), so there is no `kortix-gateway:0.9.68`.
The workflow checks each image (Docker Hub tags API) and **skips any surface with
no `:vX.Y.Z` image** rather than wedging ECS on `ImagePullBackOff`.

## 6. Resuming — a later release returns prod to LATEST

You do NOT manually undo a rollback. To resume, get the fix onto `staging` and
**Promote to Production** (see kortix-release). Its merge into `prod` runs
`deploy-prod.yml`, which rolls ECS to the new version, scales the worker back
up, and Vercel builds the latest frontend.

## 7. Gotchas

- **Never roll an ECS service from a laptop while a deploy workflow can run**
  (learnings ledger, 2026-11-01): the workflow's concurrency group does not see
  a local roll. Use this workflow.
- **Verify after:** `api.kortix.com/v1/health` (version), ECS service health,
  `prod-fe-ecs.kortix.com/api/health`, and the live Vercel production deployment
  (`/v9/projects/{id}` → `targets.production`).
