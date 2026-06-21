#!/usr/bin/env bash
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
export OUT_DIR="${OUT_DIR:-${REPO_ROOT}/tests/test-results/security}"

mkdir -p "${OUT_DIR}"

RUN_SAST=0
RUN_DEPS=0
RUN_SECRETS=0
RUN_CONTAINER=0
RUN_DAST=0
SELECTED=0

usage() {
  cat <<'EOF'
Usage: tests/security/run.sh [flags]

Static lanes (no running target required):
  --sast        Semgrep SAST            -> semgrep.sarif
  --deps        Trivy fs + OSV-Scanner  -> trivy-deps.{sarif,json}, osv.json
  --secrets     gitleaks                -> gitleaks.sarif
  --container   Trivy image (builds apps/*/Dockerfile) -> trivy-image-*.sarif
  --static      All of the above

Dynamic lane (requires TARGET_URL to a dedicated/staging/local target):
  --dast        OWASP ZAP baseline + Schemathesis fuzz -> zap-baseline.*, schemathesis-junit.xml

  --all         Static lanes + DAST (DAST only if TARGET_URL is set)
  -h, --help    This help

All output goes to test-results/security/. Each lane exits non-zero on a
quality-gate failure; the orchestrator aggregates and exits non-zero if any
lane failed.
EOF
}

if [ "$#" -eq 0 ]; then usage; exit 1; fi

while [ "$#" -gt 0 ]; do
  case "$1" in
    --sast) RUN_SAST=1; SELECTED=1 ;;
    --deps) RUN_DEPS=1; SELECTED=1 ;;
    --secrets) RUN_SECRETS=1; SELECTED=1 ;;
    --container) RUN_CONTAINER=1; SELECTED=1 ;;
    --dast) RUN_DAST=1; SELECTED=1 ;;
    --static) RUN_SAST=1; RUN_DEPS=1; RUN_SECRETS=1; RUN_CONTAINER=1; SELECTED=1 ;;
    --all) RUN_SAST=1; RUN_DEPS=1; RUN_SECRETS=1; RUN_CONTAINER=1; RUN_DAST=1; SELECTED=1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown flag: $1" >&2; usage; exit 1 ;;
  esac
  shift
done

if [ "${SELECTED}" -eq 0 ]; then usage; exit 1; fi

declare -a RESULTS
OVERALL=0

run_lane() {
  local name="$1"; shift
  echo ""
  echo "======================================================================"
  echo "== ${name}"
  echo "======================================================================"
  if "$@"; then
    RESULTS+=("PASS  ${name}")
  else
    RESULTS+=("FAIL  ${name}")
    OVERALL=1
  fi
}

[ "${RUN_SAST}" -eq 1 ]      && run_lane "sast (semgrep)"        bash "${SCRIPT_DIR}/sast/run.sh"
[ "${RUN_DEPS}" -eq 1 ]      && run_lane "deps (trivy/osv)"      bash "${SCRIPT_DIR}/deps/run.sh"
[ "${RUN_SECRETS}" -eq 1 ]   && run_lane "secrets (gitleaks)"    bash "${SCRIPT_DIR}/secrets/run.sh"
[ "${RUN_CONTAINER}" -eq 1 ] && run_lane "container (trivy)"     bash "${SCRIPT_DIR}/container/run.sh"

if [ "${RUN_DAST}" -eq 1 ]; then
  if [ -z "${TARGET_URL:-}" ]; then
    echo ""
    echo "[run] --dast requested but TARGET_URL is unset; skipping DAST." >&2
    echo "[run] DAST/fuzz must target a dedicated/staging/local instance, never shared prod/dev." >&2
    RESULTS+=("SKIP  dast (TARGET_URL unset)")
  else
    run_lane "dast (zap/schemathesis)" bash "${SCRIPT_DIR}/dast/run.sh"
  fi
fi

echo ""
echo "======================================================================"
echo "== security lane summary"
echo "======================================================================"
for r in "${RESULTS[@]}"; do echo "  ${r}"; done
echo "  output: ${OUT_DIR}"
echo ""

exit "${OVERALL}"
