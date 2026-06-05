---
name: kortix-release
description: "How to cut a Kortix production release — the versioning philosophy (when patch vs minor vs major) and the exact flow: derive the release title + notes from the FULL git log since the last release, run the Promote workflow, then deploy + verify prod. Load WHENEVER the user wants to release, promote, cut/ship a version, publish a release, or bump the version. The release notes ARE the public /changelog, so they must be 100% accurate to what shipped."
---

# Kortix Release

How a clean, accurate production release happens. Two halves: **what version** (the
bump philosophy) and **how** (notes derived from the real git log, then promote →
deploy → verify). The release notes you write become the GitHub Release, which is
exactly what the public **`/changelog`** page renders — so they must reflect what
actually shipped, nothing invented, nothing missed.

Pairs with **kortix-voice** (how the notes read). The version source of truth is the
root **`VERSION`** file; `vX.Y.Z` tags are immutable and map 1:1 to a commit + image.

## 0. Golden rule — prod ships ONLY via main → promote

**The only way to change prod is: land it on `main` first, then run the Promote
workflow (main → review-gated release PR → `prod`).** Never `git push …:prod`,
never open a manual PR into `prod`, never cherry-pick onto `prod`. `prod` must
always be a strict subset of `main` — a direct-to-prod change makes them diverge
(the fix lives in prod but not the trunk). This holds even for urgent outage
hotfixes: commit the fix to `main`, then promote.

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

Releases run off the **`main`** branch. `prod` only ever receives promotions.

### Step 1 — find the last released version
```bash
cd suna
git fetch origin --tags --quiet
PREV="$(git tag -l 'v[0-9]*.[0-9]*.[0-9]*' --sort=-v:refname | head -1)"   # e.g. v0.9.6
echo "last release: $PREV  | prod VERSION: $(git show origin/prod:VERSION)"
```

### Step 2 — read EVERY commit since that release (this is the source of truth)
```bash
git log "$PREV..origin/main" --no-merges --pretty='- %s (%h)'
```
This complete list is the raw material for the notes. Skim full bodies for anything
non-obvious: `git log "$PREV..origin/main" --no-merges`. Also useful for scope:
`git diff --stat "$PREV..origin/main"`.

> The notes must account for **all** of these commits — that's the whole point.
> Don't summarize from memory; summarize from this log. Nothing invented, nothing dropped.

### Step 3 — write the title + notes FROM that log
- **title** — one human line capturing the theme (sentence case, plain, outcome-first).
  e.g. `"Warm pool, billing fixes, and a faster session boot"`.
- **notes** — a readable, grouped summary of what's in the log. Lead with user-facing
  changes; fold internal/infra commits into plain outcomes. Markdown bullets. Follow
  **kortix-voice**: plain language, no hype/banned words, "open / source-available".
  Group loosely (e.g. new / improved / fixed) when there's enough to group.

Quality bar: a non-technical reader understands what changed; a teammate can map every
notable commit in the log to a line in the notes.

### Step 4 — pick the bump (§1) and promote
`promote.yml` **requires** `title` and `notes` (this is enforced — you cannot cut a
release without describing it). They're written into the annotated tag (subject =
title, body = notes), which deploy-prod turns into the GitHub Release + changelog.
```bash
gh workflow run promote.yml --repo kortix-ai/suna --ref main \
  -f title="<title>" -f notes="$(cat <<'EOF'
<markdown notes>
EOF
)" -f bump=patch
```
Use `-f version=X.Y.Z` instead of `-f bump=` only for an explicit version (e.g. the
first `1.0.0`). Watch it: `gh run watch <id> --exit-status`. It bumps VERSION, commits
to main, tags `vX.Y.Z` (annotated with your title/notes), and fast-forwards `prod`.

### Step 5 — make sure the image for this commit is built
deploy-prod **retags `kortix/kortix-api:dev-latest`** → it does NOT rebuild. So the
dev build of the promoted commit must be green first:
```bash
gh run list --repo kortix-ai/suna --workflow deploy-dev.yml --limit 3 \
  --json status,conclusion,headSha
```
(Web-only changes don't rebuild the API image — that's fine; they ship via Vercel from
the `prod` branch, and deploy-prod still stamps the version.)

### Step 6 — deploy is automatic; just verify
A successful Promote **auto-triggers deploy-prod** (via a `workflow_run` trigger —
the promote's `prod` push uses `GITHUB_TOKEN` which can't fire the `push` event, so
`workflow_run` is what wires it). On promote success the full prod pipeline runs:
retag image `:X.Y.Z`+`:latest`, roll `kortix-prod` ECS, cut the GitHub Release; Vercel
auto-deploys the `prod` branch (kortix.com). **Nothing to dispatch.** Just watch + verify:
```bash
gh run list --repo kortix-ai/suna --workflow deploy-prod.yml --limit 1   # the auto run
# once the "Deploy API to prod (ECS)" job is completed/success:
curl -fsS https://api-prod.kortix.com/v1/health   # version should be the new X.Y.Z
gh release view "vX.Y.Z" --repo kortix-ai/suna --json name,body   # title + notes present
```
Fallback (if the auto run didn't fire, or to re-run): `gh workflow run deploy-prod.yml
--ref prod`. Concurrency is `cancel-in-progress: false`, so cancel a stuck/queued run
first (`gh run cancel <id>`).
deploy-prod also: retags the image `:X.Y.Z`+`:latest`, cuts the GitHub Release
(name = `vX.Y.Z — <title>`, body = your notes + an auto compare link), and Vercel
auto-deploys the `prod` branch (new.kortix.com).

## 3. Gotchas (hard-won)

- **Promote auto-runs deploy-prod via `workflow_run`** (the prod push itself uses
  `GITHUB_TOKEN` which can't fire the `push` event, so `workflow_run` on Promote-
  completion is the wire). So a promote deploys everything; you only dispatch
  deploy-prod manually as a fallback/re-run.
- **deploy-prod concurrency = `cancel-in-progress: false`.** A slow desktop build or a
  zombie queued run blocks the next deploy — cancel it first.
- **Don't promote a moving `main`.** If commits are still landing, each cancels the dev
  build and `:dev-latest` can't settle — wait until pushing stops, then promote that HEAD.
- **The `/changelog` page shows only `≥ 1.0.0`** and reads GitHub Release bodies — so a
  thin/auto-generated body shows up as a thin entry. Write real notes (Step 3).
- **VERSION is the source of truth**; the version field in `/v1/health` is stamped by
  deploy-prod's task-def, not baked into the image.

## 4. Undo a bad / premature release

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

## Checklist

1. `git log $PREV..origin/main` read in full — notes account for all of it.
2. Bump chosen per §1 (default patch).
3. title + notes written in kortix-voice, accurate to the log.
4. `promote.yml` run with title + notes; dev build for that commit is green.
5. deploy-prod auto-ran on promote success, ECS green, api-prod on the new version.
6. GitHub Release shows the title + notes → `/changelog` reads cleanly.
