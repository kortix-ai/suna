#!/usr/bin/env bash
# Vercel "Ignored Build Step" for the frontend (apps/web).
#
#   exit 1  → BUILD the frontend (Vercel proceeds)
#   exit 0  → SKIP / cancel the build
#
# Default to BUILD on ANY uncertainty — never silently skip a real FE deploy.
#
# WHY THIS EXISTS
# A backend/infra-only push to `prod` (e.g. a rollback that only flips
# infra/k8s image tags) must NOT rebuild + redeploy the frontend. Vercel
# auto-deploys the prod branch on every push, so without this an infra-only
# push would re-deploy the current FE and CLOBBER a Vercel "instant rollback"
# of the frontend. A real promote changes FE source (apps/web, packages,
# lockfile, …) so it still builds normally — only EXCLUSIVELY-infra/ pushes skip.
set -uo pipefail

# Diff paths repo-root-relative regardless of Vercel's rootDirectory (apps/web).
ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || exit 1
cd "$ROOT" || exit 1

# Need the previous commit to diff against. Vercel keeps >=2 commits for the
# ignore step (its own docs use `git diff HEAD^ HEAD`). If absent → BUILD.
git rev-parse --verify -q "HEAD^" >/dev/null || exit 1

changed="$(git diff --name-only HEAD^ HEAD 2>/dev/null)" || exit 1
[ -n "$changed" ] || exit 1   # unknown/empty diff → BUILD

# SKIP (exit 0) only if EVERY changed path is under infra/. Any other path
# (apps/, packages/, lockfile, root config, …) → BUILD (exit 1).
if printf '%s\n' "$changed" | awk '/^infra\//{next} {nonInfra=1} END{exit (nonInfra?1:0)}'; then
  echo "vercel-ignore: only infra/ changed since HEAD^ — skipping frontend build."
  exit 0
fi
echo "vercel-ignore: non-infra changes present — building frontend."
exit 1
