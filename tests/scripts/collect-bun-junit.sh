#!/usr/bin/env bash
# Run every co-located bun:test suite with the JUnit reporter, one XML per
# workspace under tests/test-results/bun/, so the QA Allure report includes the
# ~830 unit tests — not just the cross-cutting vitest/pact suites.
#
# Each suite is run from its own workspace dir so its bunfig.toml (preloads,
# env scrubbing) applies. Failures don't abort the sweep (we want every suite's
# results in the report); the script exits non-zero if any suite failed so a
# caller can still gate on it.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT="$ROOT/tests/test-results/bun"
mkdir -p "$OUT"
status=0

# Workspaces under packages/* and apps/* whose `test` script runs `bun test`.
while IFS= read -r pkg; do
  dir="$(dirname "$pkg")"
  test_script="$(node -e "try{process.stdout.write(require('$pkg').scripts?.test||'')}catch(e){}" 2>/dev/null)"
  case "$test_script" in *"bun test"*) ;; *) continue ;; esac
  # only run workspaces that actually have a bun test file
  find "$dir" -path '*/node_modules' -prune -o -name '*.test.ts' -print -quit | grep -q . || continue
  slug="$(echo "${dir#"$ROOT"/}" | tr '/' '_')"
  echo "▶ bun test: ${dir#"$ROOT"/}"
  ( cd "$dir" && bun test --reporter=junit --reporter-outfile="$OUT/${slug}.xml" ) || status=1
done < <(find "$ROOT/packages" "$ROOT/apps" -maxdepth 2 -name package.json -not -path '*/node_modules/*' 2>/dev/null)

count="$(find "$OUT" -name '*.xml' 2>/dev/null | wc -l | tr -d ' ')"
echo "collect-bun-junit: wrote ${count} JUnit file(s) -> ${OUT#"$ROOT"/}"
exit $status
