---
name: kortix-release
description: "How to cut a Kortix production release — the versioning philosophy (when patch vs minor vs major) and the exact flow: promote CURRENT main to staging, let the staging PR's checks be the gate, fix forward on main until it is green, then run Promote to Production and deploy + verify prod. Load WHENEVER the user wants to release, promote, cut/ship a version, publish a release, bump the version, or asks why a promotion is stuck. Load it too whenever another skill or doc needs to describe the release/promotion flow — this file is the one place it is written out in full."
---

# Kortix Release

How a clean, accurate production release happens. Three parts: **what version**
(the bump philosophy), **how staging gets a candidate** (promote current `main`,
fix forward until the staging PR is green), and **how prod gets it** (promote →
deploy → verify). The release notes you write become the GitHub Release, which
is exactly what the public **`/changelog`** page renders — so they must reflect
what actually shipped, nothing invented, nothing missed.

Pairs with **kortix-voice** (how the notes read) and **kortix-rollback** (the
reverse direction). The version source of truth is the root **`VERSION`** file;
`vX.Y.Z` tags are immutable and map 1:1 to a commit + image.

This file is the single source of truth for the promotion flow. `AGENTS.md`
(`CLAUDE.md`), `.agents/skills/contributing/SKILL.md`, and
`.agents/skills/testing/SKILL.md` state only their own slice — what CI runs on
a PR into `main` versus into `staging` — and point here for the rest.

## 0. Golden rule — prod ships ONLY from staging; staging always takes CURRENT main

**The only normal way to change prod is: get a candidate onto `staging`, then
run Promote to Production (`staging` → reviewed release PR → `prod`).** Never
`git push …:prod`, never open a manual PR into `prod`, never cherry-pick onto
`prod`.

**Promoting to staging always means promoting `origin/main`'s current HEAD —
not a hand-picked "last green" commit.** `main` runs no CI on its own PRs by
default (the **contributing** and **testing** skills), so `main` is red more
often than not; waiting for a green push run before promoting stalls releases
for hours and chases a moving target. Instead: promote current main now, let
the staging pull request's own checks be the gate, and fix forward on `main`
until those checks pass. This replaced a "wait for a green main SHA, promote,
find it broke anyway, re-promote" loop that cost a full day on 2026-09-28/29
(see the **learnings** ledger entry dated 2026-09-29 for the incident).

`main` is dev. It can move fast and can temporarily be broken. `staging` is the
production candidate branch. Production promotion always reads from `staging`.

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

### Step 1 — trunk stays fast

`main` takes PRs with no required CI: the developer's own box is the pre-merge
check (the **testing** skill, "your machine is the pre-merge gate"). A person
may add the `test` label for one explicit six-lane run (the **contributing**
skill). A daily `schedule` runs the six `Tests` lanes on `main` as a **non-blocking trunk
signal** (a push does not), and an automated "repair main" pass opens fix-forward PRs
(`fix(...): repair main after <sha> (...)`) when that scheduled run is red. **Neither
the scheduled run nor the repair pass blocks a promotion** — do not wait for either
before Step 2.

### Step 2 — promote current main

Take `origin/main` HEAD as-is. Push it to a dedicated branch and open a PR into
`staging` as an ordinary two-parent merge commit (never squash — squashing a
promotion PR would rewrite the SHAs the release notes and migration cost
analysis were verified against):

```bash
cd suna || exit 1
git fetch origin main
SHA="$(git rev-parse origin/main)"; SHA10="${SHA:0:10}"
git push origin "origin/main:refs/heads/promote/main-$SHA10"
gh pr create --repo kortix-ai/suna --base staging --head "promote/main-$SHA10" \
  --title "Promote main $SHA10 to staging" \
  --body "Promotes current main $SHA to staging for the next release. This PR's checks are the gate: anything red is fixed on main and this promotion is refreshed until every check passes."
```

**Do not wait for main's push run (Step 1) to be green first.** Open this PR
against whatever `origin/main` HEAD is right now.

### Step 3 — the staging PR is the gate

The PR into `staging` runs the full six-lane `Tests` suite (`core`,
`browser-1`…`browser-4`, `packages`) plus CodeQL (`Analyze
javascript-typescript`), Trivy filesystem scan, gitleaks, the `packages/db`
migration gates (`Migrations are sequential`, `Migration files are well-formed`,
`Applies cleanly to a fresh DB`, `Schema matches migrations`, `Squawk
(zero-downtime lint) on new migrations`, `Migrations are immutable`),
`translation catalogs keep key order`, `committed .env profiles are encrypted`,
API typecheck, frontend build, sandbox-agent build, and the Terraform/Checkov
scanners. None of these is configured as a GitHub *required* check on
`staging` — **you enforce it by reading the PR, not by relying on a merge
block.**

Merge only when **all** of these hold:

- every check has **finished** (no `IN_PROGRESS`, no `QUEUED`) and every one
  **passed** — `gh pr checks <pr> --repo kortix-ai/suna`;
- every review thread is resolved — `staging`'s branch protection sets
  `required_conversation_resolution: true`, so GitHub blocks the merge button
  on an open thread (a CodeQL finding included) until you resolve or reply to it;
- Step 5's migration cost pass is done for every new migration in the diff.

**Never merge a staging PR with a pending or failing check "because it'll
probably pass."** A shard that never starts (bootstrap failure) gives no
signal either way — treat it as failing, not as passing-by-omission.

### Step 4 — fix forward, then refresh the promotion

Every red check is fixed **at the root, on `main`** — never by patching the
promotion branch directly, and never by weakening the check. Use one PR per
round of fixes:

