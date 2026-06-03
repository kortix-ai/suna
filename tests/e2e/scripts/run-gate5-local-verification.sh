#!/usr/bin/env bash
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
cd "$REPO_ROOT"

timestamp="$(date -u +"%Y%m%dT%H%M%SZ")"
EVIDENCE_DIR="${GATE5_LOCAL_EVIDENCE_DIR:-$REPO_ROOT/test-results/gate5-local-verification/$timestamp}"
LOG_DIR="$EVIDENCE_DIR/logs"
RESULT_DIR="$EVIDENCE_DIR/results"
mkdir -p "$LOG_DIR" "$RESULT_DIR"

echo "[gate5-local] Starting local verification at $timestamp"
echo "[gate5-local] Evidence directory: $EVIDENCE_DIR"

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "[gate5-local] Missing required command: $1" >&2
    exit 1
  fi
}

require_cmd bun
require_cmd docker
require_cmd git
require_cmd jq
require_cmd pnpm

failures=0

env_file_value() {
  local key="$1"
  local file="${GATE5_LOCAL_ENV_FILE:-${E2E_ENV_FILE:-}}"
  [ -n "$file" ] || return 0
  [ -f "$file" ] || return 0
  grep -m1 "^${key}=" "$file" 2>/dev/null | cut -d= -f2- | sed -e "s/^['\"]//" -e "s/['\"]$//" || true
}

normalize_host_database_url() {
  local url="$1"
  local local_db_port="${GATE5_LOCAL_DB_PORT:-13741}"

  if [[ "$url" == *"@supabase-db:5432"* ]]; then
    url="${url/@supabase-db:5432/@localhost:$local_db_port}"
  fi

  printf '%s' "$url"
}

run_check() {
  local name="$1"
  shift
  local log_file="$LOG_DIR/$name.log"
  local command_display
  printf -v command_display '%q ' "$@"

  echo "[gate5-local] Running $name: $command_display"
  "$@" >"$log_file" 2>&1
  local exit_code=$?
  local status="passed"
  if [ "$exit_code" -ne 0 ]; then
    status="failed"
    failures=$((failures + 1))
    echo "[gate5-local] $name failed with exit code $exit_code; see $log_file" >&2
  else
    echo "[gate5-local] $name passed"
  fi

  jq -n \
    --arg name "$name" \
    --arg status "$status" \
    --arg command "$command_display" \
    --arg log "logs/$name.log" \
    --argjson exit_code "$exit_code" \
    '{
      name: $name,
      status: $status,
      command: $command,
      exit_code: $exit_code,
      log: $log
    }' >"$RESULT_DIR/$name.json"
}

run_check api_typecheck pnpm --filter kortix-api typecheck
run_check web_build env \
  NEXT_PUBLIC_BACKEND_URL="${NEXT_PUBLIC_BACKEND_URL:-http://localhost:8008/v1}" \
  NEXT_PUBLIC_SUPABASE_URL="${NEXT_PUBLIC_SUPABASE_URL:-https://placeholder.supabase.co}" \
  NEXT_PUBLIC_SUPABASE_ANON_KEY="${NEXT_PUBLIC_SUPABASE_ANON_KEY:-local-build-placeholder-anon-key}" \
  NEXT_PUBLIC_BILLING_ENABLED="${NEXT_PUBLIC_BILLING_ENABLED:-false}" \
  NEXT_OUTPUT="${NEXT_OUTPUT:-standalone}" \
  pnpm --filter Kortix-Computer-Frontend build
