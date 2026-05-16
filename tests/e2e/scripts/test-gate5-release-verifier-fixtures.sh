#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
cd "$REPO_ROOT"

tmpdir="$(mktemp -d /tmp/kortix-gate5-verifier-fixture.XXXXXX)"
trap 'rm -rf "$tmpdir"' EXIT

local_dir="$tmpdir/local"
self_hosted_dir="$tmpdir/self-hosted"
target_dir="$tmpdir/target"
drills_dir="$tmpdir/drills"
mkdir -p "$local_dir/logs" "$self_hosted_dir" "$target_dir" "$drills_dir"

required_local_checks=(
  api_typecheck
  web_typecheck
  api_tests
  api_billing_tests
  api_accounts_contract_tests
  api_projects_contract_tests
  api_project_session_contract_tests
  api_project_connectors_contract_tests
  api_session_connectors_router_tests
  api_project_triggers_contract_tests
  api_project_channels_contract_tests
  api_rate_limit_tests
  api_proxy_contract_tests
  api_audit_tests
  api_usage_tests
  api_github_app_tests
  api_create_repo_starter_tests
  legacy_migration_tooling
  sandbox_daemon_auth
  sandbox_image_build
  api_image_build
  gate5_scripts_syntax
  gate5_release_verifier_fixture_tests
  web_auth_return_url_tests
  v1_playwright_spec_guards
  v1_legacy_script_guards
  v1_tree_cleanup_guards
  v1_legacy_web_route_guards
  git_diff_check
)

required_self_hosted_titles=(
  "owner can authenticate via Supabase API"
  "authenticated user can access setup-wizard-step"
  "authenticated user can read available sandbox providers"
  "browser login flow reaches wizard"
  "API and web enforce account roles plus project-scoped access"
  "admin overview and operations dashboard use the supported ops API cleanly"
  "E2E-2 and E2E-3: account filtering plus pending invite auto-claim"
  "E2E-1 and E2E-4: GitHub repo project starts a session and reaches daemon health"
  "E2E-5: local_docker provider starts the same sandbox image and reaches health"
  "E2E-6: new session opens the project chat route without legacy redirects"
  "E2E-7: signed webhook trigger fires a session and rejects bad signatures"
  "§10.6/§10.7 API boundaries and invite concurrency hold"
  "§10.6.C SLO probes meet the configured production budgets"
)

required_target_titles=(
  "API and web enforce account roles plus project-scoped access"
  "admin overview and operations dashboard use the supported ops API cleanly"
  "E2E-2 and E2E-3: account filtering plus pending invite auto-claim"
  "E2E-1 and E2E-4: GitHub repo project starts a session and reaches daemon health"
  "E2E-5: local_docker provider starts the same sandbox image and reaches health"
  "E2E-6: new session opens the project chat route without legacy redirects"
  "E2E-7: signed webhook trigger fires a session and rejects bad signatures"
  "§10.6/§10.7 API boundaries and invite concurrency hold"
  "§10.6.C SLO probes meet the configured production budgets"
)

write_local_summary() {
  local commands_json="$tmpdir/local-commands.json"
  printf '[]' >"$commands_json"
  for check in "${required_local_checks[@]}"; do
    printf '%s\n' "$check passed" >"$local_dir/logs/$check.log"
    jq \
      --arg name "$check" \
      --arg log "logs/$check.log" \
      '. + [{
        name: $name,
        status: "passed",
        command: "fixture",
        exit_code: 0,
        log: $log
      }]' "$commands_json" >"$commands_json.tmp"
    mv "$commands_json.tmp" "$commands_json"
  done

  jq -n \
    --slurpfile commands "$commands_json" \
    '{
      status: "passed",
      generated_at: "fixture",
      objective: "Gate 5 local static/build/test verification",
      git_revision: "fixture",
      evidence_dir: "fixture",
      commands: $commands[0]
    }' >"$local_dir/summary.json"
}

write_playwright_report() {
  local file="$1"
  local expected="$2"
  shift 2
  local titles_file="$tmpdir/titles.json"
  printf '%s\n' "$@" | jq -R . | jq -s . >"$titles_file"
  jq -n \
    --slurpfile titles "$titles_file" \
    --argjson expected "$expected" \
    '{
      errors: [],
      stats: {
        unexpected: 0,
        flaky: 0,
        expected: $expected,
        skipped: 0
      },
      suites: [
        { file: "04-auth-flow.spec.ts" },
        { file: "08-accounts-project-access.spec.ts" },
        { file: "09-admin-ops.spec.ts" },
        { file: "10-production-golden-paths.spec.ts" },
        { file: "11-production-boundaries.spec.ts" }
      ],
      specs: [
        $titles[0][] | {
          title: .,
          tests: [{
            expectedStatus: "passed",
            status: "passed",
            results: [{ status: "passed" }]
          }]
        }
      ]
    }' >"$file"
}

