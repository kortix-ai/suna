#!/usr/bin/env bash
# Live end-to-end proof that the Kortix git smart-HTTP proxy
# (/v1/git/:projectId(.git)/{info/refs,git-upload-pack,git-receive-pack}) lets a
# client clone AND push a real project repo using ONLY a Kortix token — never a
# real host (GitHub) credential. The proxy resolves the project's
# backend + mints the upstream credential server-side.
#
# This runs against a REAL running API + an EXISTING git-backed project. It does
# NOT provision anything; point it at a project you already have.
#
# Required env:
#   KORTIX_URL     API base, e.g. http://localhost:8008   (default)
#   PROJECT_ID     a git-backed project UUID
#   KORTIX_TOKEN   a Kortix token scoped to that project:
#                    - a sandbox token (kortix_sb_…) for one of its sandboxes, OR
#                    - an account API key (kortix_…) / CLI PAT (kortix_pat_…)
#                      owning the project
# Optional:
#   BRANCH         base branch to read (default: the repo's HEAD)
#   PUSH=1         also exercise a write: push a throwaway branch, then delete it
#
# What it asserts:
#   READ   git ls-remote via the proxy returns refs (info/refs + upload-pack)
#   CLONE  a blobless clone through the proxy succeeds + has a working tree
#   PUSH   (PUSH=1) push a new commit to a throwaway branch, then delete it
#          (info/refs?service=git-receive-pack + receive-pack, write scope)
set -euo pipefail

KORTIX_URL="${KORTIX_URL:-http://localhost:8008}"
: "${PROJECT_ID:?set PROJECT_ID}"
: "${KORTIX_TOKEN:?set KORTIX_TOKEN}"

KORTIX_URL="${KORTIX_URL%/}"
PROXY_URL="${KORTIX_URL}/v1/git/${PROJECT_ID}.git"
AUTH_B64="$(printf 'x-access-token:%s' "$KORTIX_TOKEN" | base64 | tr -d '\n')"
HDR="http.extraHeader=AUTHORIZATION: basic ${AUTH_B64}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

pass() { printf '  \033[32mok\033[0m   %s\n' "$1"; }
fail() { printf '  \033[31mFAIL\033[0m %s\n' "$1"; exit 1; }

echo "git proxy → ${PROXY_URL}"

# ── READ: ref discovery (info/refs?service=git-upload-pack + nothing leaks) ──
REFS="$(git -c "$HDR" ls-remote "$PROXY_URL" 2>"$WORK/lsremote.err")" \
  || { cat "$WORK/lsremote.err"; fail "ls-remote through proxy"; }
[ -n "$REFS" ] || fail "ls-remote returned no refs"
pass "READ  ls-remote returned $(printf '%s\n' "$REFS" | wc -l | tr -d ' ') refs"

# The proxy URL must NEVER 30x/redirect to the real host (no upstream leak).
HTTP_CODE="$(curl -s -o /dev/null -w '%{http_code}' \
  -H "Authorization: Basic ${AUTH_B64}" \
  "${PROXY_URL}/info/refs?service=git-upload-pack")"
[ "$HTTP_CODE" = "200" ] || fail "info/refs returned HTTP ${HTTP_CODE} (expected 200)"
pass "READ  info/refs HTTP 200 (no upstream redirect)"

# Unauthenticated must be rejected with a git-style 401 challenge.
UNAUTH_CODE="$(curl -s -o /dev/null -w '%{http_code}' \
  "${PROXY_URL}/info/refs?service=git-upload-pack")"
[ "$UNAUTH_CODE" = "401" ] || fail "unauthenticated info/refs returned ${UNAUTH_CODE} (expected 401)"
pass "AUTH  unauthenticated info/refs → 401"

# ── CLONE: blobless clone through the proxy ──────────────────────────────────
BRANCH_ARGS=()
[ -n "${BRANCH:-}" ] && BRANCH_ARGS=(--branch "$BRANCH")
git -c "$HDR" clone --filter=blob:none "${BRANCH_ARGS[@]}" "$PROXY_URL" "$WORK/clone" \
  >"$WORK/clone.log" 2>&1 || { cat "$WORK/clone.log"; fail "clone through proxy"; }
[ -d "$WORK/clone/.git" ] || fail "clone produced no working tree"
pass "CLONE blobless clone succeeded"

# ── PUSH (opt-in): write scope through receive-pack ──────────────────────────
if [ "${PUSH:-0}" = "1" ]; then
  cd "$WORK/clone"
  TMP_BRANCH="kortix-e2e-proxy-$$-$RANDOM"
  git checkout -q -b "$TMP_BRANCH"
  echo "git-proxy e2e $(date -u +%FT%TZ)" > ".kortix-git-proxy-e2e"
  git -c user.email=noreply@kortix.ai -c user.name=Kortix add -A
  git -c user.email=noreply@kortix.ai -c user.name=Kortix commit -q -m "chore: git-proxy e2e probe"
  git -c "$HDR" push -q origin "$TMP_BRANCH" \
    >"$WORK/push.log" 2>&1 || { cat "$WORK/push.log"; fail "push through proxy (write scope)"; }
  pass "PUSH  pushed throwaway branch ${TMP_BRANCH}"
  # Clean up the throwaway branch upstream.
  git -c "$HDR" push -q origin ":${TMP_BRANCH}" \
    >"$WORK/push-del.log" 2>&1 || { cat "$WORK/push-del.log"; fail "delete throwaway branch"; }
  pass "PUSH  deleted throwaway branch (cleanup)"
fi

printf '\n\033[32mgit proxy e2e: all checks passed\033[0m\n'
