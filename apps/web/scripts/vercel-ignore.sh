#!/usr/bin/env bash
# Vercel "Ignored Build Step" for the frontend (apps/web).
#
#   exit 1  → BUILD the frontend (Vercel proceeds)
#   exit 0  → SKIP / cancel the build
#
# Two stages run in order:
#   1. FE-relevance — if a push changed NOTHING that feeds the apps/web build
#      (only sibling apps / infra / tests / docs), skip it on every branch.
#   2. Deploy-target — the permanent environments (main/staging/prod) always
#      deploy real FE changes; per-PR previews are OPT-IN to save build spend.
#
# For the permanent environments, default to BUILD on ANY uncertainty — never
# silently skip a real FE deploy. Per-PR previews invert that: default SKIP,
# build only when explicitly opted in (a "preview" label or a preview/* branch).
#
# WHY THIS EXISTS
# A backend/infra-only push to `prod` (e.g. a rollback that only flips
# infra/k8s image tags) must NOT rebuild + redeploy the frontend. Vercel
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
  production:*|*:main|*:staging|*:prod)
    echo "vercel-ignore: environment branch (${REF:-$VERCEL_ENV}) — building frontend."
    exit 1 ;;
esac

# A per-PR / feature-branch preview. Build only when explicitly opted in:
#   • branch named preview/*                       (no secret required), OR
#   • the PR carries a "preview" label             (needs GITHUB_TOKEN, PR-read).
case "$REF" in
  preview/*)
    echo "vercel-ignore: preview/* branch — building opt-in preview."
    exit 1 ;;
esac

PR="${VERCEL_GIT_PULL_REQUEST_ID:-}"
OWNER="${VERCEL_GIT_REPO_OWNER:-kortix-ai}"
SLUG="${VERCEL_GIT_REPO_SLUG:-suna}"
if [ -n "$PR" ] && [ -n "${GITHUB_TOKEN:-}" ]; then
  labels="$(curl -fsSL \
    -H "Authorization: Bearer $GITHUB_TOKEN" \
    -H "Accept: application/vnd.github+json" \
    "https://api.github.com/repos/$OWNER/$SLUG/issues/$PR/labels" 2>/dev/null)" || labels=""
  if printf '%s' "$labels" | grep -qE '"name"[[:space:]]*:[[:space:]]*"preview"'; then
    echo "vercel-ignore: PR #$PR carries the 'preview' label — building opt-in preview."
    exit 1
  fi
  echo "vercel-ignore: PR #$PR has no 'preview' label — skipping preview (add the label + redeploy to build one)."
  exit 0
fi

# No way to confirm an opt-in (no PR context or no GITHUB_TOKEN) → skip.
echo "vercel-ignore: preview not opted-in (no preview/* branch, no 'preview' label check available) — skipping. ref=$REF pr=${PR:-none}"
exit 0
