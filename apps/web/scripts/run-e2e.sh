#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WEB_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
TESTS_ROOT="$(cd "$WEB_ROOT/../../tests" && pwd)"

cd "$TESTS_ROOT"

if [[ "${1-}" == "--" ]]; then
  shift
fi

pnpm exec playwright test -c playwright.config.ts "$@"
