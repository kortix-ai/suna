#!/usr/bin/env bash
# EVERY SUITE, ONE COMMAND.
#
#   1. the node suites, in process against the shipped bundle — the list is
#      test/suite-map.mjs ALL_SUITES, the same list the auditors read;
#   2. test/session-e2e.mjs, a whole session on a real `celld dev`, when a
#      celld binary is available (CELLD_BIN, or `celld` on PATH) — SKIPPED by
#      name otherwise;
#   3. with --live only: the dev-stack suites (pi-js.kortix.com, Platinum dev).
#      Each SKIPs without its credentials, and they drive a deployment, not
#      this tree — a green live run says nothing about uncommitted code.
#
# NOT run here: test/mutate-*.mjs. The auditors rewrite tracked source files
# in place and restore them at exit; a run killed partway leaves a mutant in
# src/. Run one on purpose, alone, and check `git status` after it.
#
# Usage: ./test/all.sh [--live]
set -uo pipefail
cd "$(dirname "$0")/.."
LIVE=0
for a in "$@"; do [ "$a" = "--live" ] && LIVE=1; done
FAILED=0
declare -a RESULTS=()

# WHAT TREE WAS THIS RESULT ABOUT?
#
# A sweep started in the background and a test file edited while it ran
# reports a failure that has nothing to do with the code. This hashes the
# sources and suites at the start and again at the end: if they differ the run
# is NOT ATTRIBUTABLE and says so, rather than leaving a green or red summary
# that means nothing. Not hashed: dist/ (rebuilt here), wrangler.json and
# agent.config.json (written and restored by celldctl-logic).
tree_hash() {
  find . -type f \( -name '*.js' -o -name '*.mjs' -o -name '*.ts' -o -name '*.sh' -o -name '*.py' \) \
    -not -path '*/node_modules/*' -not -path '*/dist/*' 2>/dev/null \
    | sort | xargs shasum 2>/dev/null | shasum | cut -d' ' -f1
}
TREE_BEFORE=$(tree_hash)

run_suite() {
  local name="$1"; shift
  # The suite's own file, so its declared claim count can be read back.
  local SUITE_FILE=""
  for a in "$@"; do case "$a" in test/*.sh|./test/*.sh|test/*.mjs) SUITE_FILE="$a" ;; esac; done
  local log="/tmp/pi-cell-suite-${name}.log"
  if "$@" >"$log" 2>&1; then
    # A suite that skipped is not a suite that passed. Zero claims reported as
    # "0 ok" reads like a green run of nothing.
    if grep -q 'SKIP:' "$log"; then
      RESULTS+=("$name  SKIPPED ($(grep -m1 'SKIP:' "$log" | sed 's/.*SKIP: //'))")
      return
    fi
    # THE COUNT THE SUITE ITSELF DECLARES. A suite's own tail check catches a
    # section that ran and produced nothing; it cannot catch an exit partway,
    # because that skips the tail. Where a suite declares EXPECTED_PASSES (a
    # `//` or `#` comment), the number it printed has to match it.
    local ran want
    # Claim lines, plus pi's own conformance runner, which reports per group
    # ("== env: 21 pass, 0 fail, 0 known gaps") rather than per case.
    ran=$(( $(grep -cE 'PASS|^  ok' "$log") + $(awk '/^== [a-z]+: [0-9]+ pass/ { n += $3 } END { print n + 0 }' "$log") ))
    want=$(grep -m1 -oE '^(//|#)? *EXPECTED_PASSES=[0-9]+' "${SUITE_FILE:-/dev/null}" 2>/dev/null | cut -d= -f2)
    if [ -n "$want" ] && [ "$ran" -ne "$want" ]; then
      RESULTS+=("$name  INCOMPLETE: $ran of $want claims ran")
      FAILED=$((FAILED + 1))
      return
    fi
    RESULTS+=("$name  $ran ok")
    return
  fi
  # KEEP THE EVIDENCE. The log above is overwritten by the next run; this copy
  # is timestamped and survives.
  local kept="/tmp/pi-cell-failures/${name}-$(date +%Y%m%d-%H%M%S).log"
  mkdir -p /tmp/pi-cell-failures && cp "$log" "$kept" 2>/dev/null
  RESULTS+=("$name  FAILED: $(grep -E 'FAIL' "$log" | sed 's/\x1b\[[0-9;]*m//g' | head -1 | sed 's/^ *//')  [kept: ${kept}]")
  FAILED=$((FAILED + 1))
}

printf '\n  \033[1mpi in a cell — every suite\033[0m\n\n'
# BUILD FIRST: most suites import dist/worker.js, the bundle that ships.
npm run --silent build >/dev/null 2>&1 || { echo "  build failed — nothing below can be trusted"; exit 1; }

SUITES=$(node --no-warnings --input-type=module -e 'const m = await import("./test/suite-map.mjs"); console.log(m.ALL_SUITES.join("\n"))') \
  || { echo "  could not read test/suite-map.mjs"; exit 1; }
for suite in $SUITES; do
  run_suite "${suite%.mjs}" node --experimental-sqlite --no-warnings "test/$suite"
done

CELLD=${CELLD_BIN:-$(command -v celld 2>/dev/null || true)}
if [ -n "$CELLD" ] && [ -x "$CELLD" ]; then
  run_suite session-e2e node --no-warnings test/session-e2e.mjs --celld "$CELLD"
else
  RESULTS+=("session-e2e  SKIPPED (no celld binary: set CELLD_BIN or put celld on PATH)")
fi

if [ "$LIVE" -eq 1 ]; then
  run_suite browser-e2e ./test/dev-browser-e2e.sh
  run_suite session-dev ./test/dev-session-e2e.sh
  run_suite ttft-e2e    bash test/dev-ttft-e2e.sh
  run_suite ui-e2e      ./test/dev-ui-e2e.sh
  run_suite cell-dev    ./test/cell-dev-e2e.sh
fi

for r in "${RESULTS[@]}"; do
  case "$r" in
    *FAILED*|*INCOMPLETE*|*SKIPPED*) printf '  \033[31m%s\033[0m\n' "$r" ;;
    *)                               printf '  \033[32m%s\033[0m\n' "$r" ;;
  esac
done
echo
SKIPPED=$(printf '%s\n' "${RESULTS[@]}" | grep -c 'SKIPPED' || true)
TREE_AFTER=$(tree_hash)
if [ "$TREE_BEFORE" != "$TREE_AFTER" ]; then
  printf '\n  \033[31mNOT ATTRIBUTABLE\033[0m the sources or suites changed while this ran\n'
  printf '  %s -> %s\n' "$(echo "$TREE_BEFORE" | cut -c1-12)" "$(echo "$TREE_AFTER" | cut -c1-12)"
  exit 1
fi
if [ "$FAILED" -ne 0 ]; then
  printf '  %s suite(s) failed\n' "$FAILED"; exit 1
elif [ "$SKIPPED" -ne 0 ]; then
  printf '  every suite that RAN passed — %s skipped, see above\n' "$SKIPPED"
else
  echo "  every suite passed."
fi
