#!/usr/bin/env bash
# Vercel "Ignored Build Step" for the frontend (apps/web).
#
#   exit 1  → BUILD the frontend (Vercel proceeds)
#   exit 0  → SKIP / cancel the build
#
# Two stages run in order:
#   1. FE-relevance — if a push changed NOTHING that feeds the apps/web build
#      (only sibling apps / infra / tests / docs), skip it on every branch.
#   2. Deploy-target — staging and prod deploy real frontend changes. Dev and
#      per-PR previews run only on ECS and always skip Vercel builds.
#
# For staging and production, default to BUILD on ANY uncertainty. Dev and
# per-PR previews default to SKIP because ECS owns those frontend deployments.
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
# FE-relevant changes are present. The permanent environments always deploy;
# per-PR previews are OPT-IN (previews on every PR were the bulk of build spend).
REF="${VERCEL_GIT_COMMIT_REF:-}"
case "${VERCEL_ENV:-}:$REF" in
  production:*|*:staging|*:prod)
    echo "vercel-ignore: environment branch (${REF:-$VERCEL_ENV}) — building frontend."
    exit 1 ;;
esac

echo "vercel-ignore: dev and PR previews deploy on ECS only — skipping Vercel. ref=$REF"
exit 0
