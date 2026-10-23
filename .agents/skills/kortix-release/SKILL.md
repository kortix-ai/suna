---
name: kortix-release
description: "How to cut a Kortix production release — the versioning philosophy (when patch vs minor vs major) and the exact flow: one Promote to Production dispatch takes the dev HEAD through staging to a release PR into prod, whose one release suite is the only gate; fix forward on dev until it is green, then merge and verify prod. Load WHENEVER the user wants to release, promote, cut/ship a version, publish a release, bump the version, or asks why a promotion is stuck. Load it too whenever another skill or doc needs to describe the release/promotion flow — this file is the one place it is written out in full."
---

# Kortix Release

How a clean, accurate production release happens. Three parts: **what version**
(the bump philosophy), **how a candidate gets tested** (one Promote dispatch takes
the `dev` HEAD through staging to a release PR; its one release suite is the
only gate), and **how prod gets it** (merge → deploy → verify). The release notes you write become the GitHub Release, which
the public **`/changelog/releases`** page (Release history) renders as written, and the
weekly **`/changelog`** page merges by section (New / Improved / Fixed) into the
week the release was published — so they must reflect what actually shipped,
nothing invented, nothing missed.

Pairs with **kortix-voice** (how the notes read) and **kortix-rollback** (the
reverse direction). The version source of truth is the root **`VERSION`** file;
`vX.Y.Z` tags are immutable and map 1:1 to a commit + image.

This file is the single source of truth for the promotion flow. `AGENTS.md`
(`CLAUDE.md`), `.agents/skills/contributing/SKILL.md`, and
`.agents/skills/testing/SKILL.md` state only their own slice — what CI runs on
a PR into `dev` versus the release PR — and point here for the rest.

## 0. Golden rule — one dispatch, one suite, one gate

**The only normal way to change prod is one Promote to Production dispatch.**
It takes the `dev` HEAD, merges it into `staging` itself (a PR that runs
nothing), waits until staging serves that SHA, and opens the release PR into
`prod`. That PR runs the **release suite** once: the contract lanes on the
release tree, the deployed smoke and the browser journeys against staging,
CI, CodeQL and the scanners. Its check `full suite + quality gates` requires
every one of them green, and it is the only check that blocks anything
(testing reset, 2026-10-16). Never `git push …:prod`, never open a manual PR
into `prod`, never cherry-pick onto `prod`.

Nothing else tests the release tree: no `Tests` run on a push to `dev`, no
check on the PR into `staging`. Staging is the deploy target the suite runs
against, not a test stage. The nightly `Tests` run on `dev` (contract lanes,
no browser) warns early: check it before you promote, and fix `dev` forward
when it is red, because the release suite fails on the same lanes.

`dev` is the dev trunk. It can move fast and can temporarily be broken.
Production promotion always reads from `staging`.

## 1. Versioning philosophy — what bump?

Semver `MAJOR.MINOR.PATCH`. **Default to patch.** When unsure, patch.

- **Patch** (`1.0.0 → 1.0.1`) — the everyday release. Bug fixes, small features,
  copy, docs, infra, polish. **This is most releases.** Ship often; keep them small.
- **Minor** (`1.0.x → 1.1.0`) — a milestone worth signposting: a meaningful batch of
  new user-facing capability. Use sparingly, when a release is genuinely "a thing."
- **Major** (`1.x → 2.0.0`) — a breaking change or an architecture shift (the kind of
  jump v0.x → 1.0 was). Rare.

If the change set is "fixes + a couple small features" → **patch**. Don't inflate.

## 2. The flow (do this every time)

### Step 1 — `dev` takes verified merges; the nightly run warns

`dev` takes PRs with no required CI: the developer verifies the change by
using it (the **testing** skill). A push to `dev` runs no `Tests` lane. The
nightly run on `dev` (`.github/workflows/tests.yml`, 05:41 UTC) comments a red
result on the commit. Fix it forward on `dev`, or revert the culprit after 1 hour.

### Step 2 — check the nightly run and cost migrations

```bash
gh run list --repo kortix-ai/suna --workflow tests.yml --branch dev --event schedule \
  --limit 1 --json conclusion,headSha --jq '.[0]'
```

A red night means fix `dev` first. Then cost every new migration (Step 5)
before you dispatch: Promote applies it to the staging database within minutes.

### Step 3 — one dispatch: Promote to Production

Write the title and notes (Step 7 shows how), then:

```bash
gh workflow run promote.yml --repo kortix-ai/suna --ref dev \
  -f ref=dev -f title="<title>" -f notes="$(cat <<'EOF'
<markdown notes>
EOF
)" -f bump=patch
```

Promote then:

