#!/usr/bin/env bash
# EVERY SUITE, AND SURVIVE THE DOCKER VM DYING.
#
# On this machine the OrbStack VM is killed (SIGKILL) after roughly four or five
# heavy suites. It is not this code and it is not the host:
#
#   host memory     min 5.46 GB free during a failing run — not pressure
#   VM disk         34.5 GB free
#   celld churn     25 cycles of a WORKING node, real bucket traffic — survived
#   bind mounts     20 cycles mounting node_modules (10,722 files) — survived
#   real deploys    15 cycles of esbuild-in-container + S3 writes — survived
#   docker kill     8 SIGKILLs of a live container — survived
#   short-lived     16 run --rm containers — survived
#   published port  8 cycles, idle and with curl hammering it — survived
#   host dialling   8 containers to an open port and 8 to a closed one — survived
#
# No single operation reproduces it; only sustained multi-suite load does, and
# OrbStack leaves no crash report. So the runner stops pretending the daemon is
# reliable: it checks before each suite, brings it back with `orb start` (which
# does not need the GUI crash dialog dismissed), and retries a suite ONCE if the
# daemon died underneath it.
#
# A recovered run is reported as recovered, never as clean — the count of
# restarts is printed at the end, because a suite that only passes on the second
# attempt is a different fact from one that passes.
set -uo pipefail
cd "$(dirname "$0")/.."

RESTARTS=0
FAILED=0
declare -a RESULTS=()

alive() { docker version --format '{{.Server.Version}}' >/dev/null 2>&1; }

ensure_docker() {
  alive && return 0
  RESTARTS=$((RESTARTS + 1))
  orb start >/dev/null 2>&1
  for _ in $(seq 1 240); do alive && break; sleep 0.25; done
  alive || return 1
  docker start pt-minio >/dev/null 2>&1
  for _ in $(seq 1 60); do docker exec pt-minio true 2>/dev/null && return 0; sleep 0.25; done
  return 0
}


# WHAT TREE WAS THIS RESULT ABOUT?
#
# Twice in one session I started a sweep in the background and then edited a
# test file while it ran. Both times a suite reported a failure that had nothing
# to do with the code — it had been rewritten underneath the run — and both
# times I worked that out afterwards, from the shape of the error.
#
# A result is only meaningful about the tree it ran against. This hashes the
# sources and suites at the start and again at the end: if they differ the run
# is NOT ATTRIBUTABLE and says so, rather than leaving a green or red summary
# that means nothing.
#
# Deliberately not everything. wrangler.json is rewritten by the suites
# themselves, dist/ is rebuilt, agent.config.json is written and restored by
# celldctl-logic — hashing those would report drift on every clean run.
#
# Which is exactly what the first version did: the pattern was anchored at the
# top level, so test/fixture-app/.platinum-build — 15 generated files the e2e
# rebuilds every run — was hashed, and a clean bindings sweep declared itself
# NOT ATTRIBUTABLE. A guard that fires when nothing is wrong is a guard someone
# turns off, and I had written that sentence one commit before shipping it.
tree_hash() {
  find . -type f \( -name '*.js' -o -name '*.mjs' -o -name '*.sh' -o -name '*.py' \) \
    -not -path '*/node_modules/*' -not -path '*/dist/*' -not -path '*/.platinum-build/*' \
    -not -path '*/.next/*' -not -path '*/fixture-app/*' 2>/dev/null \
    | sort | xargs shasum 2>/dev/null | shasum | cut -d' ' -f1
}
TREE_BEFORE=$(tree_hash)

run_suite() {
  local name="$1"; shift
  # The suite's own file, so its declared claim count can be read back.
  local SUITE_FILE=""
  for a in "$@"; do case "$a" in *test/*.sh|*test/*.mjs) SUITE_FILE="$a" ;; esac; done
  local log="/tmp/suite-${name}.log"
  ensure_docker || { RESULTS+=("$name  SKIPPED (docker unavailable)"); FAILED=$((FAILED+1)); return; }

  if "$@" >"$log" 2>&1; then
    # A suite that skipped is not a suite that passed. Zero claims reported as
    # "0 ok" reads like a green run of nothing.
    if grep -q 'SKIP:' "$log"; then
      RESULTS+=("$name  SKIPPED ($(grep -m1 'SKIP:' "$log" | sed 's/.*SKIP: //'))")
      return
    fi
    # THE COUNT THE SUITE ITSELF DECLARES.
    #
    # A suite's own tail check catches a section that ran and produced nothing.
    # It cannot catch an `exit 0` partway, because that skips the tail — proved
    # by making crash.sh stop after two claims: it exited 0, printed a clean
    # two-line run, and nothing said a word.
    #
    # This is the other half. Where a suite declares EXPECTED_PASSES, the number
    # it printed has to match it, so a short run is a failure here even when the
    # suite never got as far as noticing.
    local ran want
    ran=$(grep -cE 'PASS|^  ok' "$log")
    # A comment prefix is accepted so a .mjs suite can declare one too: under
    # ESM's strict mode a bare top-level `EXPECTED_PASSES=53` is a ReferenceError,
    # so every .mjs suite here declared nothing and the anchored pattern matched
    # only the five shell suites. Nineteen suites, 653 of the run's claims, had
    # no count to check against.
    want=$(grep -m1 -oE '^(//|#)? *EXPECTED_PASSES=[0-9]+' "${SUITE_FILE:-/dev/null}" 2>/dev/null | cut -d= -f2)
    if [ -n "$want" ] && [ "$ran" -ne "$want" ]; then
      RESULTS+=("$name  INCOMPLETE: $ran of $want claims ran")
      FAILED=$((FAILED + 1))
      return
    fi
    RESULTS+=("$name  $ran ok")
    return
  fi

  # Distinguish "the suite found a bug" from "the daemon vanished under it".
  # Retrying a real failure wastes minutes and teaches nothing.
  if ! alive; then
    ensure_docker || { RESULTS+=("$name  SKIPPED (docker did not come back)"); FAILED=$((FAILED+1)); return; }
    if "$@" >"$log" 2>&1; then
      RESULTS+=("$name  $(grep -cE 'PASS|^  ok' "$log") ok (RETRIED after the docker VM died)")
      return
    fi
  fi
  # KEEP THE EVIDENCE. /tmp/suite-<name>.log is overwritten by the next run, so
  # a suite that fails once in five runs is undiagnosable by the time anyone
  # looks. This copy is timestamped and survives.
  local kept="/tmp/celld-failures/${name}-$(date +%Y%m%d-%H%M%S).log"
  mkdir -p /tmp/celld-failures && cp "$log" "$kept" 2>/dev/null
  RESULTS+=("$name  FAILED: $(grep -E 'FAIL' "$log" | sed 's/\x1b\[[0-9;]*m//g' | head -1 | sed 's/^ *//')  [kept: ${kept}]")
  FAILED=$((FAILED + 1))
}