run_check api_tests pnpm --filter kortix-api test
run_check api_billing_tests bash -lc '
  set -euo pipefail
  for test_file in \
    apps/api/src/__tests__/billing/*.test.ts \
    apps/api/src/__tests__/e2e-billing-routes.test.ts \
    apps/api/src/__tests__/unit-stripe-webhook-canonicalization.test.ts \
    apps/api/src/__tests__/unit-revenuecat-webhook-canonical.test.ts
  do
    echo "[gate5-local] billing test: $test_file"
    (cd apps/api && bun test "${test_file#apps/api/}")
  done
'
run_check api_accounts_contract_tests pnpm --filter kortix-api exec bun test src/__tests__/e2e-accounts-contract.test.ts
run_check api_projects_contract_tests pnpm --filter kortix-api exec bun test src/__tests__/e2e-projects-contract.test.ts
run_check api_project_session_contract_tests pnpm --filter kortix-api exec bun test src/__tests__/e2e-project-session-contract.test.ts
run_check api_project_triggers_contract_tests pnpm --filter kortix-api exec bun test src/__tests__/e2e-project-triggers.test.ts
run_check api_rate_limit_tests bun test apps/api/src/__tests__/e2e-rate-limits.test.ts
run_check api_proxy_contract_tests pnpm --filter kortix-api exec bun test src/__tests__/e2e-preview-proxy.test.ts
run_check api_audit_tests bun test apps/api/src/__tests__/e2e-audit-events.test.ts
run_check api_github_app_tests bun test apps/api/src/__tests__/e2e-github-app-projects.test.ts
run_check api_create_repo_starter_tests pnpm --filter kortix-api exec bun test src/__tests__/e2e-create-repo-starter.test.ts

legacy_test_database_url="${TEST_DATABASE_URL:-${GATE5_LOCAL_DATABASE_URL:-${DATABASE_URL:-$(env_file_value DATABASE_URL)}}}"
legacy_test_database_url="$(normalize_host_database_url "$legacy_test_database_url")"
if [ -z "$legacy_test_database_url" ]; then
  echo "[gate5-local] Missing TEST_DATABASE_URL, GATE5_LOCAL_DATABASE_URL, DATABASE_URL, or GATE5_LOCAL_ENV_FILE/E2E_ENV_FILE DATABASE_URL for legacy migration tooling" >&2
  failures=$((failures + 1))
  jq -n \
    --arg name legacy_migration_tooling \
    --arg status failed \
    --arg command "TEST_DATABASE_URL=<required> KORTIX_TEST_DB_CONFIRM=I_UNDERSTAND_THIS_DELETES_TEST_DATA INTERNAL_KORTIX_ENV=dev bun test apps/api/src/__tests__/e2e-legacy-sandbox-migration.test.ts" \
    --arg log "logs/legacy_migration_tooling.log" \
    --argjson exit_code 1 \
    '{
      name: $name,
      status: $status,
      command: $command,
      exit_code: $exit_code,
      log: $log
    }' >"$RESULT_DIR/legacy_migration_tooling.json"
  printf 'Missing test database URL for legacy migration tooling\n' >"$LOG_DIR/legacy_migration_tooling.log"
else
  run_check legacy_migration_tooling env \
    TEST_DATABASE_URL="$legacy_test_database_url" \
    KORTIX_TEST_DB_CONFIRM=I_UNDERSTAND_THIS_DELETES_TEST_DATA \
    INTERNAL_KORTIX_ENV=dev \
    bun test apps/api/src/__tests__/e2e-legacy-sandbox-migration.test.ts
fi
run_check sandbox_daemon_auth bun test apps/kortix-sandbox-agent-server/src/__tests__/proxy-auth.test.ts
run_check sandbox_image_build docker build -f apps/sandbox/Dockerfile -t kortix/sandbox:dev .
run_check api_image_build docker build --build-arg SERVICE=apps/api -f apps/api/Dockerfile -t kortix/kortix-api:latest .
run_check gate5_scripts_syntax bash -n \
  tests/e2e/scripts/run-gate5-target-rehearsal.sh \
  tests/e2e/scripts/record-gate5-runbook-drill.sh \
  tests/e2e/scripts/record-gate5-observability-proof.sh \
  tests/e2e/scripts/record-gate5-api-curl-proof.sh \
  tests/e2e/scripts/record-gate5-slo-proof.sh \
  tests/e2e/scripts/record-gate5-concurrency-proof.sh \
  tests/e2e/scripts/record-gate5-negative-space-proof.sh \
  tests/e2e/scripts/record-gate5-ops-exceptions.sh \
  tests/e2e/scripts/verify-gate5-release-evidence.sh \
  tests/e2e/scripts/test-gate5-release-verifier-fixtures.sh \
  tests/e2e/scripts/run-gate5-local-verification.sh
run_check gate5_release_verifier_fixture_tests bash tests/e2e/scripts/test-gate5-release-verifier-fixtures.sh
run_check web_auth_return_url_tests node --experimental-strip-types --test apps/web/src/lib/auth/return-url.test.mts
run_check v1_playwright_spec_guards bash -lc '
  set -euo pipefail

  for legacy_spec in \
    tests/e2e/specs/05-onboarding-to-dashboard.spec.ts \
    tests/e2e/specs/06-files-scope.spec.ts \
    tests/e2e/specs/07-account-deletion-flow.spec.ts \
    tests/e2e/specs/07-account-deletion-unsupported.spec.ts \
    tests/e2e/specs/single-project-paradigm-ui.spec.ts \
    tests/e2e/specs/_board-screenshot.spec.ts \
    tests/e2e/legacy-specs/05-onboarding-to-dashboard.legacy.ts \
    tests/e2e/legacy-specs/06-files-scope.legacy.ts \
    tests/e2e/legacy-specs/07-account-deletion-flow.legacy.ts \
    tests/e2e/legacy-specs/07-account-deletion-unsupported.legacy.ts \
    tests/e2e/legacy-specs/single-project-paradigm-ui.legacy.ts \
    tests/e2e/legacy-specs/_board-screenshot.legacy.ts
  do
    [ ! -e "$legacy_spec" ]
  done

  if git grep -n -E "/auth/password|page\\.goto\\(.*/(instances|dashboard|subscription)|href=.*/(instances|dashboard|subscription)" -- \
    tests/e2e/specs \
    tests/e2e/helpers \
    tests/README.md
  then
    exit 1
  fi

  grep -q "E2E_REQUIRE_GITHUB_APP" tests/e2e/specs/10-production-golden-paths.spec.ts
  grep -q "github.auth_source" tests/e2e/specs/10-production-golden-paths.spec.ts
  grep -q "app_installation" tests/e2e/specs/10-production-golden-paths.spec.ts
  grep -q "Provisioning session" apps/web/src/components/session/session-loading-skeleton.tsx
  grep -q "Provisioning session" tests/e2e/specs/10-production-golden-paths.spec.ts
  grep -q "sidebarSessionLink.click" tests/e2e/specs/10-production-golden-paths.spec.ts
  grep -q "getByRole.*link.*Kortix" tests/e2e/specs/08-accounts-project-access.spec.ts
  grep -q "ownerSession.user.email" tests/e2e/specs/08-accounts-project-access.spec.ts
  grep -q "uiInvitedEmail" tests/e2e/specs/08-accounts-project-access.spec.ts
  grep -q "Invite sent to" tests/e2e/specs/08-accounts-project-access.spec.ts
  grep -q "uiInvitedAccounts" tests/e2e/specs/08-accounts-project-access.spec.ts