1. Resolves `ref` (default `dev`) to a SHA and pushes it to
   `promote/dev-<sha10>`. On a conflict with `staging` it builds the branch as
   a merge whose tree equals the dev SHA's tree (`git read-tree --reset -u`).
2. Opens the PR into `staging` and merges it as a merge commit (never squash).
   That PR runs no check.
3. Dispatches `build-staging.yml` for the merge SHA (a merge made with the
   workflow token starts no push workflow), waits for Build and Deploy
   Staging, then needs 8 consecutive `/health` reads where API, gateway and web
   all serve the merge SHA.
4. Creates or updates `release/vX.Y.Z`, opens the PR into `prod`, and approves
   the held runs on it, so the release suite starts.

`-f dry_run=true` prints every decision (SHA, conflict, PR, version) and
changes nothing. `-f ref=staging` skips the dev leg: the hotfix path for a
commit already on `staging`.

### Step 4 — the release suite is the gate; fix forward

Merge only when `full suite + quality gates` is green on the release PR's head
SHA. A red suite is fixed **at the root, on `dev`** — never on the release or
promotion branch, never by weakening a check (the fix-forward traps are in
[references/fix-forward-traps.md](references/fix-forward-traps.md)). Then
dispatch Promote again: one new tree, one new run. Nothing runs twice on the
same tree.

### Step 5 — cost every new migration against prod, before merging

For every migration file new in the diff versus what's already applied to prod
(`select name from kortix_migrations.pgmigrations order by id desc limit 5;` on
the real prod database), run it read-only against prod first:

```bash
PGOPTIONS='-c default_transaction_read_only=on -c statement_timeout=15000' \
  psql "$PROD_DATABASE_URL" -c "explain (analyze, buffers) <the migration's statement, read-only form>"
```

