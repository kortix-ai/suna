---
name: kortix-rollback
description: "How to roll Kortix PRODUCTION back to an older already-released version — the inverse of a release. Covers the one-dispatch rollback-prod.yml engine, the per-surface mechanics (API + gateway = Argo image-tag swap; frontend = Vercel promote), the all-important Vercel frontend behavior (why a backend-only push can 'clobber' a FE rollback, and the 'don't rebuild the FE for backend-only pushes' skip that fixes it), the DB/migration-drift safety check that is the real blocker, and how a later promote returns prod to latest. Load WHENEVER the user wants to roll back / revert / downgrade / 'go back a version' on prod, asks how the rollback or the frontend clobber/skip behavior works, or needs to run rollback-prod.yml. Pairs with kortix-release (the forward direction)."
---

# Kortix Rollback

The inverse of **kortix-release**. A release moves prod FORWARD onto new code; a
rollback re-points prod at an OLDER already-released `vX.Y.Z`, reusing that
release's prebuilt artifacts (zero rebuild). Use it when a shipped version is
breaking and the move is "go back now, fix forward later." The next forward
release still comes from `staging`, not directly from dev/`main`.

> A rollback is **temporary, never sticky.** It only flips image tags + re-promotes
> an old frontend build; it never touches `VERSION` or the trunk. The next promote
> supersedes it and returns prod to latest (see §6). So rolling back never "wedges"
> the release pipeline.

## 1. The one command

```bash
gh workflow run rollback-prod.yml --repo kortix-ai/suna --ref main \
  -f version=vX.Y.Z -f reason="<incident summary>" -f confirm="ROLLBACK PROD"
```

It rolls **frontend AND backend** and handles each surface independently:
- **Frontend** → promoted back to vX.Y.Z immediately (Vercel API, no rebuild).
- **Backend** (api, gateway) → opens a **review-gated PR into `prod`** that pins
  `image.tag`. Merge it → Argo CD rolls those Deployments to the `:vX.Y.Z` images.

So a rollback is **2 actions**: dispatch, then merge the backend PR. The backend PR
is the one gated step (prod is review-protected — `enforce_admins:true`,
`required_reviews:1`, `allow_force:false`; there is no force-push path).

## 2. Why the two halves work completely differently

This is the thing to internalize.

**Backend (API + gateway) runs a Docker image.** Rollback = point Argo CD's GitOps
source (`infra/k8s/envs/prod/values.yaml` + `gateway-values.yaml` `image.tag`) at
the old, immutable, prebuilt `:vX.Y.Z` image. Argo (auto-sync + selfHeal) pulls it.
Clean and exact — the image is frozen.

**Frontend is built by Vercel from the `prod` branch SOURCE.** Vercel is
git-connected: **every push to `prod` rebuilds the frontend from whatever
`apps/web` source is on the branch at that moment** and makes it live at
kortix.com. There is no "image tag" to point at. A FE rollback is instead a
**promote**: "take that old v0.9.68 build and make it the live one again." It does
NOT change the branch source — the branch still holds the newer FE code.

## 3. The frontend "clobber" — and the skip that prevents it

Because *any* push to `prod` makes Vercel rebuild the FE from branch source, the
**backend** rollback merge (which only changes `infra/` YAML) would still drag the
frontend forward again:

```
1. FE promoted to old build       → kortix.com = vX.Y.Z FE   ✅
2. merge the backend rollback PR   → push to prod
3. Vercel rebuilds FE from branch source (still the NEW code) → kortix.com = new FE ❌ CLOBBERED
```

**The fix (shipped):** a Vercel **Ignored Build Step** —
`apps/web/scripts/vercel-ignore.sh`, wired via `apps/web/vercel.json`
`ignoreCommand`. On every prod push it asks one question:

> Did this push change anything **outside `infra/`**?
> - **No** (only `infra/` → it's a backend rollback) → **skip the FE rebuild.**
> - **Yes** (`apps/web`, `packages`, lockfile… → a real release/promote) → **build.**

In one line: **don't rebuild the FE for backend-only pushes.** It defaults to
BUILD on any uncertainty (no parent commit, empty diff, error) so it can never
silently drop a real FE deploy. Verified at real commits: an infra-only rollback
merge → SKIP; a promote merge (touches `apps/web`) → BUILD.

> Transitional note: `vercel.json` only takes effect on **prod** once a push
> carries it there. The next promote does that automatically. Until then, a
> rollback's FE may still get clobbered by the backend merge — re-run the workflow
> with `-f surfaces=frontend` to re-promote the FE (the workflow prints this).

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
breaks. The workflow CANNOT detect this; a human must eyeball it. One command:

```bash
git diff vX.Y.Z..origin/prod -- packages/db/migrations
```
- All additive (`ADD …`, `CREATE … IF NOT EXISTS`) → **DB-safe** to roll there.
- Any `DROP` / `RENAME` / `ALTER … TYPE` / new `NOT NULL` → **stop and think.**

Lesser, non-DB couplings (rare long tail): forward-written persisted state old code
can't parse (queue/cache formats), or external contract changes (Stripe API
version, webhook shapes).

## 5. Per-surface availability (the engine handles this)

You can't roll a surface BELOW where it existed. The gateway only entered prod EKS
at ~v0.9.72 (image exists from 0.9.69), so there is no `kortix-gateway:0.9.68`. The
workflow checks each image (Docker Hub tags API) and **skips any surface with no
`:vX.Y.Z` image** rather than wedging Argo on `ImagePullBackOff`. It also leaves
the root `VERSION` at the current prod number so deploy-prod's retag can never
overwrite the `:vX.Y.Z` rollback image.

## 6. Resuming — a later promote returns prod to LATEST automatically

You do NOT manually undo a rollback. To resume, get the fix onto `staging`, wait
for staging deploy + QA, then **Promote to Production** (see kortix-release).
The release PR carries the staging candidate into prod, Vercel builds the latest
FE, and Argo rolls the latest API/gateway images. The rollback evaporates. No
manual Vercel step to resume.

## 7. Gotchas

- **The deploy-prod run on the backend merge goes partly red** (its version-watch
  waits for the current `VERSION` while pods report the rolled version; release-
  create re-hits the existing release). Cosmetic — Argo does the real roll
  independently. Judge success by Argo health + `api.kortix.com/v1/health`.
- **Pushing `vercel.json` itself to prod rebuilds the FE** (it's under `apps/web`,
  so the skip says "build") — which clobbers a FE rollback. Let it ride to prod on
  a normal promote instead of a standalone push.
- **Backend merge needs a human** (review or, in a true break-glass, briefly
  relaxing `enforce_admins` then restoring it). There is intentionally no
  force-push-to-prod path.
- **Verify after:** `api.kortix.com/v1/health` (version), Argo app health, and the
  live Vercel production deployment (`/v9/projects/{id}` → `targets.production`).