1. Branch off `main`, fix the failure test-first, open a PR into `main`, add the
   `test` label, and merge only on six green lanes (the **contributing** skill).
   See [references/fix-forward-traps.md](references/fix-forward-traps.md) for the
   traps that most often produce this kind of PR.
2. Once `main` has the fix, **open a fresh promotion**: a new
   `promote/main-<sha10>` branch and PR at the new `origin/main` HEAD. Close the
   stale promotion PR with a one-line comment pointing at the new PR number —
   do not force-push a promotion branch to a new SHA; a promotion PR's SHA is
   part of its own audit trail.
3. Repeat until the staging PR is fully green.

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

Merge (Step 3's ordinary merge commit) triggers `Build Staging Artifacts` then
`Deploy Staging`, which applies pending migrations to the staging database and
rolls staging. Proof of a real deploy, not just a green workflow:

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
git log "$PREV..origin/staging" --no-merges --pretty='- %s (%h)'
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
gh workflow run promote.yml --repo kortix-ai/suna --ref staging \
  -f title="<title>" -f notes="$(cat <<'EOF'
<markdown notes>
EOF
)" -f bump=patch
```

`promote.yml` **creates the `release/vX.Y.Z` PR into `prod` once**, then on every
later dispatch **updates the branch in place** (pushes the new content, keeps
the same PR). **It does not rewrite an already-open release PR's title or
body** — if the version, title, or notes need to change after the PR exists,
edit them by hand with `gh pr edit`. Approve the `tests-release.yml` run it
triggers on that PR.

### Step 8 — release gate triage

`tests-release.yml`'s `full suite + quality gates` job is the only *required*
check in the repository (on the PR into `prod`). Staging's API and its database
run in different AWS regions today (`us-west-2` API, `eu-west-2` DB — PR #7844
merged the colocation fix but it is not yet applied to the live staging infra),
so a `503 request_deadline` (55 s) or a flow timeout on the release gate is
**environmental**, not a product regression (owner decision, 2026-09-29).
Classify it as such in a PR comment and move on. Every other failure is fixed on
`main` and re-promoted through Steps 2–7 (a new staging SHA means the release
PR must be re-dispatched too). Rerun a failed job once; a shard that
never gets past its own bootstrap gives no signal, so rerun it rather than
reading it as a pass or a fail.

### Step 9 — prod

Merge the release PR:

```bash
gh pr merge <release-pr> --repo kortix-ai/suna --merge --admin
```

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
real finding on `main`; dismiss a *proven* false positive on GitHub with a
written, evidence-backed justification, never silently.

## 4. Gotchas (hard-won)

- **deploy-prod concurrency = `cancel-in-progress: false`.** A slow desktop build or a
  zombie queued run blocks the next deploy — cancel it first.
- **deploy-prod retags; it does not rebuild.** The staging build for the exact
  promoted commit must already be green:
  `gh run list --repo kortix-ai/suna --workflow build-staging.yml --branch staging --limit 3 --json status,conclusion,headSha`.
- **The `/changelog` page shows only `≥ 1.0.0`** and reads GitHub Release bodies — so a
  thin/auto-generated body shows up as a thin entry. Write real notes (Step 7).
- **VERSION is the source of truth**; the version field in `/v1/health` is stamped by
  deploy-prod's task-def, not baked into the image.
- **A promotion PR is not a normal PR.** Do not squash it, do not push new
  commits onto it to "fix" a failure — fix on `main` and open a fresh promotion
  (Step 4). Squashing or force-pushing it breaks the SHA trail the migration
  cost pass and the release notes were verified against.

## 5. Undo a bad / premature release

If a release was cut by mistake (and not yet truly published — i.e. no ECS roll / no
real Release), remove it cleanly. `main` is protected from force-push, so revert there.
```bash
git push origin :refs/tags/vX.Y.Z                       # delete the tag
git push -f origin <prev-release-sha>:refs/heads/prod    # reset prod to the prior release
git revert --no-edit <version-bump-commit>               # put main VERSION back; then push
gh release delete vX.Y.Z --repo kortix-ai/suna           # only if a Release was actually cut
# cancel any deploy-prod the prod reset triggered
```
Verify: tag gone, `prod` VERSION = prior, `main` VERSION = prior, api-prod unchanged,
no `vX.Y.Z` Release.

> Note: `prod` branch protection is `allow_force_pushes:false` + `enforce_admins:true`,
> so the `git push -f …:refs/heads/prod` above only works if protection is temporarily
> relaxed. For a release that's ALREADY LIVE, do NOT force-push — use the
> **kortix-rollback** skill instead.

## Checklist

1. `origin/main` HEAD promoted as-is to `promote/main-<sha10>` → PR into `staging`
   (ordinary merge, never squash). Not waiting for main's push run to be green.
2. Every staging-PR check finished and passed; every review thread resolved.
   Red checks fixed on `main`, then the promotion refreshed (new branch, new
   PR, stale one closed with a pointer) — repeated until green.
3. Every new migration in the diff costed read-only against prod before merge.
4. Staging PR merged; `staging-api`, `gateway-staging`, and `staging.kortix.com`
   all verified on the promoted SHA.
5. `git log $PREV..origin/staging` read in full; title + notes written in
   kortix-voice, accurate to that log.
6. `promote.yml` run with title + notes; release PR merged into `prod` with
   `--merge --admin`; environmental release-gate failures (staging cross-region
   latency) classified in a PR comment, everything else fixed on `main` and
   re-promoted.
7. `Deploy Prod` confirmed for the merge SHA; api/gateway/frontend `/health`,
   the three npm packages, the GitHub Release (24 assets), and Better Stack all
   verified on the new version.
8. `:stable` moved only if the user explicitly asked for it this release.