'
run_check v1_legacy_script_guards bash -lc '
  set -euo pipefail

  [ ! -e scripts/start-sandbox.sh ]
  [ ! -e apps/api/scripts/build-snapshot.ts ]
  [ ! -e apps/api/scripts/apply-justavps-ssh-bridge.ts ]

  if git grep -n -E "core/startup|core/docker|raw.githubusercontent.com/kortix-ai/suna/main/core" -- scripts apps/api; then
    exit 1
  fi

  if git grep -n -E "justavps-docker|justavps-workload|JustAVPSProvider" -- \
    scripts \
    apps/api/scripts
  then
    exit 1
  fi
'
run_check v1_tree_cleanup_guards bash -lc '
  set -euo pipefail

  [ ! -e core ]
  [ ! -e packages/voice ]
  [ ! -e packages/kortix-ocx-registry ]

  packages="$(find packages -mindepth 1 -maxdepth 1 -type d -exec basename {} \; | sort | tr "\n" " ")"
  [ "$packages" = "agent-tunnel db executor-sdk manifest-schema shared starter " ]

  if git grep -n -E "core/docker|dev:core|packages/voice|packages/kortix-ocx-registry|kortix/computer" -- \
    package.json \
    pnpm-workspace.yaml \
    .github/workflows \
    scripts
  then
    exit 1
  fi

  if git grep -n -E "justavpsOrigins|justavps\\.com|JustAVPS|kortix/computer" -- \
    apps/api/src/index.ts \
    .github/workflows \
    README.md
  then
    exit 1
  fi
