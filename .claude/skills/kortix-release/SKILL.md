---
name: kortix-release
description: "How to cut a Kortix production release — the versioning philosophy (when patch vs minor vs major) and the exact flow: derive the release title + notes from the FULL git log since the last release, run the Promote workflow, then deploy + verify prod. Load WHENEVER the user wants to release, promote, cut/ship a version, publish a release, or bump the version. The release notes ARE the public /changelog, so they must be 100% accurate to what shipped."
---

# Kortix Release

How a clean, accurate production release happens. Two halves: **what version** (the
bump philosophy) and **how** (notes derived from the real staging candidate, then
promote → deploy → verify). The release notes you write become the GitHub Release, which is
exactly what the public **`/changelog`** page renders — so they must reflect what
actually shipped, nothing invented, nothing missed.

Pairs with **kortix-voice** (how the notes read). The version source of truth is the
root **`VERSION`** file; `vX.Y.Z` tags are immutable and map 1:1 to a commit + image.

## 0. Golden rule — prod ships ONLY from staging

**The only normal way to change prod is: get the release candidate onto
`staging`, then run Promote to Production (`staging` → reviewed release PR →
`prod`).** Never `git push …:prod`, never open a manual PR into `prod`, never
cherry-pick onto `prod`.

`main` is dev. It can move fast and can temporarily be broken. `staging` is the
production candidate branch: only promote a dev ref to staging when it is ready
to ship, or open a targeted PR directly into `staging` for a specific release
candidate/hotfix. Production promotion always reads from `staging`.

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

Releases run off the **`staging`** branch. `main` is only the dev trunk.

### Step 1 — find the last released version
```bash
cd suna
git fetch origin --tags --quiet
PREV="$(git tag -l 'v[0-9]*.[0-9]*.[0-9]*' --sort=-v:refname | head -1)"   # e.g. v0.9.6
echo "last release: $PREV  | staging: $(git rev-parse --short origin/staging) | prod VERSION: $(git show origin/prod:VERSION)"
```

### Step 2 — read EVERY commit since that release (this is the source of truth)
```bash
git log "$PREV..origin/staging" --no-merges --pretty='- %s (%h)'
```
This complete list is the raw material for the notes. Skim full bodies for anything
non-obvious: `git log "$PREV..origin/staging" --no-merges`. Also useful for scope:
`git diff --stat "$PREV..origin/staging"`.

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

### Step 3.5 — staging must be live and green

Before promoting, verify the selected staging SHA is the live staging runtime:

```bash
curl -fsS https://staging-api.kortix.com/v1/health | jq '{environment,version,commit}'
curl -fsS https://staging.kortix.com/api/runtime-config | grep 'staging-api.kortix.com'
gh run list --repo kortix-ai/suna --branch staging --limit 10
```

`qa-staging` must target `staging.kortix.com` / `staging-api.kortix.com`. A green
run against dev is not a staging gate.

### Step 4 — run Promote to Production

`promote.yml` **requires** `title` and `notes` (this is enforced — you cannot cut a
release without describing it). They're written into the annotated tag (subject =
title, body = notes), which deploy-prod turns into the GitHub Release + changelog.
```bash
gh workflow run promote.yml --repo kortix-ai/suna --ref staging \
  -f title="<title>" -f notes="$(cat <<'EOF'
<markdown notes>
EOF
)" -f bump=patch
```
Use `-f version=X.Y.Z` instead of `-f bump=` only for an explicit version (e.g. the
first `1.0.0`). Watch it: `gh run watch <id> --exit-status`. It opens a
review-gated `release/vX.Y.Z` PR into `prod` with the version, notes, release
source SHA, and prod GitOps image pins. Production does not move until that PR is
merged.

### Step 5 — make sure the staging images for this commit are built
deploy-prod retags the exact staging images. It does NOT rebuild. So the staging
build for the promoted commit must be green first:
```bash
gh run list --repo kortix-ai/suna --workflow build-staging.yml --branch staging --limit 3 \
  --json status,conclusion,headSha
```

### Step 6 — merge the release PR, then verify
After the release PR merges to `prod`, `deploy-prod.yml` retags staging images to
`:X.Y.Z` + `:latest`, runs prod migrations, rolls EKS, cuts the GitHub Release,
and Vercel deploys `prod` to `kortix.com`.

```bash
gh run list --repo kortix-ai/suna --workflow deploy-prod.yml --limit 1
curl -fsS https://api.kortix.com/v1/health | jq '{environment,version,commit}'
gh release view "vX.Y.Z" --repo kortix-ai/suna --json name,body   # title + notes present
```

## 3. Gotchas (hard-won)

- **deploy-prod concurrency = `cancel-in-progress: false`.** A slow desktop build or a
  zombie queued run blocks the next deploy — cancel it first.
- **Don't promote a moving `staging`.** If commits are still landing, wait until
  staging deploy + QA settles, then promote that exact HEAD.
- **Staging is not dev.** If `staging.kortix.com/api/runtime-config` references
  `dev-api.kortix.com`, stop and fix staging before releasing.
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

> Note: `prod` branch protection is `allow_force_pushes:false` + `enforce_admins:true`,
> so the `git push -f …:refs/heads/prod` above only works if protection is temporarily
> relaxed. For a release that's ALREADY LIVE, do NOT force-push — use §5.

## 5. Roll back a LIVE release (prod is already serving it)

When a shipped version is broken and you need prod on an OLDER already-released
version NOW, **do not force-push prod and do not reverse migrations.** Use the
`rollback-prod.yml` workflow — the inverse of promote (forward → back), reusing the
target's prebuilt images (zero rebuild):
```bash
gh workflow run rollback-prod.yml --repo kortix-ai/suna --ref main \
  -f version=vX.Y.Z -f reason="<incident summary>" -f confirm="ROLLBACK PROD"
```
It opens a review-gated PR into `prod` that re-points `infra/k8s/envs/prod/values.yaml`
+ `gateway-values.yaml` `image.tag` at `:X.Y.Z`. A reviewer merges it → Argo CD
(auto-sync + selfHeal) rolls kortix-api + kortix-gateway to those images. Then:
- **Frontend:** Vercel → kortix.com → Deployments → the `vX.Y.Z` prod deployment →
  **Instant Rollback** (do this AFTER the merge so the Vercel rebuild can't clobber it).
- **DB:** left as-is. Forward-only migrations are additive, so the live schema is a
  superset of any older release — older code runs fine; reversing migrations is unsafe.
- **VERSION** stays at the current prod number so deploy-prod's retag can't overwrite
  the `:X.Y.Z` rollback image. The deploy-prod run on the merge goes partly red
  (version-watch / release-create) — cosmetic; Argo does the real roll.

The next promote of `staging` supersedes the rollback cleanly (`merge -s ours`) and moves
prod forward — i.e. "fix forward" just works again.

## Checklist

1. `git log $PREV..origin/staging` read in full — notes account for all of it.
2. Bump chosen per §1 (default patch).
3. title + notes written in kortix-voice, accurate to the log.
4. `staging.kortix.com` and `staging-api.kortix.com` verified on the staging SHA.
5. `promote.yml` run with title + notes; release PR merged into `prod`.
6. deploy-prod ran, EKS green, api.kortix.com on the new version.
7. GitHub Release shows the title + notes → `/changelog` reads cleanly.