printf '\n  \033[1mpi in a cell — every suite\033[0m\n\n'
# BUILD FIRST. cell-logic and atob-shim import dist/worker.js, and the suite that
# builds dist (fixture, build-and-model.mjs) ran four suites later — so on a
# fresh checkout the first sweep failed both with ERR_MODULE_NOT_FOUND and the
# second passed. Every checkout that had ever run a sweep carried a dist/ from
# last time, which is how this stayed hidden.
npm run --silent build >/dev/null 2>&1 || { echo "  build failed — nothing below can be trusted"; exit 1; }

run_suite tools      node test/tools-logic.mjs
run_suite shapes     node test/platinum-shapes.mjs
run_suite compaction node test/compaction-logic.mjs
run_suite safety     node test/daemon-safety.mjs
run_suite cell       node --experimental-sqlite test/cell-logic.mjs
run_suite atob       node test/atob-shim.mjs
run_suite models     node test/model-logic.mjs
run_suite ctl        node test/celldctl-logic.mjs
run_suite deploy     node test/deploy-contract.mjs
run_suite fixture    node test/build-and-model.mjs
run_suite execenv    node test/execenv-logic.mjs
run_suite persist    node test/daemon-persist.mjs
run_suite opid       node test/opid-identity.mjs
run_suite cancel     node test/cancel-logic.mjs
run_suite skills     node test/skills-logic.mjs
run_suite parity     node test/ledger-parity.mjs
run_suite archive    node test/archive-logic.mjs
run_suite meter      node test/meter-logic.mjs
run_suite envplat    node test/execenv-platinum.mjs
run_suite e2e        ./test/e2e.sh
run_suite streaming  ./test/streaming.sh
run_suite crash      ./test/crash.sh
run_suite platinum   ./test/platinum.sh

# Eviction needs a node started with CELLD_MAX_RESIDENT_CELLS=1, which the other
# suites do not want. It skips cleanly when that is not the case rather than
# restarting the node underneath them.
run_suite eviction   ./test/eviction.sh
# The cell against a REAL Platinum dev sandbox as its workspace. Opt-in by the
# presence of a dev token (PT_SANDBOX_KEY or ~/.config/platinum/credentials);
# without one it SKIPs and says so. Last, because it owns the node's lifecycle.
run_suite dev-e2e    ./test/dev-e2e.sh
# THE WORKER IN A REAL CELL ON DEV, folder-scoped. Needs the dev bucket's S3
# credentials in PT_S3_* on top of the token; SKIPs by name without them.
run_suite cell-dev   ./test/cell-dev-e2e.sh

for r in "${RESULTS[@]}"; do
  case "$r" in
    *FAILED*|*SKIPPED*) printf '  \033[31m%s\033[0m\n' "$r" ;;
    *RETRIED*)          printf '  \033[33m%s\033[0m\n' "$r" ;;
    *)                  printf '  \033[32m%s\033[0m\n' "$r" ;;
  esac
done

echo
[ "$RESTARTS" -gt 0 ] && printf '  the docker VM was restarted %s time(s) during this run\n' "$RESTARTS"
# A SKIP IS NOT A PASS — see the note in the bindings runner.
SKIPPED=$(printf '%s\n' "${RESULTS[@]}" | grep -c 'SKIPPED' || true)
TREE_AFTER=$(tree_hash)
if [ "$TREE_BEFORE" != "$TREE_AFTER" ]; then
  printf '\n  \033[31mNOT ATTRIBUTABLE\033[0m the sources or suites changed while this ran\n'
  printf '  %s -> %s\n' "$(echo "$TREE_BEFORE" | cut -c1-12)" "$(echo "$TREE_AFTER" | cut -c1-12)"
  printf '  Whatever it says above is about no particular version of this code.\n'
  exit 1
fi

if [ "$FAILED" -ne 0 ]; then
  printf '  %s suite(s) failed\n' "$FAILED"; exit 1
elif [ "$SKIPPED" -ne 0 ]; then
  printf '  every suite that RAN passed — %s skipped, see above\n' "$SKIPPED"
else
  echo "  every suite passed."
fi