write_target_fixture() {
  local api_url="$1"
  local base_url="$2"
  local supabase_url="$3"

  cat >"$target_dir/health.headers" <<'HEADERS'
HTTP/2 200
x-request-id: req-fixture
traceparent: 00-11111111111111111111111111111111-2222222222222222-01
HEADERS

  cat >"$target_dir/run.log" <<'LOG'
[gate5] Target rehearsal passed
LOG

  jq -n '{status: "ok"}' >"$target_dir/health.json"
  jq -n \
    '{
      api: { status: "ok", env: "fixture", tunnel: {} },
      totals: { accounts: 1, projects: 1, active_legacy_sandboxes: 0 },
      sessions: { by_status: { running: 1 }, errored: 0 },
      sandboxes: { by_status: { active: 1 }, by_provider: { daytona: 1 }, errored: 0 },
      queues: { trigger_events_by_status: {}, channel_events_by_status: {}, queued_total: 0 },
      audit: { events_24h: 1, recent: [] },
      usage: { last_24h_by_provider: [], calls_24h: 1, cost_usd_24h: 0 },
      observability: {
        trace_headers_enabled: true,
        structured_request_logs_enabled: true,
        managed_logs_configured: true,
        otlp_exporter_configured: true,
        otlp_request_spans_enabled: true
      },
      migrations: { by_status: {}, active_legacy_sandboxes: 0 }
    }' >"$target_dir/ops-overview.json"

  jq -n \
    --arg api_url "$api_url" \
    --arg base_url "$base_url" \
    --arg supabase_url "$supabase_url" \
    '{
      status: "passed",
      generated_at: "fixture",
      target_rehearsal_runner: "tests/e2e/scripts/run-gate5-target-rehearsal.sh",
      evidence_contract_version: 1,
      api_url: $api_url,
      base_url: $base_url,
      supabase_url: $supabase_url,
      provider: "daytona",
      github_app_required: "1",
      golden_paths_enabled: "1",
      golden_backpressure_enabled: "1",
      local_docker_golden_enabled: "1",
      slos_enforced: "1",
      managed_observability_required: "1",
      no_active_legacy_required: "1",
      preflight_only: false,
      destructive_tests_run: true,
      observability_probe: {
        request_id: "req-fixture",
        trace_id: "11111111111111111111111111111111"
      }
    }' >"$target_dir/summary.json"

  write_playwright_report "$target_dir/playwright-report.json" 9 "${required_target_titles[@]}"

  jq -n \
    --arg api_url "$api_url" \
    '{
      status: "passed",
      evidence_contract_version: 1,
      api_url: $api_url,
      target_ids: {
        account_id: "account-fixture",
        project_id: "project-fixture",
        session_id: "session-fixture",
        external_id: "external-fixture"
      },
      endpoints: [
        { name: "health", status: 200, artifact: "api-curl-health.json" },
        { name: "accounts", status: 200, artifact: "api-curl-accounts.json" },
        { name: "account", status: 200, artifact: "api-curl-account.json" },
        { name: "account_members", status: 200, artifact: "api-curl-account-members.json" },
        { name: "account_invites", status: 200, artifact: "api-curl-account-invites.json" },
        { name: "projects", status: 200, artifact: "api-curl-projects.json" },
        { name: "project", status: 200, artifact: "api-curl-project.json" },
        { name: "project_detail", status: 200, artifact: "api-curl-project-detail.json" },
        { name: "project_files", status: 200, artifact: "api-curl-project-files.json" },
        { name: "project_file_content", status: 200, artifact: "api-curl-project-file-content.json" },
        { name: "project_sessions", status: 200, artifact: "api-curl-project-sessions.json" },
        { name: "project_session", status: 200, artifact: "api-curl-project-session.json" },
        { name: "session_sandbox", status: 200, artifact: "api-curl-session-sandbox.json" },
        { name: "proxy_health", status: 200, artifact: "api-curl-proxy-health.json" },
        { name: "proxy_app", status: 200, artifact: "api-curl-proxy-app.html", headers_artifact: "api-curl-proxy-app.headers" },
        { name: "proxy_opencode", status: 200, artifact: "api-curl-proxy-opencode.json" },
        { name: "proxy_opencode_agents", status: 200, artifact: "api-curl-proxy-opencode-agents.json" },
        { name: "proxy_refresh", status: 200, artifact: "api-curl-proxy-refresh.json" },
        { name: "ops_overview", status: 200, artifact: "api-curl-ops-overview.json" }
      ]
    }' >"$target_dir/api-curl-proof.json"
  jq -n '{status: "ok"}' >"$target_dir/api-curl-health.json"
  jq -n '[{account_id: "account-fixture"}]' >"$target_dir/api-curl-accounts.json"
  jq -n '{
    account_id: "account-fixture",
    name: "Fixture Account",
    personal_account: false,
    member_count: 1,
    project_count: 1,
    role: "owner"
  }' >"$target_dir/api-curl-account.json"
  jq -n '[
    {user_id: "user-fixture", email: "owner@example.test", account_role: "owner", joined_at: "2026-05-16T00:00:00.000Z"}
  ]' >"$target_dir/api-curl-account-members.json"
  jq -n '[]' >"$target_dir/api-curl-account-invites.json"
  jq -n '[{project_id: "project-fixture"}]' >"$target_dir/api-curl-projects.json"
  jq -n '{
    project_id: "project-fixture",
    account_id: "account-fixture",
    repo_url: "https://github.com/kortix/fixture.git",
    default_branch: "main",
    manifest_path: "kortix.toml",
    status: "active"
  }' >"$target_dir/api-curl-project.json"
  jq -n '{
    project: {
      project_id: "project-fixture",
      repo_url: "https://github.com/kortix/fixture.git"
    },
    config: { manifest: { project: { name: "fixture" } } },
    file_count: 3,
    files: [
      {type: "file", path: "README.md", name: "README.md"},
      {type: "file", path: "kortix.toml", name: "kortix.toml"},
      {type: "file", path: ".opencode/opencode.jsonc", name: "opencode.jsonc"}
    ]
  }' >"$target_dir/api-curl-project-detail.json"
  jq -n '[
    {type: "file", path: "README.md", name: "README.md"},
    {type: "file", path: "kortix.toml", name: "kortix.toml"},
    {type: "file", path: ".opencode/opencode.jsonc", name: "opencode.jsonc"}
  ]' >"$target_dir/api-curl-project-files.json"
  jq -n '{
    path: ".opencode/opencode.jsonc",
    ref: "main",
    content: "{\n  \"default_agent\": \"default\"\n}\n"
  }' >"$target_dir/api-curl-project-file-content.json"
  jq -n '[{session_id: "session-fixture", branch_name: "session-fixture", sandbox_provider: "daytona"}]' >"$target_dir/api-curl-project-sessions.json"
  jq -n '{
    session_id: "session-fixture",
    account_id: "account-fixture",
    project_id: "project-fixture",
    branch_name: "session-fixture",
    sandbox_id: "session-fixture",
    sandbox_provider: "daytona",
    status: "running"
  }' >"$target_dir/api-curl-project-session.json"
  jq -n '{
    sandbox_id: "session-fixture",
    project_id: "project-fixture",
    session_id: "session-fixture",
    provider: "daytona",
    external_id: "external-fixture",
    status: "active"
  }' >"$target_dir/api-curl-session-sandbox.json"
  jq -n '{
    daemon: "ok",
    opencode: "ok",
    uptime_s: 42,
    opencode_pid: 123,
    repo: "https://github.com/kortix/fixture.git",
    branch: "session-fixture",
    commit_sha: "1111111111111111111111111111111111111111",
    auth: "configured"
  }' >"$target_dir/api-curl-proxy-health.json"
  printf 'HTTP/2 200\r\ncontent-type: text/html; charset=utf-8\r\n\r\n' >"$target_dir/api-curl-proxy-app.headers"
  printf '<!doctype html><html><head><title>OpenCode</title></head><body></body></html>\n' >"$target_dir/api-curl-proxy-app.html"
  jq -n '[{type: "directory", path: ".opencode/agents", name: "agents"}]' >"$target_dir/api-curl-proxy-opencode.json"
  jq -n '[
    {type: "file", path: ".opencode/agents/default.md", name: "default.md"},
    {type: "file", path: ".opencode/agents/reviewer.md", name: "reviewer.md"}
  ]' >"$target_dir/api-curl-proxy-opencode-agents.json"
  jq -n '{
    ok: true,
    repo: {
      before: { commit: "1111111111111111111111111111111111111111" },
      after: { commit: "2222222222222222222222222222222222222222" }
    },
    opencode: "ok",
    opencode_pid: 123
  }' >"$target_dir/api-curl-proxy-refresh.json"
  cp "$target_dir/ops-overview.json" "$target_dir/api-curl-ops-overview.json"

  printf 'managed log evidence\n' >"$target_dir/managed-log-evidence.txt"
  printf 'otel evidence\n' >"$target_dir/otel-trace-evidence.txt"
  printf 'slo evidence\n' >"$target_dir/slo-evidence.txt"
  printf 'concurrency evidence\n' >"$target_dir/concurrency-evidence.txt"
  printf 'negative evidence\n' >"$target_dir/negative-evidence.txt"

  jq -n '{
    status: "passed",
    evidence_contract_version: 1,
    sink: "fixture",
    observed_at: "fixture",
    probe: { request_id: "req-fixture", trace_id: "11111111111111111111111111111111" },
    evidence: ["managed-log-evidence.txt"]
  }' >"$target_dir/managed-log-proof.json"
  jq -n '{
    status: "passed",
    evidence_contract_version: 1,
    sink: "fixture",
    observed_at: "fixture",
    probe: { trace_id: "11111111111111111111111111111111" },
    evidence: ["otel-trace-evidence.txt"]
  }' >"$target_dir/otel-trace-proof.json"
  jq -n '{
    status: "passed",
    evidence_contract_version: 1,
    observed_at: "fixture",
    evidence: ["slo-evidence.txt"],
    metrics: {
      session_create_p95_ms: { ok: true, limit: 800 },
      sandbox_active_p95_ms: { ok: true, provider: "daytona", limit: 45000 },
      proxy_health_p95_ms: { ok: true, limit: 250 },
      llm_router_overhead_median_ms: { ok: true, limit: 60 },
      projects_first_paint_p95_ms: { ok: true, limit: 1500 }
    }
  }' >"$target_dir/slo-proof.json"
  jq -n '{
    status: "passed",
    evidence_contract_version: 1,
    observed_at: "fixture",
    evidence: ["concurrency-evidence.txt"],
    checks: {
      parallel_session_creates: { ok: true, requested: 10, distinct_session_ids: 10, branches_pushed: 10, sandbox_rows: 10, duplicate_key_errors: 0 },
      concurrent_invite_accepts: { ok: true, member_rows: 1, idempotent_response_seen: true },
      sandbox_active_race: { ok: true, row_consistent: true },
      cap_enforcement: { ok: true, status: 429, branch_created: false, sandbox_created: false }
    }
  }' >"$target_dir/concurrency-proof.json"
  jq -n '{
    status: "passed",
    evidence_contract_version: 1,
    observed_at: "fixture",
    evidence: ["negative-evidence.txt"],
    checks: {
      legacy_urls_absent: { ok: true, instances_url_count: 0, bare_sessions_url_count: 0, dashboard_redirect_count: 0 },
      legacy_ui_absent: { ok: true, right_rail_count: 0, justavps_banner_count: 0 },
      provider_whitelist: { ok: true, justavps_session_status: 400 },
      sandbox_proxy_boundary: { ok: true, member_proxy_status: 200, outsider_proxy_status: 403 },
      removed_user_proxy_revocation: { ok: true, proxy_status: 403, observed_seconds: 4.2, limit_seconds: 5 },
      legacy_runtime_contamination: { ok: true, legacy_sandbox_rows: 0, legacy_platform_project_rows: 0 },
      session_switch_regressions: { ok: true, active_server_snapback_count: 0, stale_opencode_session_count: 0 }
    }
  }' >"$target_dir/negative-space-proof.json"
}

