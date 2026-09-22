#!/bin/sh
# Blocked-terms guard: refuses a commit or push that ADDS a blocked term.
#
# The terms are customer names and similar identifiers that must never enter the
# repository (see "NEVER write customer data or PII" in AGENTS.md). The list is
# itself customer data, so it lives ENCRYPTED in `apps/api/.env` as
# `BLOCKED_COMMIT_TERMS` (comma-separated). Add a term with:
#
#   dotenvx set BLOCKED_COMMIT_TERMS "term1,term2" -f apps/api/.env
#
# Matching is case-insensitive and whole-word: a term matches only when the
# characters around it are not letters, digits, or `_`. So `acme` matches
# `Acme`, `acme-prod` and `api.acme.cloud`, and does not match `acmeist`.
#
# Only ADDED lines are checked. Deleting a line that contains a term is always
# allowed, so cleanup never blocks.
#
# Modes:
#   check-blocked-terms.sh staged          staged diff (pre-commit)
#   check-blocked-terms.sh message <file>  commit message (commit-msg)
#   check-blocked-terms.sh push            pre-push stdin: new commits' diffs,
#                                          messages, and the pushed ref names
#
# Terms come from `BLOCKED_COMMIT_TERMS` when it is already set in the
# environment, otherwise from decrypting `apps/api/.env` — this checkout's
# first, then the primary checkout's (every worktree runs the primary's hooks,
# and an older worktree may predate the list). Keys come from either checkout's
# `apps/api/.env.keys`. With no key available the guard prints a warning and
# allows the operation: it cannot know the terms.
set -e

mode="$1"

load_terms() {
  if [ -n "${BLOCKED_COMMIT_TERMS:-}" ]; then
    printf '%s' "$BLOCKED_COMMIT_TERMS"
    return 0
  fi
  here=$(cd "$(dirname "$0")/.." && pwd)
  top=$(git rev-parse --show-toplevel)
  primary=$(cd "$(git rev-parse --git-common-dir)/.." && pwd)
  if command -v dotenvx >/dev/null 2>&1; then dx="dotenvx"
  elif [ -x "$top/node_modules/.bin/dotenvx" ]; then dx="$top/node_modules/.bin/dotenvx"
  elif [ -x "$here/node_modules/.bin/dotenvx" ]; then dx="$here/node_modules/.bin/dotenvx"
  elif [ -x "$primary/node_modules/.bin/dotenvx" ]; then dx="$primary/node_modules/.bin/dotenvx"
  else return 1; fi
  # This checkout's list first, then the one beside the hooks, then the
  # primary's: a worktree cut before a term was added (or before the guard
  # existed) still gets the current list.
  for env in "$top/apps/api/.env" "$here/apps/api/.env" "$primary/apps/api/.env"; do
    [ -f "$env" ] || continue
    for keys in "$top/apps/api/.env.keys" "$here/apps/api/.env.keys" "$primary/apps/api/.env.keys"; do
      [ -f "$keys" ] || continue
      out=$($dx get BLOCKED_COMMIT_TERMS -f "$env" -fk "$keys" 2>/dev/null) && [ -n "$out" ] && { printf '%s' "$out"; return 0; }
    done
    # CI or an Armor login may provide DOTENV_PRIVATE_KEY without a keys file.
    out=$($dx get BLOCKED_COMMIT_TERMS -f "$env" 2>/dev/null) && [ -n "$out" ] && { printf '%s' "$out"; return 0; }
  done
  return 1
}

if ! terms=$(load_terms) || [ -z "$terms" ]; then
  echo "blocked-terms: WARNING — BLOCKED_COMMIT_TERMS could not be decrypted; check skipped." >&2
  exit 0
fi

# Reads unified-diff / message text on stdin. Lines are tagged by the producer:
#   diff text  → checked on `+` lines, reported as path:line
#   `@@MSG <label>` … `@@ENDMSG` → every line inside is checked
#   `@@REF <name>` → the ref name itself is checked
scan() {
  awk -v terms="$terms" '
    function esc(s) { gsub(/[][\\.^$*+?(){}|\/]/, "\\\\&", s); return s }
    BEGIN {
      n = split(tolower(terms), raw, ",")
      for (i = 1; i <= n; i++) {
        t = raw[i]; gsub(/^[ \t]+|[ \t]+$/, "", t)
        if (t != "") re[++k] = "(^|[^a-z0-9_])" esc(t) "([^a-z0-9_]|$)"
      }
      found = 0
    }
    function check(text, where,   i, low) {
      low = tolower(text)
      for (i = 1; i <= k; i++) if (low ~ re[i]) {
        printf "  %s: %s\n", where, substr(text, 1, 160)
        found = 1
        return
      }
    }
    /^@@REF / { check(substr($0, 7), "ref name"); next }
    /^@@MSG / { inmsg = 1; label = substr($0, 7); next }
    /^@@ENDMSG$/ { inmsg = 0; next }
    inmsg { if ($0 !~ /^#/) check($0, label); next }
    /^\+\+\+ / { path = substr($0, 5); sub(/^b\//, "", path); next }
    /^@@ / {
      h = $0; sub(/^@@ -[0-9,]+ \+/, "", h); sub(/[, ].*/, "", h)
      line = h + 0; next
    }
    /^\+/ { check(substr($0, 2), path ":" line); line++; next }
    END { exit found }
  '
}

report() {
  echo "blocked-terms: this $1 contains a blocked term (customer data). Remove it." >&2
  echo "  Rule: AGENTS.md → \"NEVER write customer data or PII\"." >&2
  exit 1
}

case "$mode" in
  staged)
    out=$(git diff --cached -U0 --no-color --no-ext-diff | scan) || { echo "$out" >&2; report commit; }
    ;;
  message)
    out=$( { echo "@@MSG commit message"; cat "$2"; echo "@@ENDMSG"; } | scan) || { echo "$out" >&2; report "commit message"; }
    ;;
  push)
    zero=0000000000000000000000000000000000000000
    input=$(cat)
    out=$(printf '%s\n' "$input" | while read -r local_ref local_sha remote_ref remote_sha; do
      [ -n "$local_sha" ] || continue
      [ "$local_sha" = "$zero" ] && continue   # branch deletion
      echo "@@REF ${remote_ref#refs/heads/}"
      for c in $(git rev-list "$local_sha" --not --remotes); do
        echo "@@MSG commit $(git rev-parse --short "$c") message"
        git log -1 --format=%B "$c"
        echo "@@ENDMSG"
        git show -U0 --no-color --no-ext-diff --format= --diff-merges=off "$c"
      done
    done | scan) || { echo "$out" >&2; report push; }
    ;;
  *)
    echo "usage: check-blocked-terms.sh staged | message <file> | push" >&2
    exit 2
    ;;
esac
