#!/usr/bin/env bash
# Quality gates: aggregate every category's machine-readable output under
# test-results/ and fail (non-zero exit) if any gate is breached. Safe to run
# after a full or partial suite — missing artifacts are reported as SKIPPED, not
# failed, so the gate scales with whatever ran.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RESULTS="${RESULTS_DIR:-$ROOT/test-results}"
MIN_COVERAGE="${MIN_COVERAGE:-80}"

red() { printf '\033[31m%s\033[0m\n' "$1"; }
grn() { printf '\033[32m%s\033[0m\n' "$1"; }
ylw() { printf '\033[33m%s\033[0m\n' "$1"; }

FAILED=0

echo "== Quality gates =="
echo "results dir: $RESULTS"
echo

# 1. JUnit failures across every category.
junit_failures=0
junit_files=0
while IFS= read -r f; do
  junit_files=$((junit_files + 1))
  n=$(grep -oE '(failures|errors)="[0-9]+"' "$f" | grep -oE '[0-9]+' | awk '{s+=$1} END{print s+0}')
  junit_failures=$((junit_failures + n))
done < <(find "$RESULTS" -name '*.xml' 2>/dev/null)

if [ "$junit_files" -eq 0 ]; then
  ylw "SKIP  test results — no JUnit XML found (did any suite run?)"
elif [ "$junit_failures" -gt 0 ]; then
  red "FAIL  test results — $junit_failures failing test(s) across $junit_files report(s)"
  FAILED=1
else
  grn "PASS  test results — 0 failures across $junit_files report(s)"
fi

# 2. Coverage threshold (vitest v8 json summary).
COV="$RESULTS/unit/coverage/coverage-summary.json"
if [ -f "$COV" ]; then
  pct=$(grep -oE '"lines":\{[^}]*"pct":[0-9.]+' "$COV" | head -1 | grep -oE '[0-9.]+$')
  pct=${pct:-0}
  if awk "BEGIN{exit !($pct < $MIN_COVERAGE)}"; then
    red "FAIL  coverage — ${pct}% < ${MIN_COVERAGE}% threshold"
    FAILED=1
  else
    grn "PASS  coverage — ${pct}% >= ${MIN_COVERAGE}%"
  fi
else
  ylw "SKIP  coverage — no coverage-summary.json (run test:unit:cov)"
fi

# 3. Security: no CRITICAL/HIGH in SARIF.
sarif_count=0
sev_hits=0
while IFS= read -r f; do
  sarif_count=$((sarif_count + 1))
  n=$(grep -oiE '"(security-severity)":[ ]*"(9|10|7|8)[.0-9]*"|"level":[ ]*"error"' "$f" 2>/dev/null | wc -l | tr -d ' ')
  sev_hits=$((sev_hits + n))
done < <(find "$RESULTS/security" "$RESULTS/infra" -name '*.sarif' 2>/dev/null)

if [ "$sarif_count" -eq 0 ]; then
  ylw "SKIP  security — no SARIF found (run test:security)"
elif [ "$sev_hits" -gt 0 ]; then
  red "FAIL  security — $sev_hits critical/high finding(s) across $sarif_count scan(s)"
  FAILED=1
else
  grn "PASS  security — no critical/high findings across $sarif_count scan(s)"
fi

# 4. Performance: every k6 summary must report thresholds met.
perf_files=0
perf_breaches=0
while IFS= read -r f; do
  perf_files=$((perf_files + 1))
  if grep -q '"thresholds"' "$f" 2>/dev/null; then
    n=$(grep -oE '"ok":[ ]*false' "$f" 2>/dev/null | wc -l | tr -d ' ')
    perf_breaches=$((perf_breaches + n))
  fi
done < <(find "$RESULTS/performance" -name '*-summary.json' 2>/dev/null)

if [ "$perf_files" -eq 0 ]; then
  ylw "SKIP  performance — no k6 summary (run test:perf)"
elif [ "$perf_breaches" -gt 0 ]; then
  red "FAIL  performance — $perf_breaches threshold breach(es)"
  FAILED=1
else
  grn "PASS  performance — all thresholds met across $perf_files profile(s)"
fi

echo
if [ "$FAILED" -ne 0 ]; then
  red "== QUALITY GATES FAILED =="
  exit 1
fi
grn "== QUALITY GATES PASSED =="