write_drills() {
  local api_url="$1"
  local drills=(
    provider-failure
    stripe-failure
    db-migration-rollback
    legacy-migration-rollback
    sandbox-image-rollback
    api-deploy-rollback
  )
  for drill in "${drills[@]}"; do
    mkdir -p "$drills_dir/$drill"
    printf '%s evidence\n' "$drill" >"$drills_dir/$drill/evidence.txt"
    cp "$target_dir/ops-overview.json" "$drills_dir/$drill/ops-overview-at-record.json"
    jq -n \
      --arg drill "$drill" \
      --arg api_url "$api_url" \
      '{
        evidence_contract_version: 1,
        drill: $drill,
        status: "passed",
        api_url: $api_url,
        ops_overview_file: "ops-overview-at-record.json",
        summary: "fixture",
        evidence: ["evidence.txt"]
      }' >"$drills_dir/$drill/summary.json"
  done
}

write_self_hosted_fixture() {
  jq -n '{
    evidence_contract_version: 1,
    status: "passed",
    golden_paths_enabled: "1",
    local_docker_golden_enabled: "1",
    golden_backpressure_enabled: "1",
    provider: "local_docker"
  }' >"$self_hosted_dir/summary.json"
  write_playwright_report "$self_hosted_dir/playwright-report.json" 13 "${required_self_hosted_titles[@]}"
  printf 'self-hosted fixture\n' >"$self_hosted_dir/playwright.log"
}

verify_status() {
  local file="$1"
  local expected_status="$2"
  jq -e \
    --arg expected_status "$expected_status" \
    '.status == $expected_status and .release_eligible == false and .non_release_manifest_acknowledged == true' \
    "$file" >/dev/null
}

assert_final_verifier_rejects_missing_proof_contracts() {
  local proof_file
  local backup
  local status

  for proof_file in \
    api-curl-proof.json \
    managed-log-proof.json \
    otel-trace-proof.json \
    slo-proof.json \
    concurrency-proof.json \
    negative-space-proof.json
  do
    backup="$tmpdir/$proof_file.backup"
    cp "$target_dir/$proof_file" "$backup"
    jq 'del(.evidence_contract_version)' "$backup" >"$target_dir/$proof_file"

    set +e
    GATE5_ALLOW_SYNTHETIC_EVIDENCE=1 \
    GATE5_ALLOW_NON_RELEASE_MANIFEST=1 \
    GATE5_LOCAL_EVIDENCE_DIR="$local_dir" \
    GATE5_SELF_HOSTED_EVIDENCE_DIR="$self_hosted_dir" \
    GATE5_TARGET_EVIDENCE_DIR="$target_dir" \
    GATE5_DRILLS_EVIDENCE_DIR="$drills_dir" \
    GATE5_RELEASE_MANIFEST="$tmpdir/missing-contract-$proof_file.json" \
    bash tests/e2e/scripts/verify-gate5-release-evidence.sh >"$tmpdir/missing-contract-$proof_file.out" 2>"$tmpdir/missing-contract-$proof_file.err"
    status=$?
    set -e
    if [ "$status" -eq 0 ]; then
      echo "[gate5-fixture] Expected final verifier to reject $proof_file without evidence_contract_version" >&2
      exit 1
    fi

    cp "$backup" "$target_dir/$proof_file"
  done
}

