#!/usr/bin/env bash
# Clone kortix-ai/suna and check out the PR head into a clean working dir,
# then print that dir on stdout. Authenticated with $GH_TOKEN.
#
# Usage:  WORKDIR=$(.kortix/automation/pr-bot/checkout-pr.sh)
#
# Works regardless of whether the session itself is GitHub- or Freestyle-
# backed: we always clone the real GitHub repo fresh, so the bot reviews
# exactly what GitHub sees on the PR.
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

require_env REPO PR_NUMBER

WORKDIR="${PR_BOT_WORKDIR:-/tmp/pr-bot/${REPO//\//_}-pr${PR_NUMBER}}"
rm -rf "$WORKDIR"
mkdir -p "$(dirname "$WORKDIR")"

# kortix-ai/suna is public, so a tokenless clone reads fine. If GH_TOKEN
# happens to be set (private repo, or you want to push a fix branch), use
# it; the token never lands in a git config file (scrubbed below).
if [ -n "${GH_TOKEN:-}" ]; then
  REMOTE="https://x-access-token:${GH_TOKEN}@github.com/${REPO}.git"
else
  REMOTE="https://github.com/${REPO}.git"
fi

log "cloning ${REPO} (PR #${PR_NUMBER}) → ${WORKDIR}"
git clone --quiet --no-tags "$REMOTE" "$WORKDIR"
cd "$WORKDIR"

# Fetch the PR head ref reliably via the refs/pull namespace (works even
# for forks). Land on a local branch named after the PR.
git fetch --quiet origin "pull/${PR_NUMBER}/head:pr-${PR_NUMBER}"
git checkout --quiet "pr-${PR_NUMBER}"

# Make the base ref available for diffing (default to the PR's base).
BASE_REF="${PR_BASE_REF:-$(git remote show origin | sed -n 's/.*HEAD branch: //p')}"
git fetch --quiet origin "${BASE_REF}:refs/remotes/origin/${BASE_REF}" 2>/dev/null || true

# Scrub the token from the stored remote so later tooling can't leak it.
git remote set-url origin "https://github.com/${REPO}.git"

log "checked out pr-${PR_NUMBER} (base: ${BASE_REF}), $(git rev-list --count "origin/${BASE_REF}..HEAD" 2>/dev/null || echo '?') commits ahead"
printf '%s\n' "$WORKDIR"
