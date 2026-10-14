---
name: kortix-release
description: "How to cut a Kortix production release — the versioning philosophy (when patch vs minor vs major) and the exact flow: promote the newest dev SHA with a green Tests run to staging, let the staging PR's checks be the gate, fix forward on dev until it is green, then run Promote to Production and deploy + verify prod. Load WHENEVER the user wants to release, promote, cut/ship a version, publish a release, bump the version, or asks why a promotion is stuck. Load it too whenever another skill or doc needs to describe the release/promotion flow — this file is the one place it is written out in full."
---

# Kortix Release

How a clean, accurate production release happens. Three parts: **what version**
(the bump philosophy), **how staging gets a candidate** (promote the newest green `dev` SHA,
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
a PR into `dev` versus into `staging` — and point here for the rest.

## 0. Golden rule — prod ships ONLY from staging; staging takes the newest GREEN dev SHA

**The only normal way to change prod is: get a candidate onto `staging`, then
run Promote to Production (`staging` → reviewed release PR → `prod`).** Never
`git push …:prod`, never open a manual PR into `prod`, never cherry-pick onto
`prod`.

**Promoting to staging means promoting the newest `dev` SHA whose `Tests` run
on `dev` is green.** Every push to `dev` runs all ten `Tests` lanes (since
2026-10-12). Runs queue, so a run starts about every 25 minutes and tests the
`dev` HEAD of that moment. Do not wait for a particular SHA: take the newest
green one. Until 2026-10-12 the rule was "promote current HEAD and fix forward",
because nothing tested `dev`. That loop cost half of all release delay over
v0.13.45 to v0.13.56 (49 of 96 hours): every UI break merged to `dev` surfaced
only on the staging pull request, and each one cost a full promotion round
(4 rounds for v0.13.56). A green `dev` run is now the check before staging.

`dev` is the dev trunk. It can move fast and can temporarily be broken. A red
`dev` blocks the next promotion until someone fixes it forward; the run
comments the failing lanes and the suspect commits on the red commit.
`staging` is the production candidate branch. Production promotion always
reads from `staging`.

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

### Step 1 — `dev` tests every merge

`dev` takes PRs with no required CI: the developer's own box is the pre-merge
check (the **testing** skill, "your machine is the pre-merge gate"). After the
merge, the push to `dev` runs every `Tests` lane (`.github/workflows/tests.yml`).
A red run blocks nothing on `dev`, but it blocks the next promotion: fix it
forward on `dev`, or revert the culprit after 1 hour.

### Step 2 — promote the newest green dev SHA

Find the newest `dev` SHA with a green `Tests` run and push it to a dedicated
branch (unchanged, or as a merge into `staging` on a conflict; see below). Open a PR into `staging` as an ordinary two-parent merge
commit (never squash — squashing a promotion PR would rewrite the SHAs the
release notes and migration cost analysis were verified against). The
pre-push hook skips `promote/*`: CI already tested the SHA.

```bash
cd suna || exit 1
SHA="$(gh run list --repo kortix-ai/suna --workflow tests.yml --branch dev --status success \
  --limit 20 --json headSha,event --jq '[.[] | select(.event == "push" or .event == "schedule")][0].headSha')"
[ -n "$SHA" ] || { echo "No green Tests run on dev: fix dev first."; exit 1; }
SHA10="${SHA:0:10}"
git fetch origin dev
git push origin "$SHA:refs/heads/promote/dev-$SHA10"
gh pr create --repo kortix-ai/suna --base staging --head "promote/dev-$SHA10" \
  --title "Promote dev $SHA10 to staging" \
  --body "Promotes dev $SHA, the newest dev SHA with a green Tests run, to staging for the next release."
```

If no green run exists, `dev` is red: fix `dev` first (the red run's commit
comment names the failing lanes and suspects). Do not promote a red SHA.

`staging` always holds commits `dev` lacks: each promotion's merge commit, the
VERSION bump, and any hotfix. `dev` takes only squash merges, so `staging` never
becomes an ancestor of `dev`. GitHub merges the promotion PR cleanly unless one
of those staging-only changes conflicts with `dev`. A conflicting promotion PR
runs no workflow at all: GitHub builds no merge ref (2026-10-13, #9701). Check
with `git merge-tree --write-tree origin/staging "$SHA"` before you push. On a
conflict, build the branch as a merge instead:

```bash
git switch --detach origin/staging
git merge --no-ff -m "Merge dev $SHA10 into staging" "$SHA" || {
  git read-tree --reset -u "$SHA"     # take the tested tree for every file
  git commit --no-edit
}
git diff --quiet "$SHA" && echo "tree == $SHA"                # must print
git push origin "HEAD:refs/heads/promote/dev-$SHA10"
```

The tree then equals the green dev SHA's tree, so the dev run tested exactly
what ships; the PR's lanes run again because its head SHA differs. When a hotfix
lands on `staging`, squash-merge its content into `dev` the same day, so the
fix also ships in every later promotion.

### Step 3 — the staging PR is the gate

The PR into `staging` runs `Tests`, `CI`, CodeQL (`Analyze
javascript-typescript`), Trivy filesystem scan, gitleaks, the `packages/db`
migration gates (`Migrations are sequential`, `Migration files are well-formed`,
`Applies cleanly to a fresh DB`, `Schema matches migrations`, `Squawk
(zero-downtime lint) on new migrations`, `Migrations are immutable`),
`translation catalogs keep key order`, `committed .env profiles are encrypted`,
API typecheck, frontend build, sandbox-agent build, and the Terraform/Checkov
scanners.

`Tests` starts with `reuse dev verdict`. When the PR's head SHA already has a
green `Tests` run on `dev`, the ten lanes skip and the job summary links that
run: the lanes test the head SHA, so the dev run is the same proof. The other
workflows still run (CodeQL is the long pole, about 15 min). A hotfix branch
has no dev run, so its lanes run.

None of these is configured as a GitHub *required* check on `staging` —
**you enforce it by reading the PR, not by relying on a merge block.**
A failed `Tests` run on this PR reruns its failed jobs once automatically
(`rerun-failed-once.yml`) and names them on the PR; a job that passes on the
rerun is a flake to fix or quarantine.

Merge only when **all** of these hold:

- every check has **finished** (no `IN_PROGRESS`, no `QUEUED`) and every one
  **passed** — `gh pr checks <pr> --repo kortix-ai/suna`;
- every review thread is resolved — `staging`'s branch protection sets
  `required_conversation_resolution: true`, so GitHub blocks the merge button
  on an open thread (a CodeQL finding included) until you resolve or reply to it;
- Step 5's migration cost pass is done for every new migration in the diff;
- **one time, until the per-region Terraform state move finishes:** if
  `origin/staging` does not yet contain #9693 (the state move) and this
  promotion does, run right before the merge:
  `AWS_PROFILE=kortix node infra/terraform/scripts/statemove/copy-states.mjs staging`
  (every line `OK ... kms=yes tagged`), then
  `node infra/terraform/scripts/statemove/deny-old-keys.mjs staging`. Without it,
  Deploy Staging stops at "Check the regional state copy". Delete this bullet
  once staging's state is in eu-west-2.

**Never merge a staging PR with a pending or failing check "because it'll
probably pass."** A shard that never starts (bootstrap failure) gives no
signal either way — treat it as failing, not as passing-by-omission.

### Step 4 — fix forward, then refresh the promotion

Every red check is fixed **at the root, on `dev`** — never by patching the
promotion branch directly, and never by weakening the check:

1. Branch off `dev`, fix the failure test-first, open a PR into `dev`, and
   merge it verified (the **contributing** skill). See
   [references/fix-forward-traps.md](references/fix-forward-traps.md) for the
   traps that most often produce this kind of PR.
2. Wait for a green `Tests` run on `dev` that includes the fix, then **open a
   fresh promotion** of that SHA (Step 2). Close the stale promotion PR with a
   one-line comment pointing at the new PR number — do not force-push a
   promotion branch to a new SHA; a promotion PR's SHA is part of its own
   audit trail.
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
`dev` and re-promoted through Steps 2–7 (a new staging SHA means the release
PR's new run must be approved too). A failed gate run reruns its failed jobs once by
itself (`rerun-failed-once.yml`) and names them on the release PR. A job that
fails twice is real. A job that passes on the rerun is a flake: fix it or
quarantine it (the **testing** skill) in the same release cycle. A shard that
never gets past its own bootstrap gives no signal: it is rerun like any other.

### Step 9 — prod

**One time, until the per-region Terraform state move finishes:** if
`origin/prod` does not yet contain #9693 and this release does, first run
`AWS_PROFILE=kortix node infra/terraform/scripts/statemove/copy-states.mjs prod`
(every line `OK ... kms=yes tagged`), then
`node infra/terraform/scripts/statemove/deny-old-keys.mjs prod`. Without it,
Deploy Prod stops at "Check the regional state copy". Delete this paragraph
once prod's state is in eu-west-2.

Merge the release PR once `full suite + quality gates` is green on its head
SHA:

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
- **The `/changelog` page shows only `≥ 1.0.0`** and reads GitHub Release bodies — so a
  thin/auto-generated body shows up as a thin entry. Write real notes (Step 7).
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

1. The newest `dev` SHA with a green `Tests` run promoted as-is to
   `promote/dev-<sha10>` → PR into `staging` (ordinary merge, never squash).
2. Every staging-PR check finished and passed; every review thread resolved.
   Red checks fixed on `dev`, then the promotion refreshed (new branch, new
   PR, stale one closed with a pointer) — repeated until green.
3. Every new migration in the diff costed read-only against prod before merge.
4. Staging PR merged; `staging-api`, `gateway-staging`, and `staging.kortix.com`
   all verified on the promoted SHA.
5. `git log $PREV..origin/staging` read in full; title + notes written in
   kortix-voice, accurate to that log.
6. `promote.yml` run with title + notes; release PR merged into `prod` with
   `--merge` on a green gate (`--admin` only with the owner's explicit OK); environmental release-gate failures (staging cross-region
   latency) classified in a PR comment, everything else fixed on `dev` and
   re-promoted.
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