assert_final_verifier_rejects_missing_drill_contract() {
  local drill="provider-failure"
  local summary_file="$drills_dir/$drill/summary.json"
  local backup="$tmpdir/$drill-summary.backup"
  local status

  cp "$summary_file" "$backup"
  jq 'del(.evidence_contract_version)' "$backup" >"$summary_file"

  set +e
  GATE5_ALLOW_SYNTHETIC_EVIDENCE=1 \
  GATE5_ALLOW_NON_RELEASE_MANIFEST=1 \
  GATE5_LOCAL_EVIDENCE_DIR="$local_dir" \
  GATE5_SELF_HOSTED_EVIDENCE_DIR="$self_hosted_dir" \
  GATE5_TARGET_EVIDENCE_DIR="$target_dir" \
  GATE5_DRILLS_EVIDENCE_DIR="$drills_dir" \
  GATE5_RELEASE_MANIFEST="$tmpdir/missing-drill-contract.json" \
  bash tests/e2e/scripts/verify-gate5-release-evidence.sh >"$tmpdir/missing-drill-contract.out" 2>"$tmpdir/missing-drill-contract.err"
  status=$?
  set -e
  if [ "$status" -eq 0 ]; then
    echo "[gate5-fixture] Expected final verifier to reject runbook drill summary without evidence_contract_version" >&2
    exit 1
  fi

  cp "$backup" "$summary_file"
}

assert_final_verifier_rejects_missing_drill_ops_snapshot() {
  local drill="provider-failure"
  local summary_file="$drills_dir/$drill/summary.json"
  local backup="$tmpdir/$drill-ops-summary.backup"
  local status

  cp "$summary_file" "$backup"
  jq '.ops_overview_file = "missing-ops-overview.json"' "$backup" >"$summary_file"

  set +e
  GATE5_ALLOW_SYNTHETIC_EVIDENCE=1 \
  GATE5_ALLOW_NON_RELEASE_MANIFEST=1 \
  GATE5_LOCAL_EVIDENCE_DIR="$local_dir" \
  GATE5_SELF_HOSTED_EVIDENCE_DIR="$self_hosted_dir" \
  GATE5_TARGET_EVIDENCE_DIR="$target_dir" \
  GATE5_DRILLS_EVIDENCE_DIR="$drills_dir" \
  GATE5_RELEASE_MANIFEST="$tmpdir/missing-drill-ops.json" \
  bash tests/e2e/scripts/verify-gate5-release-evidence.sh >"$tmpdir/missing-drill-ops.out" 2>"$tmpdir/missing-drill-ops.err"
  status=$?
  set -e
  if [ "$status" -eq 0 ]; then
    echo "[gate5-fixture] Expected final verifier to reject runbook drill summary without an ops overview snapshot" >&2
    exit 1
  fi

  cp "$backup" "$summary_file"
}

assert_final_verifier_rejects_missing_self_hosted_contract() {
  local summary_file="$self_hosted_dir/summary.json"
  local backup="$tmpdir/self-hosted-summary.backup"
  local status

  cp "$summary_file" "$backup"
  jq 'del(.evidence_contract_version)' "$backup" >"$summary_file"

  set +e
  GATE5_ALLOW_SYNTHETIC_EVIDENCE=1 \
  GATE5_ALLOW_NON_RELEASE_MANIFEST=1 \
  GATE5_LOCAL_EVIDENCE_DIR="$local_dir" \
  GATE5_SELF_HOSTED_EVIDENCE_DIR="$self_hosted_dir" \
  GATE5_TARGET_EVIDENCE_DIR="$target_dir" \
  GATE5_DRILLS_EVIDENCE_DIR="$drills_dir" \
  GATE5_RELEASE_MANIFEST="$tmpdir/missing-self-hosted-contract.json" \
  bash tests/e2e/scripts/verify-gate5-release-evidence.sh >"$tmpdir/missing-self-hosted-contract.out" 2>"$tmpdir/missing-self-hosted-contract.err"
  status=$?
  set -e
  if [ "$status" -eq 0 ]; then
    echo "[gate5-fixture] Expected final verifier to reject self-hosted summary without evidence_contract_version" >&2
    exit 1
  fi

  cp "$backup" "$summary_file"
}

assert_final_verifier_rejects_missing_api_session_invariant() {
  local sessions_file="$target_dir/api-curl-project-sessions.json"
  local sandbox_file="$target_dir/api-curl-session-sandbox.json"
  local sessions_backup="$tmpdir/api-curl-project-sessions.backup"
  local sandbox_backup="$tmpdir/api-curl-session-sandbox.backup"
  local status

  cp "$sessions_file" "$sessions_backup"
  cp "$sandbox_file" "$sandbox_backup"

  jq '.[0].branch_name = "not-the-session-id"' "$sessions_backup" >"$sessions_file"
  set +e
  GATE5_ALLOW_SYNTHETIC_EVIDENCE=1 \
  GATE5_ALLOW_NON_RELEASE_MANIFEST=1 \
  GATE5_LOCAL_EVIDENCE_DIR="$local_dir" \
  GATE5_SELF_HOSTED_EVIDENCE_DIR="$self_hosted_dir" \
  GATE5_TARGET_EVIDENCE_DIR="$target_dir" \
  GATE5_DRILLS_EVIDENCE_DIR="$drills_dir" \
  GATE5_RELEASE_MANIFEST="$tmpdir/missing-api-session-branch-invariant.json" \
  bash tests/e2e/scripts/verify-gate5-release-evidence.sh >"$tmpdir/missing-api-session-branch-invariant.out" 2>"$tmpdir/missing-api-session-branch-invariant.err"
  status=$?
  set -e
  if [ "$status" -eq 0 ]; then
    echo "[gate5-fixture] Expected final verifier to reject API curl project sessions without branch_name == session_id" >&2
    exit 1
  fi
  cp "$sessions_backup" "$sessions_file"

  jq '.external_id = .session_id' "$sandbox_backup" >"$sandbox_file"
  set +e
  GATE5_ALLOW_SYNTHETIC_EVIDENCE=1 \
  GATE5_ALLOW_NON_RELEASE_MANIFEST=1 \
  GATE5_LOCAL_EVIDENCE_DIR="$local_dir" \
  GATE5_SELF_HOSTED_EVIDENCE_DIR="$self_hosted_dir" \
  GATE5_TARGET_EVIDENCE_DIR="$target_dir" \
  GATE5_DRILLS_EVIDENCE_DIR="$drills_dir" \
  GATE5_RELEASE_MANIFEST="$tmpdir/missing-api-sandbox-external-invariant.json" \
  bash tests/e2e/scripts/verify-gate5-release-evidence.sh >"$tmpdir/missing-api-sandbox-external-invariant.out" 2>"$tmpdir/missing-api-sandbox-external-invariant.err"
  status=$?
  set -e
  if [ "$status" -eq 0 ]; then
    echo "[gate5-fixture] Expected final verifier to reject API curl sandbox with provider-owned external_id missing" >&2
    exit 1
  fi
  cp "$sandbox_backup" "$sandbox_file"
}

