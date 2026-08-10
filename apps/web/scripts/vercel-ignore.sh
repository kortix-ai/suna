#!/usr/bin/env bash
# Vercel "Ignored Build Step" for the frontend (apps/web).
#
#   exit 1  → BUILD the frontend (Vercel proceeds)
#   exit 0  → SKIP / cancel the build
#
# Two stages run in order:
#   1. FE-relevance — if a push changed NOTHING that feeds the apps/web build
#      (only sibling apps / infra / tests / docs), skip it on every branch.
#   2. Deploy-target — staging auto-builds. Production deploys through the
#      gated workflow. Dev uses ECS. PR previews use Platinum or Daytona.
#
# Staging defaults to BUILD on uncertainty. Dev and PR previews default to SKIP.
# Production auto-builds always skip because deploy-prod.yml owns that release.
#
# WHY THIS EXISTS
# A backend/infra-only push to `prod` (e.g. a rollback that only flips
# backend-only deployment metadata must NOT rebuild + redeploy the frontend. Vercel
# auto-deploys the prod branch on every push, so without this an infra-only
# push would re-deploy the current FE and CLOBBER a Vercel "instant rollback"
# of the frontend. A real promote changes FE source (apps/web, packages,
# lockfile, …) so it still builds normally.
#
# This is a backend-heavy monorepo: apps/web depends ONLY on packages/@kortix/*
# and never imports from any sibling app. So a push that exclusively touches
# other apps (api, cli, gateway, …), infra/, tests/, or docs/ CANNOT change the
# FE build output — skipping those is safe and is where most build spend goes.
# Anything else (apps/web, packages/, lockfile, root config, or an UNKNOWN new
# top-level path) → BUILD. Default to BUILD on any uncertainty.
set -uo pipefail

# Diff paths repo-root-relative regardless of Vercel's rootDirectory (apps/web).
ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || exit 1
cd "$ROOT" || exit 1

# Need the previous commit to diff against. Vercel keeps >=2 commits for the
# ignore step (its own docs use `git diff HEAD^ HEAD`). If absent → BUILD.
git rev-parse --verify -q "HEAD^" >/dev/null || exit 1

changed="$(git diff --name-only HEAD^ HEAD 2>/dev/null)" || exit 1
[ -n "$changed" ] || exit 1   # unknown/empty diff → BUILD

# ── Stage 1: FE-relevance ────────────────────────────────────────────────────
# Paths that provably cannot affect the apps/web build output. If EVERY changed
# path matches, skip on any branch. Sibling apps are safe because apps/web imports
# nothing from them (only packages/@kortix/*). Never add packages/ or root config
# here — those (and any UNKNOWN new top-level path) must fall through to a build.
SAFE='^(infra/|tests/|docs/|apps/(api|cli|desktop-electron|kortix-sandbox-agent-server|llm-gateway|mobile|sandbox|whitelabel-demo)/)'
if ! printf '%s\n' "$changed" | grep -qvE "$SAFE"; then
  echo "vercel-ignore: only non-FE paths (other apps / infra / tests / docs) changed since HEAD^ — skipping build."
  exit 0
fi

# ── Stage 2: deploy-target gate ──────────────────────────────────────────────
# FE-relevant changes are present. Staging always deploys; per-PR previews are
# OPT-IN (previews on every PR were the bulk of build spend).
#
# `prod` is NOT here: a push to prod must never auto-deploy the frontend.
# The 2026-08-10 v0.12.7 outage shipped the new frontend to kortix.com while
# the API was still on the old version (its prerequisite migration failed), so
# every access check called a route that did not exist yet. The prod frontend
# deploys ONLY from deploy-prod.yml's `deploy-web-vercel` job, which runs after
# `verify-live-version` proves the API serves the release. Belt-and-braces with
# `git.deploymentEnabled.prod: false` in vercel.json.
REF="${VERCEL_GIT_COMMIT_REF:-}"
case "${VERCEL_ENV:-}:$REF" in
  *:prod)
    echo "vercel-ignore: prod deploys only via deploy-prod.yml after the API is live — skipping auto build."
    exit 0 ;;
  production:*|*:staging)
    echo "vercel-ignore: environment branch (${REF:-$VERCEL_ENV}) — building frontend."
    exit 1 ;;
esac

echo "vercel-ignore: dev deploys on ECS; PR previews deploy in sandboxes — skipping Vercel. ref=$REF"
exit 0