'
run_check v1_legacy_web_route_guards bash -lc '
  set -euo pipefail

  [ ! -e apps/web/src/app/admin/instances/page.tsx ]
  [ ! -e apps/web/src/app/debug/instances/page.tsx ]

  admin_paths=(
    apps/web/src/app/admin/_components/admin-sidebar.tsx
    apps/web/src/app/admin/_components/admin-shell.tsx
    apps/web/src/app/admin/page.tsx
  )

	  if git grep -n -E "admin/instances|debug/instances|/instances|justavps|InstanceSettingsModal|useAdminSandboxes" -- "${admin_paths[@]}"
	  then
	    exit 1
	  fi

  account_paths=(
    apps/web/src/app/oauth/authorize/page.tsx
    apps/web/src/components/dashboard/connecting-screen.tsx
  )
  existing_account_paths=()
  for path in "${account_paths[@]}"; do
    [ ! -e "$path" ] || existing_account_paths+=("$path")
  done

	  if [ "${#existing_account_paths[@]}" -gt 0 ] && git grep -n -E "useAdminAccountSandboxes|InstanceSettingsModal|/instances|justavps|JustAVPS|machines provisioned|restartSandbox|getSandboxById|useAdminSandboxHealth" -- "${existing_account_paths[@]}"
	  then
	    exit 1
	  fi

	  grep -q "/projects" apps/web/src/components/home/navbar.tsx
	  grep -q "/projects" apps/web/src/app/admin/_components/admin-sidebar.tsx
	  grep -q "/projects" apps/web/src/app/admin/_components/admin-shell.tsx
	  [ ! -e apps/web/src/components/projects/session-dashboard-shell.tsx ]
	  single_quote="$(printf "\047")"
	  route_pattern="/dashboard($|[?\"${single_quote}])|/subscription($|[?\"${single_quote}])|/instances($|[?\"${single_quote}])|justavps|JustAVPS"
  route_scan_paths=(
    "apps/web/src/app/(home)/page.tsx"
    "apps/web/src/app/(home)/layout.tsx"
    "apps/web/src/app/(home)/pricing/page.tsx"
    apps/web/src/components/home/navbar.tsx
    apps/web/src/app/admin/_components/admin-sidebar.tsx
    apps/web/src/app/admin/_components/admin-shell.tsx
    apps/web/src/app/layout.tsx
    apps/web/src/components/auth/background-aal-checker.tsx
    apps/web/src/components/billing/pricing/new-instance-modal.tsx
    apps/web/src/app/auth/actions.ts
    apps/web/src/app/auth/callback/route.ts
    "apps/web/src/app/share/[shareId]/_components/SharePageWrapper.tsx"
    "apps/web/src/app/projects/[id]/layout.tsx"
    "apps/web/src/app/projects/[id]/sessions/[sessionId]/page.tsx"
  )
	  if git grep -n -E "$route_pattern" -- "${route_scan_paths[@]}"
	  then
	    exit 1
	  fi
	  if git grep -n -E "NewInstanceModal|useNewInstanceModalStore|openNewInstanceModal|new-instance-modal" -- \
	    "apps/web/src/app/(home)/layout.tsx" \
	    "apps/web/src/app/(home)/pricing/page.tsx"
	  then
	    exit 1
	  fi

	  grep -q "<AppProviders" apps/web/src/components/projects/project-shell.tsx
	  grep -q "sidebarContent={<ProjectSidebar projectId={projectId} />}" apps/web/src/components/projects/project-shell.tsx
	  grep -q "showSidebar?: boolean" apps/web/src/components/layout/app-providers.tsx
	  grep -q "showSidebar={false}" "apps/web/src/app/share/[shareId]/_components/SharePageWrapper.tsx"
	  grep -q "repo-first v1 surface" "apps/web/src/app/share/[shareId]/_components/SharePageWrapper.tsx"
	  grep -q "ProjectSidebar" apps/web/src/components/projects/project-sidebar.tsx
	  grep -q "logoHref = .*projects" apps/web/src/components/layout/app-header.tsx
	  if git grep -n -E "<NewInstanceModal|new-instance-modal|<UserSettingsModal|user-settings-modal|useNewInstanceModalStore|openNewInstanceModal|/instances|justavps|JustAVPS" -- \
	    apps/web/src/components/projects/project-shell.tsx \
	    apps/web/src/components/projects/project-sidebar.tsx \
	    apps/web/src/components/layout/app-header.tsx
	  then
	    exit 1
	  fi
	'
run_check git_diff_check git diff --check

status="passed"
if [ "$failures" -ne 0 ]; then
  status="failed"
fi

git_revision="$(git rev-parse HEAD 2>/dev/null || true)"
jq -s \
  --arg status "$status" \
  --arg generated_at "$timestamp" \
  --arg git_revision "$git_revision" \
  --arg evidence_dir "$EVIDENCE_DIR" \
  '{
    status: $status,
    generated_at: $generated_at,
    objective: "Gate 5 local static/build/test verification",
    git_revision: $git_revision,
    evidence_dir: $evidence_dir,
    commands: .
  }' "$RESULT_DIR"/*.json >"$EVIDENCE_DIR/summary.json"

if [ "$failures" -ne 0 ]; then
  echo "[gate5-local] Local verification failed; summary written to $EVIDENCE_DIR/summary.json" >&2
  exit 1
fi

echo "[gate5-local] Local verification passed"
echo "[gate5-local] Summary written to $EVIDENCE_DIR/summary.json"