assert_final_verifier_rejects_malformed_refresh_proof() {
  local refresh_file="$target_dir/api-curl-proxy-refresh.json"
  local backup="$tmpdir/api-curl-proxy-refresh.backup"
  local status

  cp "$refresh_file" "$backup"
  jq '.ok = false' "$backup" >"$refresh_file"

  set +e
  GATE5_ALLOW_SYNTHETIC_EVIDENCE=1 \
  GATE5_ALLOW_NON_RELEASE_MANIFEST=1 \
  GATE5_LOCAL_EVIDENCE_DIR="$local_dir" \
  GATE5_SELF_HOSTED_EVIDENCE_DIR="$self_hosted_dir" \
  GATE5_TARGET_EVIDENCE_DIR="$target_dir" \
  GATE5_DRILLS_EVIDENCE_DIR="$drills_dir" \
  GATE5_RELEASE_MANIFEST="$tmpdir/malformed-refresh-proof.json" \
  bash tests/e2e/scripts/verify-gate5-release-evidence.sh >"$tmpdir/malformed-refresh-proof.out" 2>"$tmpdir/malformed-refresh-proof.err"
  status=$?
  set -e
  if [ "$status" -eq 0 ]; then
    echo "[gate5-fixture] Expected final verifier to reject malformed /kortix/refresh API curl proof" >&2
    exit 1
  fi

  cp "$backup" "$refresh_file"
}

assert_final_verifier_rejects_malformed_daemon_health() {
  local health_file="$target_dir/api-curl-proxy-health.json"
  local backup="$tmpdir/api-curl-proxy-health.backup"
  local status

  cp "$health_file" "$backup"
  jq '.opencode = "starting"' "$backup" >"$health_file"

  set +e
  GATE5_ALLOW_SYNTHETIC_EVIDENCE=1 \
  GATE5_ALLOW_NON_RELEASE_MANIFEST=1 \
  GATE5_LOCAL_EVIDENCE_DIR="$local_dir" \
  GATE5_SELF_HOSTED_EVIDENCE_DIR="$self_hosted_dir" \
  GATE5_TARGET_EVIDENCE_DIR="$target_dir" \
  GATE5_DRILLS_EVIDENCE_DIR="$drills_dir" \
  GATE5_RELEASE_MANIFEST="$tmpdir/malformed-daemon-health.json" \
  bash tests/e2e/scripts/verify-gate5-release-evidence.sh >"$tmpdir/malformed-daemon-health.out" 2>"$tmpdir/malformed-daemon-health.err"
  status=$?
  set -e
  if [ "$status" -eq 0 ]; then
    echo "[gate5-fixture] Expected final verifier to reject daemon health without opencode == ok" >&2
    exit 1
  fi

  cp "$backup" "$health_file"
}

assert_final_verifier_rejects_malformed_proxy_app() {
  local app_file="$target_dir/api-curl-proxy-app.html"
  local backup="$tmpdir/api-curl-proxy-app.backup"
  local status

  cp "$app_file" "$backup"
  printf '<!doctype html><title>Wrong</title>\n' >"$app_file"

  set +e
  GATE5_ALLOW_SYNTHETIC_EVIDENCE=1 \
  GATE5_ALLOW_NON_RELEASE_MANIFEST=1 \
  GATE5_LOCAL_EVIDENCE_DIR="$local_dir" \
  GATE5_SELF_HOSTED_EVIDENCE_DIR="$self_hosted_dir" \
  GATE5_TARGET_EVIDENCE_DIR="$target_dir" \
  GATE5_DRILLS_EVIDENCE_DIR="$drills_dir" \
  GATE5_RELEASE_MANIFEST="$tmpdir/malformed-proxy-app.json" \
  bash tests/e2e/scripts/verify-gate5-release-evidence.sh >"$tmpdir/malformed-proxy-app.out" 2>"$tmpdir/malformed-proxy-app.err"
  status=$?
  set -e
  if [ "$status" -eq 0 ]; then
    echo "[gate5-fixture] Expected final verifier to reject proxied /app without OpenCode title" >&2
    exit 1
  fi

  cp "$backup" "$app_file"
}

assert_final_verifier_rejects_malformed_repo_file_content() {
  local content_file="$target_dir/api-curl-project-file-content.json"
  local backup="$tmpdir/api-curl-project-file-content.backup"
  local status

  cp "$content_file" "$backup"
  jq '.content = "{}"' "$backup" >"$content_file"

  set +e
  GATE5_ALLOW_SYNTHETIC_EVIDENCE=1 \
  GATE5_ALLOW_NON_RELEASE_MANIFEST=1 \
  GATE5_LOCAL_EVIDENCE_DIR="$local_dir" \
  GATE5_SELF_HOSTED_EVIDENCE_DIR="$self_hosted_dir" \
  GATE5_TARGET_EVIDENCE_DIR="$target_dir" \
  GATE5_DRILLS_EVIDENCE_DIR="$drills_dir" \
  GATE5_RELEASE_MANIFEST="$tmpdir/malformed-repo-file-content.json" \
  bash tests/e2e/scripts/verify-gate5-release-evidence.sh >"$tmpdir/malformed-repo-file-content.out" 2>"$tmpdir/malformed-repo-file-content.err"
  status=$?
  set -e
  if [ "$status" -eq 0 ]; then
    echo "[gate5-fixture] Expected final verifier to reject repo file content without OpenCode config" >&2
    exit 1
  fi

  cp "$backup" "$content_file"
}