Get exact row counts, table size, and lock profile for the target table before
judging a migration safe. Pre-build any large `CREATE INDEX CONCURRENTLY` out of
band on prod, with the migration's **exact** statement, so the real deploy step
is a no-op (`CREATE INDEX CONCURRENTLY IF NOT EXISTS` on an index that already
exists does nothing). If the deploy step still hits `55P03` (lock timeout),
**retry by rerunning the migration job** — never by raising `lock_timeout` in a
plain migration (the **learnings** ledger, "Retry a hot-table ADD COLUMN that
hit its 2 s lock_timeout; never raise the timeout", 2026-09-25). Full costing
method: §4 "Gotchas" below and `packages/db/MIGRATIONS.md`.

### Step 6 — staging deploy

Promote dispatches `Build Staging Artifacts`, which starts `Deploy Staging`:
it applies pending migrations to the staging database and rolls staging.
Promote waits for the proof itself; to check by hand:

```bash
curl -fsS https://staging-api.kortix.com/v1/health | jq '{environment,version,commit}'
curl -fsS https://gateway-staging.kortix.com/health | jq '{version,commit}'
curl -fsS https://staging.kortix.com/api/health | jq '{version,commit}'
```

All three must report the exact SHA you promoted. A staging runtime check that
points at `dev.kortix.com` / `dev-api.kortix.com` is a broken staging setup, not
a passing gate.

### Step 7 — open the release PR

Derive the title and notes from the **full** commit log since the last release —
not from memory:

```bash
git fetch origin --tags --quiet
PREV="$(git tag -l 'v[0-9]*.[0-9]*.[0-9]*' --sort=-v:refname | head -1)"
git log "$PREV..origin/dev" --no-merges --pretty='- %s (%h)'
```

- **title** — one human line, sentence case, outcome-first
  (e.g. `"Warm pool, billing fixes, and a faster session boot"`).
- **notes** — markdown bullets grouped loosely (new / improved / fixed),
  user-facing changes first, internal/infra commits folded into plain outcomes.
  Follow **kortix-voice**: plain language, no hype, "open source" never a
  license name. Every notable commit in the log maps to a line in the notes;
  nothing invented, nothing dropped — the notes are the public `/changelog`.

Then run:

```bash
Dispatch Promote with them (Step 3).

`promote.yml` **creates the `release/vX.Y.Z` PR into `prod` once**, then on every
later dispatch **updates the branch in place** (pushes the new content, keeps
the same PR). **It does not rewrite an already-open release PR's title or
body** — if the version, title, or notes need to change after the PR exists,
edit them by hand with `gh pr edit`. GitHub holds the bot-opened PR's
`tests-release.yml` run (`action_required`); `promote.yml` then approves it.
Only that pull request run's `full suite + quality gates` counts for the `prod`
ruleset. A dispatched run on the same SHA does not (v0.13.57: green dispatched
gate, PR still `BLOCKED`), so never dispatch a second gate. If the Promote
summary warns that approval failed, approve it yourself:
`gh api -X POST repos/kortix-ai/suna/actions/runs/<run id>/approve`.

### Step 8 — release gate triage

`tests-release.yml`'s `full suite + quality gates` job is the only *required*
check in the repository (on the PR into `prod`). Until 2026-10-06 staging's API
ran in `us-west-2` and its database in `eu-west-2`, so the owner decision of
2026-09-29 classified a `503 request_deadline` (55 s) or a flow timeout on the
release gate as **environmental**. Since 2026-10-06 both run in `eu-west-2`, so
that cross-region reason no longer holds: confirm with the owner before you
classify a timeout as environmental. Every other failure is fixed on
`dev` and re-promoted with one new dispatch (Step 3). A failed gate run reruns its failed jobs once by
itself (`rerun-failed-once.yml`) and names them on the release PR. A job that
fails twice is real. A job that passes on the rerun is a flake: fix it or
delete it (the **testing** skill) in the same release cycle; nothing is quarantined. A shard that
never gets past its own bootstrap gives no signal: it is rerun like any other.

### Step 9 — prod

Merge the release PR once `full suite + quality gates` is green on its head
SHA **and** one team member approved it. Since 2026-10-23 the `prod` ruleset
(20587235) requires 1 approving review with `require_last_push_approval`: an
approval counts only for the last push, so a re-promote that updates the
release branch needs a new approval. Under the SOC 2 Change Management Policy
the approver is not the person who started the release. Ask the owner for an
approver as soon as the gate goes green. Never bypass the review.

```bash
gh pr merge <release-pr> --repo kortix-ai/suna --merge
```

Never add `--admin` to merge over a red or missing gate unless the owner
approves that exact release in the conversation. Over v0.13.45 to v0.13.56, 9 of
12 releases merged that way, and a gate that is bypassed by habit stops
catching anything.

Confirm a `Deploy Prod` run exists for that merge SHA and succeeds, then verify
every surface on the new version:

```bash
curl -fsS https://api.kortix.com/v1/health | jq '{environment,version,commit}'
curl -fsS https://gateway.kortix.com/health | jq '{version,commit}'
curl -fsS https://kortix.com/api/health | jq '{version,commit}'
npm view @kortix/sdk version
npm view @kortix/agent-tunnel version
npm view @kortix/llm-catalog version
gh release view "vX.Y.Z" --repo kortix-ai/suna --json name,body,assets --jq '{name,assetCount:(.assets|length)}'   # 24 assets
```

Then check Better Stack for an API error, 5xx, or frontend-exception spike in
the minutes after the rollout.

### Step 10 — self-host `:stable`

`:stable` moves **only** on the user's explicit, per-release consent — never
implied by "we released" or "prod is healthy." Run `promote-self-host-stable.yml`
by hand when that consent is given.

### Step 11 — rollback

If a shipped version needs to come back: the **kortix-rollback** skill, not this
one. It is the inverse of Steps 7–9 (`rollback-prod.yml`, zero rebuild, the
frontend "clobber" trap, the DB-drift safety check).

## 3. Fix-forward traps

The failures that most often block Step 4 have known fixes. Read
[references/fix-forward-traps.md](references/fix-forward-traps.md) before
debugging one from scratch: out-of-order migration timestamps, stale
`mock.module` stubs after a refactor, source-anchor tests after a file move,
unintentional i18n catalog reordering, a stale `learnings/MEMORY.md`, and a
CodeQL alert in old code that a large diff surfaced for the first time — fix a
real finding on `dev`; dismiss a *proven* false positive on GitHub with a
written, evidence-backed justification, never silently.

## 4. Gotchas (hard-won)

- **deploy-prod concurrency = `cancel-in-progress: false`.** A slow desktop build or a
  zombie queued run blocks the next deploy — cancel it first.
- **deploy-prod retags; it does not rebuild.** The staging build for the exact
  promoted commit must already be green:
  `gh run list --repo kortix-ai/suna --workflow build-staging.yml --branch staging --limit 3 --json status,conclusion,headSha`.
- **`/changelog` and `/changelog/releases` show every published `vX.Y.Z` release** and read
  GitHub Release bodies — so a thin/auto-generated body shows up as a thin entry. The weekly
  page reads only the bullets under `### New`, `### Improved` and `### Fixed`; a body without
  those headings shows as its title alone. Write real notes (Step 7).
- **VERSION is the source of truth**; the version field in `/v1/health` is stamped by
  deploy-prod's task-def, not baked into the image.
- **A promotion PR is not a normal PR.** Do not squash it, do not push new
  commits onto it to "fix" a failure — fix on `dev` and open a fresh promotion
  (Step 4). Squashing or force-pushing it breaks the SHA trail the migration
  cost pass and the release notes were verified against.

## 5. Undo a bad / premature release

If a release was cut by mistake (and not yet truly published — i.e. no ECS roll / no
real Release), remove it cleanly. `dev` is protected from force-push, so revert there.
```bash
git push origin :refs/tags/vX.Y.Z                       # delete the tag
git push -f origin <prev-release-sha>:refs/heads/prod    # reset prod to the prior release
git revert --no-edit <version-bump-commit>               # put dev VERSION back; then push
gh release delete vX.Y.Z --repo kortix-ai/suna           # only if a Release was actually cut
# cancel any deploy-prod the prod reset triggered
```
Verify: tag gone, `prod` VERSION = prior, `dev` VERSION = prior, api-prod unchanged,
no `vX.Y.Z` Release.

> Note: `prod` branch protection is `allow_force_pushes:false` + `enforce_admins:true`,
> so the `git push -f …:refs/heads/prod` above only works if protection is temporarily
> relaxed. For a release that's ALREADY LIVE, do NOT force-push — use the
> **kortix-rollback** skill instead.

## Checklist

1. Last nightly `Tests` run on `dev` checked; red lanes fixed on `dev` first.
2. Every new migration in the diff costed read-only against prod before the dispatch.
3. `git log $PREV..origin/dev` read in full; title + notes written in
   kortix-voice, accurate to that log.
4. One `promote.yml` dispatch (`ref=dev`, title, notes); it merged into
   `staging`, staging served the SHA, and the release PR opened.
5. `full suite + quality gates` green on the release PR head (every check on
   that commit green); red fixed on `dev` and re-promoted with a new dispatch.
6. Release PR approved by a team member who did not start the release, then
   merged into `prod` with `--merge` (`--admin` only with the
   owner's explicit OK).
7. `Deploy Prod` confirmed for the merge SHA; api/gateway/frontend `/health`,
   the three npm packages, the GitHub Release (24 assets), and Better Stack all
   verified on the new version.
8. `:stable` moved only if the user explicitly asked for it this release.
9. **One-time per env: the `/internal/*` edge key** (#9272, and the pentest
   2026-10-13 fix that made the API enforce it too). Done on dev; staging and
   prod are open until this runs. Two gates read the key: the api-router worker
   (`INTERNAL_EDGE_KEY`, 404s a public caller) and the API itself
   (`KORTIX_INTERNAL_EDGE_KEY`, 404s `/internal/gateway/*` without the header,
   which also covers the public backend origins such as
   `api-ecs-fargate.kortix.com` that skip the worker). The worker forwards the
   header. Do it after a release carrying the pentest fix is live in the env,
   in this order. A wrong order breaks LLM inference, because the gateway calls
   `/internal/gateway/*` through the public API host.
   1. Generate a random 32-byte key. Never print it.
   2. Add `KORTIX_INTERNAL_EDGE_KEY` to the env's Secrets Manager blob
      `kortix-<env>-env` in its `blob_region` region (the **dotenvx-secrets**
      skill, "Which region to edit"; needs an MFA session) and to
      `apps/api/.env.<env>` with `dotenvx set`.
   3. Redeploy the GATEWAY only (new ECS deployment). Confirm it sends the
      header: gateway `GET /v1/models` with a PAT still returns 200.
   4. Redeploy the API. It now enforces the key.
   5. `wrangler secret put INTERNAL_EDGE_KEY --env <env>` on the api-router
      worker, and redeploy the worker.
   6. Verify: `curl -X POST https://<api-host>/internal/gateway/authenticate`
      and the same on `/%69nternal/...` and on the backend origin host all
      return 404, and a gateway chat call gives the same answer as before.
   Rollback: remove the key from the blob and redeploy the API, then delete the
   worker secret. The gateway header is harmless.
10. **One-time per env: dedicated App and preview edge secrets** (pentest
    2026-10-13, M-5). Unset, `KORTIX_APPS_EDGE_SECRET` and
    `KORTIX_PREVIEW_EDGE_SECRET` fall back to `API_KEY_SECRET`, so the master
    key is also a Cloudflare Worker secret. The API accepts a comma-separated
    `new,old` value, so the switch has no gap. Per env, for each of the two keys
    (Worker secrets `<ENV>_EDGE_SECRET` on `apps-router` and `preview-router`):
    1. Generate a random 32-byte value. Never print it.
    2. Set the key to `<new>,<API_KEY_SECRET value>` in `kortix-<env>-env` and
       `apps/api/.env.<env>`; redeploy the API.
    3. `wrangler secret put <ENV>_EDGE_SECRET --env <worker env>` with `<new>` on
       the matching Worker.
    4. Verify an App host and a preview host still answer, then set the key to
       `<new>` alone and redeploy the API.
    Rollback: restore `<new>,<old>` (step 2) and put the old Worker secret back.
