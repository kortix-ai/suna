#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
STRIX_BIN="${STRIX_BIN:-strix}"
SCAN_MODE="${STRIX_SCAN_MODE:-quick}"
SCOPE_MODE="${STRIX_SCOPE_MODE:-auto}"
MAX_BUDGET_USD="${STRIX_MAX_BUDGET_USD:-5}"
TARGET_URL="${STRIX_TARGET_URL:-}"
INSTRUCTION_FILE="${STRIX_INSTRUCTION_FILE:-${ROOT_DIR}/.strix/instructions/ci-source.md}"

if ! command -v "${STRIX_BIN}" >/dev/null 2>&1; then
  echo "[strix] missing CLI: ${STRIX_BIN}" >&2
  exit 1
fi

if [[ -z "${LLM_API_KEY:-}" ]]; then
  echo "[strix] LLM_API_KEY is required" >&2
  exit 1
fi

case "${SCAN_MODE}" in
  quick | standard | deep) ;;
  *)
    echo "[strix] invalid STRIX_SCAN_MODE: ${SCAN_MODE}" >&2
    exit 1
    ;;
esac

case "${SCOPE_MODE}" in
  auto | diff | full) ;;
  *)
    echo "[strix] invalid STRIX_SCOPE_MODE: ${SCOPE_MODE}" >&2
    exit 1
    ;;
esac

if [[ -n "${TARGET_URL}" ]]; then
  case "${TARGET_URL}" in
    https://staging-api.kortix.com | https://dev-api.kortix.com | http://localhost:* | http://127.0.0.1:*) ;;
    *)
      echo "[strix] refusing non-development target: ${TARGET_URL}" >&2
      exit 1
      ;;
  esac
fi

export STRIX_LLM="${STRIX_LLM:-openai/openai/gpt-5.4}"
export LLM_API_BASE="${LLM_API_BASE:-https://openrouter.ai/api/v1}"
export STRIX_TELEMETRY="${STRIX_TELEMETRY:-0}"
export STRIX_IMAGE="${STRIX_IMAGE:-ghcr.io/usestrix/strix-sandbox@sha256:478e0b37ec83b2ba8c6e159593cb46d5dc9b624a45d6a9bb606851b83058d284}"

args=(
  --non-interactive
  --mount "${ROOT_DIR}"
  --scan-mode "${SCAN_MODE}"
  --scope-mode "${SCOPE_MODE}"
  --instruction-file "${INSTRUCTION_FILE}"
  --max-budget-usd "${MAX_BUDGET_USD}"
)

if [[ "${SCOPE_MODE}" == "diff" ]]; then
  args+=(--diff-base "${STRIX_DIFF_BASE:-origin/main}")
fi

if [[ -n "${TARGET_URL}" ]]; then
  args+=(--target "${TARGET_URL}")
fi

echo "[strix] mode=${SCAN_MODE} scope=${SCOPE_MODE} target=${TARGET_URL:-source-only} budget=\$${MAX_BUDGET_USD}"
cd "${ROOT_DIR}"
exec "${STRIX_BIN}" "${args[@]}"