assert_final_verifier_rejects_malformed_project_or_session_shape() {
  local project_file="$target_dir/api-curl-project.json"
  local session_file="$target_dir/api-curl-project-session.json"
  local project_backup="$tmpdir/api-curl-project.backup"
  local session_backup="$tmpdir/api-curl-project-session.backup"
  local status

  cp "$project_file" "$project_backup"
  cp "$session_file" "$session_backup"

  jq '.status = "archived"' "$project_backup" >"$project_file"
  set +e
  GATE5_ALLOW_SYNTHETIC_EVIDENCE=1 \
  GATE5_ALLOW_NON_RELEASE_MANIFEST=1 \
  GATE5_LOCAL_EVIDENCE_DIR="$local_dir" \
  GATE5_SELF_HOSTED_EVIDENCE_DIR="$self_hosted_dir" \
  GATE5_TARGET_EVIDENCE_DIR="$target_dir" \
  GATE5_DRILLS_EVIDENCE_DIR="$drills_dir" \
  GATE5_RELEASE_MANIFEST="$tmpdir/malformed-project-shape.json" \
  bash tests/e2e/scripts/verify-gate5-release-evidence.sh >"$tmpdir/malformed-project-shape.out" 2>"$tmpdir/malformed-project-shape.err"
  status=$?
  set -e
  if [ "$status" -eq 0 ]; then
    echo "[gate5-fixture] Expected final verifier to reject malformed project shape" >&2
    exit 1
  fi
  cp "$project_backup" "$project_file"

  jq '.sandbox_id = "not-the-session-id"' "$session_backup" >"$session_file"
  set +e
  GATE5_ALLOW_SYNTHETIC_EVIDENCE=1 \
  GATE5_ALLOW_NON_RELEASE_MANIFEST=1 \
  GATE5_LOCAL_EVIDENCE_DIR="$local_dir" \
  GATE5_SELF_HOSTED_EVIDENCE_DIR="$self_hosted_dir" \
  GATE5_TARGET_EVIDENCE_DIR="$target_dir" \
  GATE5_DRILLS_EVIDENCE_DIR="$drills_dir" \
  GATE5_RELEASE_MANIFEST="$tmpdir/malformed-session-shape.json" \
  bash tests/e2e/scripts/verify-gate5-release-evidence.sh >"$tmpdir/malformed-session-shape.out" 2>"$tmpdir/malformed-session-shape.err"
  status=$?
  set -e
  if [ "$status" -eq 0 ]; then
    echo "[gate5-fixture] Expected final verifier to reject malformed project session shape" >&2
    exit 1
  fi
  cp "$session_backup" "$session_file"
}

assert_final_verifier_rejects_malformed_account_shape() {
  local account_file="$target_dir/api-curl-account.json"
  local members_file="$target_dir/api-curl-account-members.json"
  local account_backup="$tmpdir/api-curl-account.backup"
  local members_backup="$tmpdir/api-curl-account-members.backup"
  local status

  cp "$account_file" "$account_backup"
  cp "$members_file" "$members_backup"

  jq '.member_count = 0' "$account_backup" >"$account_file"
  set +e
  GATE5_ALLOW_SYNTHETIC_EVIDENCE=1 \
  GATE5_ALLOW_NON_RELEASE_MANIFEST=1 \
  GATE5_LOCAL_EVIDENCE_DIR="$local_dir" \
  GATE5_SELF_HOSTED_EVIDENCE_DIR="$self_hosted_dir" \
  GATE5_TARGET_EVIDENCE_DIR="$target_dir" \
  GATE5_DRILLS_EVIDENCE_DIR="$drills_dir" \
  GATE5_RELEASE_MANIFEST="$tmpdir/malformed-account-shape.json" \
  bash tests/e2e/scripts/verify-gate5-release-evidence.sh >"$tmpdir/malformed-account-shape.out" 2>"$tmpdir/malformed-account-shape.err"
  status=$?
  set -e
  if [ "$status" -eq 0 ]; then
    echo "[gate5-fixture] Expected final verifier to reject malformed account shape" >&2
    exit 1
  fi
  cp "$account_backup" "$account_file"

  jq '.[0].account_role = "guest"' "$members_backup" >"$members_file"
  set +e
  GATE5_ALLOW_SYNTHETIC_EVIDENCE=1 \
  GATE5_ALLOW_NON_RELEASE_MANIFEST=1 \
  GATE5_LOCAL_EVIDENCE_DIR="$local_dir" \
  GATE5_SELF_HOSTED_EVIDENCE_DIR="$self_hosted_dir" \
  GATE5_TARGET_EVIDENCE_DIR="$target_dir" \
  GATE5_DRILLS_EVIDENCE_DIR="$drills_dir" \
  GATE5_RELEASE_MANIFEST="$tmpdir/malformed-account-members.json" \
  bash tests/e2e/scripts/verify-gate5-release-evidence.sh >"$tmpdir/malformed-account-members.out" 2>"$tmpdir/malformed-account-members.err"
  status=$?
  set -e
  if [ "$status" -eq 0 ]; then
    echo "[gate5-fixture] Expected final verifier to reject malformed account members shape" >&2
    exit 1
  fi
  cp "$members_backup" "$members_file"
}

