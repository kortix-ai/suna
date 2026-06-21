#!/usr/bin/env bash
# Run the GitHub PR (or release) checks locally, mirroring .github/workflows,
# so you can push code that's already green. Each section maps to a real CI job;
# prerequisites that aren't available (Docker, dotenvx keys, terraform) SKIP with
# a note rather than fail, so it's useful on a minimal setup too.
#
#   scripts/ci-local.sh            # PR gate (default) — what blocks a PR to main
#   scripts/ci-local.sh pr
#   scripts/ci-local.sh release    # the full pre-prod gate (PR -> prod)
#
# Env:
#   CI_BASE=<ref>   base ref for the "tests-required" diff (default: auto)
set -uo pipefail
cd "$(dirname "$0")/.."

MODE="${1:-pr}"
PASSED=(); FAILED=(); SKIPPED=()

c_grn=$'\033[32m'; c_red=$'\033[31m'; c_ylw=$'\033[33m'; c_dim=$'\033[2m'; c_off=$'\033[0m'
have()      { command -v "$1" >/dev/null 2>&1; }
docker_ok() { have docker && docker info >/dev/null 2>&1; }

# pass: run a command; record pass/fail under <name>
pass() { local n="$1"; shift; printf '\n%s▶ %s%s\n' "$c_dim" "$n" "$c_off"
  if "$@"; then PASSED+=("$n"); printf '  %s✓ %s%s\n' "$c_grn" "$n" "$c_off"
  else FAILED+=("$n"); printf '  %s✗ %s%s\n' "$c_red" "$n" "$c_off"; fi; }
skip() { printf '\n%s▶ %s%s\n  %s⚠ SKIP%s — %s\n' "$c_dim" "$1" "$c_off" "$c_ylw" "$c_off" "$2"; SKIPPED+=("$1"); }

# ── resolve the base ref for the tests-required diff ──────────────────────────
detect_base() {
  for r in "${CI_BASE:-}" upstream/main origin/main main; do
    [ -n "$r" ] && git rev-parse --verify --quiet "$r" >/dev/null 2>&1 && { echo "$r"; return; }
  done
}

# ── package-tests.yml: every change ships with tests ──────────────────────────
check_tests_required() {
  local base mb changed src tests
  base="$(detect_base)"; [ -z "$base" ] && { echo "  no base ref found — skipping"; return 0; }
  mb="$(git merge-base "$base" HEAD 2>/dev/null)" || mb="$base"
  changed="$( { git diff --name-only "$mb" HEAD; git diff --name-only HEAD; git ls-files --others --exclude-standard; } | sort -u )"
  src=$(echo "$changed"   | grep -E '^(apps|packages)/[^/]+/(src|app|components|lib|hooks|features|stores)/.*\.(ts|tsx)$' | grep -vE '\.(test|spec)\.(ts|tsx|mts)$|\.d\.ts$|/__tests__/|/generated/|\.generated\.' || true)
  tests=$(echo "$changed" | grep -E '\.(test|spec)\.(ts|tsx|mts)$|^tests/|/__tests__/|\.flow\.ts$' || true)
  if [ -n "$src" ] && [ -z "$tests" ]; then
    echo "  source changed without a test (vs $base):"; echo "$src" | sed 's/^/    - /'; return 1
  fi
  echo "  ok (vs $base)"; return 0
}

# ── package-tests.yml: focused-test guard ─────────────────────────────────────
check_focused() {
  local hits
  hits=$(grep -rn --include='*.test.ts' --include='*.test.tsx' --include='*.test.mts' \
    -E '\b(describe|test|it)\.only\(' apps packages 2>/dev/null | grep -v node_modules || true)
  [ -n "$hits" ] && { echo "  committed .only found:"; echo "$hits" | sed 's/^/    /'; return 1; }
  echo "  none"; return 0
}

# ── package-tests.yml: co-located bun:test suites ─────────────────────────────
run_pkg_tests()  { pnpm --filter "./packages/**" --if-present test; }
run_app_tests()  { pnpm --filter "Kortix-Computer-Frontend" --filter "@kortix/cli" \
                     --filter "@kortix/sandbox-agent-server" --filter "kortix" --if-present test; }

# ── ci.yml: per-app typecheck ─────────────────────────────────────────────────
run_typechecks() { pnpm -r --if-present typecheck; }

# ── terraform-ci.yml: fmt + tflint ────────────────────────────────────────────
tf_fmt()    { terraform fmt -check -recursive infra/terraform; }
tf_tflint() {
  if have tflint; then ( cd infra/terraform && tflint --recursive --format compact )
  else docker run --rm -v "$PWD/infra/terraform:/data" -w /data \
         ghcr.io/terraform-linters/tflint:v0.54.0 --recursive --format compact; fi
}