assert_target_recorders_reject_stale_contract() {
  local backup="$tmpdir/current-target-summary.json"
  local status

  cp "$target_dir/summary.json" "$backup"
  jq 'del(.target_rehearsal_runner, .evidence_contract_version)' "$backup" >"$target_dir/summary.json"

  set +e
  GATE5_API_CURL_CONFIRM=I_VERIFIED_TARGET_API_CURLS \
  GATE5_TARGET_EVIDENCE_DIR="$target_dir" \
  GATE5_API_CURL_USER_TOKEN=dummy-user-token \
  ADMIN_TOKEN=dummy-admin-token \
  GATE5_API_CURL_ACCOUNT_ID=account-fixture \
  GATE5_API_CURL_PROJECT_ID=project-fixture \
  GATE5_API_CURL_SESSION_ID=session-fixture \
  GATE5_API_CURL_EXTERNAL_ID=external-fixture \
  bash tests/e2e/scripts/record-gate5-api-curl-proof.sh >"$tmpdir/stale-api-curl.out" 2>"$tmpdir/stale-api-curl.err"
  status=$?
  set -e
  if [ "$status" -eq 0 ]; then
    echo "[gate5-fixture] Expected API curl recorder to reject stale target summary contract" >&2
    exit 1
  fi
  grep -q "stale-contract" "$tmpdir/stale-api-curl.err"

  set +e
  GATE5_OBSERVABILITY_CONFIRM=I_VERIFIED_TARGET_OBSERVABILITY \
  GATE5_TARGET_EVIDENCE_DIR="$target_dir" \
  GATE5_MANAGED_LOG_SINK="fixture logs" \
  GATE5_MANAGED_LOG_EVIDENCE=managed-log-evidence.txt \
  GATE5_OTEL_TRACE_SINK="fixture traces" \
  GATE5_OTEL_TRACE_EVIDENCE=otel-trace-evidence.txt \
  bash tests/e2e/scripts/record-gate5-observability-proof.sh >"$tmpdir/stale-observability.out" 2>"$tmpdir/stale-observability.err"
  status=$?
  set -e
  if [ "$status" -eq 0 ]; then
    echo "[gate5-fixture] Expected observability recorder to reject stale target summary contract" >&2
    exit 1
  fi
  grep -q "stale-contract" "$tmpdir/stale-observability.err"

  set +e
  GATE5_SLO_CONFIRM=I_VERIFIED_TARGET_SLOS \
  GATE5_TARGET_EVIDENCE_DIR="$target_dir" \
  GATE5_SLO_SESSION_CREATE_P95_MS=740 \
  GATE5_SLO_SANDBOX_PROVIDER=daytona \
  GATE5_SLO_SANDBOX_ACTIVE_P95_MS=32000 \
  GATE5_SLO_PROXY_HEALTH_P95_MS=120 \
  GATE5_SLO_LLM_ROUTER_OVERHEAD_MEDIAN_MS=35 \
  GATE5_SLO_PROJECTS_FIRST_PAINT_P95_MS=900 \
  GATE5_SLO_EVIDENCE=slo-evidence.txt \
  bash tests/e2e/scripts/record-gate5-slo-proof.sh >"$tmpdir/stale-slo.out" 2>"$tmpdir/stale-slo.err"
  status=$?
  set -e
  if [ "$status" -eq 0 ]; then
    echo "[gate5-fixture] Expected SLO recorder to reject stale target summary contract" >&2
    exit 1
  fi
  grep -q "stale-contract" "$tmpdir/stale-slo.err"

  set +e
  GATE5_CONCURRENCY_CONFIRM=I_VERIFIED_TARGET_CONCURRENCY \
  GATE5_TARGET_EVIDENCE_DIR="$target_dir" \
  GATE5_CONCURRENCY_PARALLEL_SESSION_REQUESTS=10 \
  GATE5_CONCURRENCY_DISTINCT_SESSION_IDS=10 \
  GATE5_CONCURRENCY_BRANCHES_PUSHED=10 \
  GATE5_CONCURRENCY_SANDBOX_ROWS=10 \
  GATE5_CONCURRENCY_DUPLICATE_KEY_ERRORS=0 \
  GATE5_CONCURRENCY_INVITE_MEMBER_ROWS=1 \
  GATE5_CONCURRENCY_INVITE_IDEMPOTENT_SEEN=1 \
  GATE5_CONCURRENCY_SANDBOX_RACE_CONSISTENT=1 \
  GATE5_CONCURRENCY_CAP_STATUS=429 \
  GATE5_CONCURRENCY_CAP_BRANCH_CREATED=0 \
  GATE5_CONCURRENCY_CAP_SANDBOX_CREATED=0 \
  GATE5_CONCURRENCY_EVIDENCE=concurrency-evidence.txt \
  bash tests/e2e/scripts/record-gate5-concurrency-proof.sh >"$tmpdir/stale-concurrency.out" 2>"$tmpdir/stale-concurrency.err"
  status=$?
  set -e
  if [ "$status" -eq 0 ]; then
    echo "[gate5-fixture] Expected concurrency recorder to reject stale target summary contract" >&2
    exit 1
  fi
  grep -q "stale-contract" "$tmpdir/stale-concurrency.err"

  set +e
  GATE5_NEGATIVE_CONFIRM=I_VERIFIED_TARGET_NEGATIVE_SPACE \
  GATE5_TARGET_EVIDENCE_DIR="$target_dir" \
  GATE5_NEGATIVE_INSTANCES_URL_COUNT=0 \
  GATE5_NEGATIVE_BARE_SESSIONS_URL_COUNT=0 \
  GATE5_NEGATIVE_DASHBOARD_REDIRECT_COUNT=0 \
  GATE5_NEGATIVE_RIGHT_RAIL_COUNT=0 \
  GATE5_NEGATIVE_JUSTAVPS_BANNER_COUNT=0 \
  GATE5_NEGATIVE_JUSTAVPS_SESSION_STATUS=400 \
  GATE5_NEGATIVE_MEMBER_PROXY_STATUS=200 \
  GATE5_NEGATIVE_OUTSIDER_PROXY_STATUS=403 \
  GATE5_NEGATIVE_REMOVED_USER_PROXY_STATUS=403 \
  GATE5_NEGATIVE_REMOVED_USER_PROXY_SECONDS=4.2 \
  GATE5_NEGATIVE_LEGACY_SANDBOX_ROWS=0 \
  GATE5_NEGATIVE_LEGACY_PLATFORM_PROJECT_ROWS=0 \
  GATE5_NEGATIVE_ACTIVE_SERVER_SNAPBACK_COUNT=0 \
  GATE5_NEGATIVE_STALE_OPENCODE_SESSION_COUNT=0 \
  GATE5_NEGATIVE_EVIDENCE=negative-evidence.txt \
  bash tests/e2e/scripts/record-gate5-negative-space-proof.sh >"$tmpdir/stale-negative.out" 2>"$tmpdir/stale-negative.err"
  status=$?
  set -e
  if [ "$status" -eq 0 ]; then
    echo "[gate5-fixture] Expected negative-space recorder to reject stale target summary contract" >&2
    exit 1
  fi
  grep -q "stale-contract" "$tmpdir/stale-negative.err"

  set +e
  GATE5_OPS_EXCEPTIONS_CONFIRM=I_ACCEPT_TARGET_OPS_EXCEPTIONS \
  GATE5_TARGET_EVIDENCE_DIR="$target_dir" \
  GATE5_OPS_EXCEPTION_ITEMS='queues.queued_total|Fixture queued exception.|ops-exception-evidence.txt' \
  bash tests/e2e/scripts/record-gate5-ops-exceptions.sh >"$tmpdir/stale-ops-exceptions.out" 2>"$tmpdir/stale-ops-exceptions.err"
  status=$?
  set -e
  if [ "$status" -eq 0 ]; then
    echo "[gate5-fixture] Expected ops-exceptions recorder to reject stale target summary contract" >&2
    exit 1
  fi
  grep -q "stale-contract" "$tmpdir/stale-ops-exceptions.err"

  cp "$backup" "$target_dir/summary.json"
}