# ── security-scan.yml / secret-scan.yml: gitleaks ─────────────────────────────
run_gitleaks() {
  if have gitleaks; then gitleaks detect --no-banner --redact
  else docker run --rm -v "$PWD:/repo" zricethezav/gitleaks:latest detect --source=/repo --no-banner --redact; fi
}

# ── security-scan.yml: checkov + trivy on infra ───────────────────────────────
run_checkov() { docker run --rm -v "$PWD/infra/terraform:/tf" ghcr.io/bridgecrewio/checkov:latest \
                  -d /tf --compact --quiet --framework terraform; }
run_trivy_cfg() { docker run --rm -v "$PWD/infra/terraform:/tf" aquasec/trivy:0.58.0 \
                  config /tf --severity HIGH,CRITICAL --exit-code 1; }

echo "═══ Local CI (${MODE}) — mirrors .github/workflows ═══"
[ "$MODE" = "pr" ] || [ "$MODE" = "release" ] || { echo "usage: ci-local.sh [pr|release]"; exit 2; }

# ── always (PR + release) ─────────────────────────────────────────────────────
pass "tests-required (package-tests.yml)" check_tests_required
pass "focused-test guard (package-tests.yml)" check_focused
pass "unit: packages (package-tests.yml)" run_pkg_tests
pass "unit: apps (package-tests.yml)" run_app_tests
pass "typecheck workspaces (ci.yml)" run_typechecks
pass "lint: biome" pnpm lint:biome

# qa-pr.yml runs `make ci-pr`; needs tests/ deps (bun) + Docker for integration.
if have bun; then
  ( cd tests && bun install --frozen-lockfile >/dev/null 2>&1 ) || true
  if [ "$MODE" = "release" ]; then
    docker_ok && pass "make ci-release (qa-release.yml)" make ci-release \
              || skip "make ci-release (qa-release.yml)" "Docker not running (needed for integration/migration/etc.)"
  else
    docker_ok && pass "make ci-pr (qa-pr.yml)" make ci-pr \
              || skip "make ci-pr (qa-pr.yml)" "Docker not running (needed for integration); try: make fast"
  fi
else
  skip "make ci-pr/ci-release" "bun not installed"
fi

# kortix-api suite (package-tests.yml api job) — needs dotenvx-decrypted env.
if [ -f apps/api/.env.keys ] || [ -n "${DOTENV_PRIVATE_KEY:-}" ]; then
  pass "unit: kortix-api (package-tests.yml)" pnpm --filter kortix-api test
else
  skip "unit: kortix-api (package-tests.yml)" "no apps/api/.env.keys / DOTENV_PRIVATE_KEY (env-gated, runs in CI)"
fi

# ── infra changes → terraform-ci.yml + security-scan.yml ──────────────────────
if have terraform; then
  pass "terraform fmt (terraform-ci.yml)" tf_fmt
  if have tflint || docker_ok; then pass "tflint (terraform-ci.yml)" tf_tflint
  else skip "tflint (terraform-ci.yml)" "tflint + Docker both unavailable"; fi
else
  skip "terraform fmt + tflint (terraform-ci.yml)" "terraform not installed"
fi
if docker_ok; then
  pass "checkov (security-scan.yml)" run_checkov
  pass "trivy config (security-scan.yml)" run_trivy_cfg
else
  skip "checkov + trivy (security-scan.yml)" "Docker not running"
fi

# ── gitleaks (secret-scan.yml) ────────────────────────────────────────────────
if have gitleaks || docker_ok; then pass "gitleaks (secret-scan.yml)" run_gitleaks
else skip "gitleaks (secret-scan.yml)" "gitleaks + Docker both unavailable"; fi

# CodeQL runs only on GitHub (SaaS analysis) — Biome + semgrep are the local proxy.
skip "CodeQL (codeql.yml)" "GitHub-only analysis; biome above + 'make security' (semgrep) are the local proxy"

# ── summary ───────────────────────────────────────────────────────────────────
echo; echo "═══ Summary ═══"
printf '  %s%d passed%s   %s%d failed%s   %s%d skipped%s\n' \
  "$c_grn" "${#PASSED[@]}" "$c_off" "$c_red" "${#FAILED[@]}" "$c_off" "$c_ylw" "${#SKIPPED[@]}" "$c_off"
[ "${#SKIPPED[@]}" -gt 0 ] && printf '  %sskipped:%s %s\n' "$c_ylw" "$c_off" "$(IFS=,; echo "${SKIPPED[*]}")"
if [ "${#FAILED[@]}" -gt 0 ]; then
  printf '  %sfailed:%s\n' "$c_red" "$c_off"; printf '    - %s\n' "${FAILED[@]}"
  echo; echo "Fix the above before pushing. (Skips are env-gated and run in CI.)"; exit 1
fi
echo; echo "All runnable checks passed. Skips are env-gated and run in CI."; exit 0