write_local_summary
write_self_hosted_fixture
write_target_fixture "http://127.0.0.1:61607/v1" "http://127.0.0.1:61607" "http://127.0.0.1:61608"
write_drills "http://127.0.0.1:61607/v1"
assert_final_verifier_rejects_missing_proof_contracts
assert_final_verifier_rejects_missing_drill_contract
assert_final_verifier_rejects_missing_drill_ops_snapshot
assert_final_verifier_rejects_missing_self_hosted_contract
assert_final_verifier_rejects_missing_api_session_invariant
assert_final_verifier_rejects_malformed_refresh_proof
assert_final_verifier_rejects_malformed_daemon_health
assert_final_verifier_rejects_malformed_proxy_app
assert_final_verifier_rejects_malformed_repo_file_content
assert_final_verifier_rejects_malformed_project_or_session_shape
assert_final_verifier_rejects_malformed_account_shape
assert_target_recorders_reject_stale_contract

set +e
GATE5_ALLOW_SYNTHETIC_EVIDENCE=1 \
GATE5_LOCAL_EVIDENCE_DIR="$local_dir" \
GATE5_SELF_HOSTED_EVIDENCE_DIR="$self_hosted_dir" \
GATE5_TARGET_EVIDENCE_DIR="$target_dir" \
GATE5_DRILLS_EVIDENCE_DIR="$drills_dir" \
GATE5_RELEASE_MANIFEST="$tmpdir/no-ack.json" \
bash tests/e2e/scripts/verify-gate5-release-evidence.sh >"$tmpdir/no-ack.out" 2>"$tmpdir/no-ack.err"
no_ack_status=$?
set -e
if [ "$no_ack_status" -eq 0 ]; then
  echo "[gate5-fixture] Expected synthetic fixture without non-release acknowledgement to fail" >&2
  exit 1
fi
grep -q "GATE5_ALLOW_NON_RELEASE_MANIFEST=1" "$tmpdir/no-ack.err"

GATE5_ALLOW_SYNTHETIC_EVIDENCE=1 \
GATE5_ALLOW_NON_RELEASE_MANIFEST=1 \
GATE5_LOCAL_EVIDENCE_DIR="$local_dir" \
GATE5_SELF_HOSTED_EVIDENCE_DIR="$self_hosted_dir" \
GATE5_TARGET_EVIDENCE_DIR="$target_dir" \
GATE5_DRILLS_EVIDENCE_DIR="$drills_dir" \
GATE5_RELEASE_MANIFEST="$tmpdir/synthetic.json" \
bash tests/e2e/scripts/verify-gate5-release-evidence.sh >/dev/null
verify_status "$tmpdir/synthetic.json" "synthetic-complete"

rm -rf "$target_dir" "$drills_dir"
mkdir -p "$target_dir" "$drills_dir"
write_target_fixture "https://gate5-target.kortix.dev/v1" "https://gate5-target.kortix.dev" "https://gate5-supabase.kortix.dev"
write_drills "https://gate5-target.kortix.dev/v1"
jq '.evidence[0] = "http://artifacts.kortix.dev/managed-log.txt"' \
  "$target_dir/managed-log-proof.json" >"$target_dir/managed-log-proof.tmp"
mv "$target_dir/managed-log-proof.tmp" "$target_dir/managed-log-proof.json"

set +e
GATE5_LOCAL_EVIDENCE_DIR="$local_dir" \
GATE5_SELF_HOSTED_EVIDENCE_DIR="$self_hosted_dir" \
GATE5_TARGET_EVIDENCE_DIR="$target_dir" \
GATE5_DRILLS_EVIDENCE_DIR="$drills_dir" \
GATE5_RELEASE_MANIFEST="$tmpdir/http-evidence.json" \
bash tests/e2e/scripts/verify-gate5-release-evidence.sh >"$tmpdir/http-evidence.out" 2>"$tmpdir/http-evidence.err"
http_evidence_status=$?
set -e
if [ "$http_evidence_status" -eq 0 ]; then
  echo "[gate5-fixture] Expected plain-HTTP evidence URL to fail by default" >&2
  exit 1
fi
grep -q "Evidence artifact URL must be a real HTTPS URL" "$tmpdir/http-evidence.err"

set +e
GATE5_ALLOW_INSECURE_TARGET_URLS=1 \
GATE5_LOCAL_EVIDENCE_DIR="$local_dir" \
GATE5_SELF_HOSTED_EVIDENCE_DIR="$self_hosted_dir" \
GATE5_TARGET_EVIDENCE_DIR="$target_dir" \
GATE5_DRILLS_EVIDENCE_DIR="$drills_dir" \
GATE5_RELEASE_MANIFEST="$tmpdir/http-evidence-no-ack.json" \
bash tests/e2e/scripts/verify-gate5-release-evidence.sh >"$tmpdir/http-evidence-no-ack.out" 2>"$tmpdir/http-evidence-no-ack.err"
http_evidence_no_ack_status=$?
set -e
if [ "$http_evidence_no_ack_status" -eq 0 ]; then
  echo "[gate5-fixture] Expected insecure evidence URL without non-release acknowledgement to fail" >&2
  exit 1
fi
grep -q "GATE5_ALLOW_NON_RELEASE_MANIFEST=1" "$tmpdir/http-evidence-no-ack.err"

GATE5_ALLOW_INSECURE_TARGET_URLS=1 \
GATE5_ALLOW_NON_RELEASE_MANIFEST=1 \
GATE5_LOCAL_EVIDENCE_DIR="$local_dir" \
GATE5_SELF_HOSTED_EVIDENCE_DIR="$self_hosted_dir" \
GATE5_TARGET_EVIDENCE_DIR="$target_dir" \
GATE5_DRILLS_EVIDENCE_DIR="$drills_dir" \
GATE5_RELEASE_MANIFEST="$tmpdir/http-evidence-ack.json" \
bash tests/e2e/scripts/verify-gate5-release-evidence.sh >/dev/null
verify_status "$tmpdir/http-evidence-ack.json" "insecure-evidence-complete"

echo "[gate5-fixture] Release verifier fixture gates passed"
