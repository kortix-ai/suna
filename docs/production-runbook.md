# Kortix Production Runbook

This runbook is the Gate 5 companion to `docs/SPEC.md`. It covers the production checks and rollback paths that must exist before Kortix is treated as production-ready.

## 1. Preflight

Run these before any production deploy, DB migration, provider config change, or sandbox image promotion.

```sh
curl -fsS https://new-api.kortix.com/v1/health
curl -fsS https://new-api.kortix.com/v1/ops/overview -H "Authorization: Bearer $ADMIN_TOKEN" | jq '{api, totals, sessions, sandboxes, queues, usage, migrations}'
```

Required state:
- API health is `ok`.
- `/v1/ops/overview` returns without 4xx or 5xx.
- `queues.queued_total` is understood before proceeding.
- `sandboxes.errored` and `sessions.errored` are either zero or linked to known incidents.
- `migrations.by_status.failed` is zero.

## 2. Release Validation

After deploy, run the production-like golden path from `docs/SPEC.md` section 10.5 against the target stack.

Local static/build/test evidence:

```sh
GATE5_LOCAL_ENV_FILE=/secure/path/to/local-or-staging-e2e.env \
pnpm --dir tests run test:e2e:gate5:local
```

This writes `test-results/gate5-local-verification/<timestamp>/summary.json`
plus logs for API/web typechecks, API tests, sandbox daemon auth, sandbox image
build, API image build, focused billing, rate-limit, audit, usage, and legacy
migration rollback tests, Gate 5 script syntax, and `git diff --check`. The
legacy migration test requires a non-production `DATABASE_URL` via
`TEST_DATABASE_URL`, `GATE5_LOCAL_DATABASE_URL`, `DATABASE_URL`, or
`GATE5_LOCAL_ENV_FILE`.

Minimum curl checks, recorded as a required Gate 5 proof artifact:

```sh
GATE5_API_CURL_CONFIRM=I_VERIFIED_TARGET_API_CURLS \
GATE5_TARGET_EVIDENCE_DIR=test-results/gate5-rehearsal/<timestamp> \
GATE5_API_CURL_USER_TOKEN="$USER_TOKEN" \
ADMIN_TOKEN="$ADMIN_TOKEN" \
GATE5_API_CURL_ACCOUNT_ID="$ACCOUNT_ID" \
GATE5_API_CURL_PROJECT_ID="$PROJECT_ID" \
GATE5_API_CURL_SESSION_ID="$SESSION_ID" \
GATE5_API_CURL_EXTERNAL_ID="$EXTERNAL_ID" \
pnpm --dir tests run test:e2e:gate5:record-api-curl
```

This writes `api-curl-proof.json` plus response artifacts for `/health`,
`/accounts`, `/accounts/<id>`, `/accounts/<id>/members`,
`/accounts/<id>/invites`, `/projects?account_id=...`, `/projects/<id>`,
`/projects/<id>/detail`, `/projects/<id>/files`,
`/projects/<id>/files/content?path=.opencode/opencode.jsonc`,
`/projects/<id>/sessions`, `/projects/<id>/sessions/<sid>`,
`/projects/<id>/sessions/<sid>/sandbox`, `/p/<external>/8000/kortix/health`,
`/p/<external>/8000/app`,
`/p/<external>/8000/file?path=.opencode`,
`/p/<external>/8000/file?path=.opencode/agents`,
`POST /p/<external>/8000/kortix/refresh`, and `/ops/overview`. The
recorder and final verifier require the response artifacts to prove
`session_id == sandbox_id == branch_name`, `sandbox_provider/provider ==
"daytona"`, `external_id != session_id`, and a successful signed daemon
refresh result; the `/app` artifact must be the OpenCode HTML shell.
The project file artifacts must prove the server-side repo mirror can read the
starter OpenCode config without going through the sandbox proxy.

Minimum web checks:
- `/projects` loads authenticated.
- Creating or opening a project session stays under `/projects/<projectId>/sessions/<sessionId>`.
- No authenticated project flow redirects to `/instances`, `/dashboard`, or bare `/sessions/<id>`.
- `/admin/ops` loads for a platform admin with no 4xx network responses and no console errors.

Self-hosted rehearsal entry points:

```sh
# Clean install rehearsal. By default this removes ~/.kortix before reinstalling.
bash tests/e2e/self-hosted-e2e.sh

# Safer isolated clean rehearsal that does not touch ~/.kortix.
KORTIX_E2E_INSTALL_DIR=/tmp/kortix-gate5-e2e \
E2E_OWNER_EMAIL=gate5-e2e@example.test \
E2E_OWNER_PASSWORD='Gate5E2ePass123!' \
bash tests/e2e/self-hosted-e2e.sh --skip-build

# Existing self-hosted stack only. Requires the matching install .env.
E2E_ENV_FILE="$HOME/.kortix/.env" bash tests/e2e/self-hosted-e2e.sh --browser-only

# Full SPEC section 10.5 golden paths. This creates real users, projects,
# GitHub repos, sessions, and webhook-triggered sessions on the target stack.
# For local/self-host rehearsal, the script imports optional GitHub fallback
# env from the shell or apps/api/.env. Production target runs must use the
# account GitHub App installation path.
GATE5_SELF_HOSTED_EVIDENCE_DIR=test-results/gate5-self-hosted/<timestamp> \
E2E_ENABLE_GOLDEN_PATHS=1 \
E2E_GOLDEN_LOCAL_DOCKER=1 \
E2E_GOLDEN_BACKPRESSURE=1 \
E2E_ENV_FILE="$HOME/.kortix/.env" \
bash tests/e2e/self-hosted-e2e.sh --browser-only
```

When `GATE5_SELF_HOSTED_EVIDENCE_DIR` is set, the self-hosted script writes
`summary.json`, `playwright-report.json`, and `playwright.log`. The final Gate
5 verifier requires this report to carry `evidence_contract_version: 1` and to
prove the local_docker golden path and webhook backpressure ran in the
dev/self-host provider mode.

Target production-like rehearsal:

```sh
# Read-only preflight. This validates target config, health, ops overview,
# response trace headers, managed observability flags, and active legacy state
# without creating users, repos, sessions, or webhooks.
GATE5_PREFLIGHT_ONLY=1 \
E2E_BASE_URL=https://kortix.com \
E2E_API_URL=https://new-api.kortix.com/v1 \
E2E_SUPABASE_URL=https://<supabase-project>.supabase.co \
E2E_DATABASE_URL="$DATABASE_URL" \
E2E_ENV_FILE=/secure/path/to/staging-e2e.env \
ADMIN_TOKEN="$ADMIN_TOKEN" \
E2E_GOLDEN_PROVIDER=daytona \
E2E_REQUIRE_GITHUB_APP=1 \
pnpm --dir tests run test:e2e:gate5:preflight
```

```sh
GATE5_TARGET_CONFIRM=I_UNDERSTAND_THIS_CREATES_TARGET_DATA \
E2E_BASE_URL=https://kortix.com \
E2E_API_URL=https://new-api.kortix.com/v1 \
E2E_SUPABASE_URL=https://<supabase-project>.supabase.co \
E2E_DATABASE_URL="$DATABASE_URL" \
E2E_ENV_FILE=/secure/path/to/staging-e2e.env \
ADMIN_TOKEN="$ADMIN_TOKEN" \
E2E_GOLDEN_PROVIDER=daytona \
E2E_REQUIRE_GITHUB_APP=1 \
E2E_ENFORCE_SLOS=1 \
pnpm --dir tests run test:e2e:gate5:target
```

This wrapper captures `health.json`, `health.headers`, `ops-overview.json`,
`playwright-report.json`, Playwright artifacts for account/project access,
admin ops, and the section 10.5 golden paths, and a `summary.json` under
`test-results/gate5-rehearsal/<timestamp>/`. It fails the Gate 5 target run if
the golden repo was created through the local/self-host PAT fallback, if
managed logging, structured request logging, or OTLP request spans are not
configured, or if active legacy sandboxes remain. Preflight evidence is useful
for fixing target readiness, but it does not satisfy the final Gate 5 verifier
because it records `status: "preflight-passed"` and skips destructive golden
paths.

After the full target rehearsal passes, use the `observability_probe` values in
`summary.json` to verify the same request reached the managed log sink and the
same trace id reached the OTel trace backend. Record both proofs:

```sh
GATE5_OBSERVABILITY_CONFIRM=I_VERIFIED_TARGET_OBSERVABILITY \
GATE5_TARGET_EVIDENCE_DIR=test-results/gate5-rehearsal/<timestamp> \
GATE5_MANAGED_LOG_SINK="Better Stack production source" \
GATE5_MANAGED_LOG_EVIDENCE=$'query-url-or-export.json\nscreenshot-or-log-export.txt' \
GATE5_OTEL_TRACE_SINK="Production OTel trace backend" \
GATE5_OTEL_TRACE_EVIDENCE=$'trace-query-url\ntrace-export.json' \
pnpm --dir tests run test:e2e:gate5:record-observability
```

The final verifier requires `managed-log-proof.json` and
`otel-trace-proof.json` in the target rehearsal evidence directory. Each proof
evidence entry must be either an HTTPS artifact link or a file in the target
evidence directory. Config flags alone are not enough for Gate 5.

Record the section 10.6/10.7 target proof artifacts from the same rehearsal.
Each `*_EVIDENCE` value must point to HTTP(S) evidence or to files in the
target evidence directory:

```sh
GATE5_SLO_CONFIRM=I_VERIFIED_TARGET_SLOS \
GATE5_TARGET_EVIDENCE_DIR=test-results/gate5-rehearsal/<timestamp> \
GATE5_SLO_SESSION_CREATE_P95_MS=740 \
GATE5_SLO_SANDBOX_PROVIDER=daytona \
GATE5_SLO_SANDBOX_ACTIVE_P95_MS=32000 \
GATE5_SLO_PROXY_HEALTH_P95_MS=120 \
GATE5_SLO_LLM_ROUTER_OVERHEAD_MEDIAN_MS=35 \
GATE5_SLO_PROJECTS_FIRST_PAINT_P95_MS=900 \
GATE5_SLO_EVIDENCE=$'slo-dashboard-url\nload-test-export.json' \
pnpm --dir tests run test:e2e:gate5:record-slo
```

```sh
GATE5_CONCURRENCY_CONFIRM=I_VERIFIED_TARGET_CONCURRENCY \
GATE5_TARGET_EVIDENCE_DIR=test-results/gate5-rehearsal/<timestamp> \
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
GATE5_CONCURRENCY_EVIDENCE=$'parallel-session-export.json\ncap-enforcement-output.txt' \
pnpm --dir tests run test:e2e:gate5:record-concurrency
```

```sh
GATE5_NEGATIVE_CONFIRM=I_VERIFIED_TARGET_NEGATIVE_SPACE \
GATE5_TARGET_EVIDENCE_DIR=test-results/gate5-rehearsal/<timestamp> \
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
GATE5_NEGATIVE_EVIDENCE=$'negative-space-export.json\nui-snapshot.txt' \
pnpm --dir tests run test:e2e:gate5:record-negative
```

The final verifier also checks `/v1/ops/overview` for API/tunnel status,
session status, sandbox status/provider counts, trigger/channel queue status,
audit activity, usage rollups, observability flags, and migration health. If
`sessions.errored`, `sandboxes.errored`, or `queues.queued_total` is non-zero,
record `ops-exceptions.json` with one accepted exception for each non-zero
signal:

```sh
GATE5_OPS_EXCEPTIONS_CONFIRM=I_ACCEPT_TARGET_OPS_EXCEPTIONS \
GATE5_TARGET_EVIDENCE_DIR=test-results/gate5-rehearsal/<timestamp> \
GATE5_OPS_EXCEPTION_ITEMS=$'queues.queued_total|Backpressure queue from rehearsal is expected and tracked.|queue-ticket.txt' \
pnpm --dir tests run test:e2e:gate5:record-ops-exceptions
```

Do not promote if any check only passes after manually editing DB rows.

Every `test:e2e:gate5:record-drill` command below requires `E2E_API_URL` to be
a real HTTPS staging/target API URL and `ADMIN_TOKEN` to be set. The recorder
captures `/ops/overview` into each drill directory as
`ops-overview-at-record.json`, and the final verifier rejects drill summaries
without that live ops snapshot.

## 3. Provider Failure

Signals:
- `/v1/ops/overview` shows `sandboxes.errored > 0`.
- Session creation returns provider errors.
- `/v1/p/<external_id>/8000/kortix/health` times out or returns 5xx.

Triage:

```sh
curl -fsS https://new-api.kortix.com/v1/ops/overview -H "Authorization: Bearer $ADMIN_TOKEN" | jq '{sessions, sandboxes}'
```

For a single failing session:
1. Confirm the user still has project/account access.
2. Check `session_sandboxes.provider`, `external_id`, `status`, `metadata.image`, and `metadata.version`.
3. If the provider resource is gone, mark the session as failed and have the user create a new session from the same repo branch. Do not recreate legacy `/instances` rows.

Local Docker provider:

```sh
docker ps -a --filter "label=kortix.session_id=$SESSION_PREFIX"
docker logs "$CONTAINER_ID" --tail 100
docker stop "$CONTAINER_ID"
```

Daytona provider:
- Verify `DAYTONA_API_KEY`, `DAYTONA_SERVER_URL`, `DAYTONA_TARGET`, and `DAYTONA_SNAPSHOT` on the API host.
- If the snapshot is bad, roll forward or back to a known-good snapshot and restart the API so new sessions use the corrected value.
- Existing failed sessions stay as audit history; create new sessions after the provider is healthy.

Record the staged drill after recovery:

```sh
# Store the named files under
# $GATE5_DRILLS_EVIDENCE_DIR/provider-failure/ before final verification,
# or use HTTPS artifact links in GATE5_DRILL_EVIDENCE.
GATE5_DRILL_CONFIRM=I_REHEARSED_THIS_ON_STAGING \
GATE5_DRILL_NAME=provider-failure \
GATE5_DRILL_STATUS=passed \
GATE5_DRILL_SUMMARY="Provider failure surfaced in ops, session recovery path was verified, and no legacy instance rows were created." \
GATE5_DRILL_EVIDENCE=$'ops-before.json\nprovider-error.log\nops-after.json\nrecovery-session-health.json' \
E2E_API_URL=https://new-api.kortix.com/v1 \
ADMIN_TOKEN="$ADMIN_TOKEN" \
pnpm --dir tests run test:e2e:gate5:record-drill
```

## 4. Stripe Failure

Signals:
- Checkout succeeds but billing state does not update.
- Stripe webhooks show delivery failures.
- Account credit/seat state disagrees with Stripe.

Triage:
1. Check Stripe webhook delivery for the event id.
2. Confirm API env has the correct `STRIPE_SECRET_KEY` and webhook secret.
3. Check API logs for the webhook event id and account id.
4. Compare Stripe customer/subscription metadata `account_id` with the canonical Kortix account id.

Recovery:
- Replay failed Stripe webhook events from the Stripe dashboard or CLI after the API is healthy.
- For legacy Stripe metadata mismatches, run the existing reconciliation path instead of editing billing rows by hand:

```sh
pnpm --filter kortix-api exec bun run src/scripts/reconcile-legacy-stripe-billing.ts --account-id "$ACCOUNT_ID"
```

Rollback:
- If a deploy broke billing webhooks, switch API traffic back to the previous blue/green slot or redeploy the previous API image.
- Do not delete credit ledger rows. Add corrective ledger entries through the billing service path so the audit trail remains append-only.

Record the staged drill:

```sh
# Store the named files under
# $GATE5_DRILLS_EVIDENCE_DIR/stripe-failure/ before final verification,
# or use HTTPS artifact links in GATE5_DRILL_EVIDENCE.
GATE5_DRILL_CONFIRM=I_REHEARSED_THIS_ON_STAGING \
GATE5_DRILL_NAME=stripe-failure \
GATE5_DRILL_STATUS=passed \
GATE5_DRILL_SUMMARY="Stripe webhook failure and replay/reconciliation path were verified without manual DB edits." \
GATE5_DRILL_EVIDENCE=$'stripe-event.txt\napi-log-excerpt.txt\naccount-state-before.json\naccount-state-after.json' \
E2E_API_URL=https://new-api.kortix.com/v1 \
ADMIN_TOKEN="$ADMIN_TOKEN" \
pnpm --dir tests run test:e2e:gate5:record-drill
```

## 5. DB Migration Failure

Before migrations:

```sh
supabase migration list
pg_dump "$DATABASE_URL" --format=custom --file "backup-$(date +%Y%m%d-%H%M%S).dump"
```

Apply:

```sh
supabase migration up
```

Verify:

```sh
curl -fsS https://new-api.kortix.com/v1/health
curl -fsS https://new-api.kortix.com/v1/ops/overview -H "Authorization: Bearer $ADMIN_TOKEN" | jq '.migrations'
```

Legacy sandbox migration:

```sh
pnpm --filter kortix-api migration:legacy-sandboxes -- --dry-run --repo-url-template 'https://github.com/<org>/{slug}-{sandbox_id}.git'
pnpm --filter kortix-api migration:legacy-sandboxes -- --apply --repo-url-template 'https://github.com/<org>/{slug}-{sandbox_id}.git'
pnpm --filter kortix-api migration:legacy-sandboxes -- --verify --run-id "$RUN_ID"
```

Rollback legacy migration:

```sh
pnpm --filter kortix-api migration:legacy-sandboxes -- --rollback --run-id "$RUN_ID"
pnpm --filter kortix-api migration:legacy-sandboxes -- --verify --run-id "$RUN_ID"
```

Rollback schema migration:
- Prefer a forward fix migration.
- If data corruption is confirmed and a forward fix is not safe, restore the pre-migration DB backup to a staging database first, validate section 10 golden paths, then schedule the production restore window.

Record both migration drills after staging rehearsal:

```sh
# Store the named files under each drill directory before final verification,
# or use HTTPS artifact links in GATE5_DRILL_EVIDENCE.
GATE5_DRILL_CONFIRM=I_REHEARSED_THIS_ON_STAGING \
GATE5_DRILL_NAME=db-migration-rollback \
GATE5_DRILL_STATUS=passed \
GATE5_DRILL_SUMMARY="Schema migration backup, rollback/restore decision path, and post-rollback health checks were rehearsed on staging." \
GATE5_DRILL_EVIDENCE=$'migration-list-before.txt\nbackup-created.txt\nrollback-notes.md\nops-after.json' \
E2E_API_URL=https://new-api.kortix.com/v1 \
ADMIN_TOKEN="$ADMIN_TOKEN" \
pnpm --dir tests run test:e2e:gate5:record-drill

GATE5_DRILL_CONFIRM=I_REHEARSED_THIS_ON_STAGING \
GATE5_DRILL_NAME=legacy-migration-rollback \
GATE5_DRILL_STATUS=passed \
GATE5_DRILL_SUMMARY="legacy_sandbox_migrations dry-run/apply/verify/rollback/verify completed on staging with rollback evidence." \
GATE5_DRILL_EVIDENCE=$'dry-run.txt\napply.txt\nverify-before-rollback.txt\nrollback.txt\nverify-after-rollback.txt' \
E2E_API_URL=https://new-api.kortix.com/v1 \
ADMIN_TOKEN="$ADMIN_TOKEN" \
pnpm --dir tests run test:e2e:gate5:record-drill
```

## 6. Sandbox Image Rollback

Local/self-host image:

```sh
docker build -f apps/sandbox/Dockerfile -t kortix/sandbox:<sha> .
docker tag kortix/sandbox:<known-good-sha> kortix/sandbox:dev
```

Set the API host to the known-good image for new `local_docker` sessions:

```sh
export KORTIX_LOCAL_DOCKER_IMAGE=kortix/sandbox:<known-good-sha>
pnpm --filter kortix-api dev
```

Cloud/Daytona image:
1. Repoint the Daytona snapshot to the known-good sandbox image.
2. Update `DAYTONA_SNAPSHOT` on the API host.
3. Restart or redeploy the API.
4. Create a new session and verify:

```sh
curl -fsS "https://new-api.kortix.com/v1/projects/$PROJECT_ID/sessions" \
  -H "Authorization: Bearer $USER_TOKEN" \
  -H "Content-Type: application/json" \
  --data '{}'

curl -fsS "https://new-api.kortix.com/v1/p/$EXTERNAL_ID/8000/kortix/health" \
  -H "Authorization: Bearer $USER_TOKEN"
```

Existing sessions keep the image they booted with. Rollback affects new sessions unless the provider resource is destroyed and recreated.

Record the staged drill:

```sh
# Store the named files under
# $GATE5_DRILLS_EVIDENCE_DIR/sandbox-image-rollback/ before final verification,
# or use HTTPS artifact links in GATE5_DRILL_EVIDENCE.
GATE5_DRILL_CONFIRM=I_REHEARSED_THIS_ON_STAGING \
GATE5_DRILL_NAME=sandbox-image-rollback \
GATE5_DRILL_STATUS=passed \
GATE5_DRILL_SUMMARY="Sandbox image rollback was rehearsed, new session booted the known-good image, and daemon health passed." \
GATE5_DRILL_EVIDENCE=$'image-before.txt\nrollback-change.txt\nsession-create.json\ndaemon-health.json' \
E2E_API_URL=https://new-api.kortix.com/v1 \
ADMIN_TOKEN="$ADMIN_TOKEN" \
pnpm --dir tests run test:e2e:gate5:record-drill
```

## 7. API Deploy Rollback

The API host uses blue/green deploys through `scripts/deploy-zero-downtime.sh`.

Normal deploy:

```sh
PREBUILT_IMAGE=kortix/kortix-api:<tag> bash scripts/deploy-zero-downtime.sh
```

The script leaves the previous slot untouched until the standby container passes health and nginx verifies the new upstream. If any step before the traffic swap fails, rollback is automatic.

Manual rollback after a bad deploy:
1. Read the current slot from `~/.kortix-deploy-slot`.
2. Point nginx back to the previous slot port.
3. Reload nginx.
4. Verify `/v1/health` and `/v1/ops/overview`.

```sh
sudo nginx -t
sudo nginx -s reload
curl -fsS https://new-api.kortix.com/v1/health
```

Record the staged drill:

```sh
# Store the named files under
# $GATE5_DRILLS_EVIDENCE_DIR/api-deploy-rollback/ before final verification,
# or use HTTPS artifact links in GATE5_DRILL_EVIDENCE.
GATE5_DRILL_CONFIRM=I_REHEARSED_THIS_ON_STAGING \
GATE5_DRILL_NAME=api-deploy-rollback \
GATE5_DRILL_STATUS=passed \
GATE5_DRILL_SUMMARY="API blue/green rollback was rehearsed and health plus ops overview were clean after traffic returned to the previous slot." \
GATE5_DRILL_EVIDENCE=$'slot-before.txt\ndeploy-output.txt\nrollback-output.txt\nhealth-after.json\nops-after.json' \
E2E_API_URL=https://new-api.kortix.com/v1 \
ADMIN_TOKEN="$ADMIN_TOKEN" \
pnpm --dir tests run test:e2e:gate5:record-drill
```

## 8. Completion Criteria

Gate 5 is complete only when:
- Every section 10.5 golden path passes against the target production-like stack.
- `/admin/ops` is clean in browser validation.
- Provider failure, Stripe failure, DB migration rollback, legacy migration rollback, sandbox image rollback, and API deploy rollback have been rehearsed on staging.
- The exact commands and evidence are attached to the release notes and summarized in `docs/gate5-release-evidence.md`.
- The target rehearsal's observability probe is found in the managed log sink and OTel trace backend, then recorded with `test:e2e:gate5:record-observability`.
- Target SLO, concurrency, and negative-space proof files are recorded with `test:e2e:gate5:record-slo`, `test:e2e:gate5:record-concurrency`, and `test:e2e:gate5:record-negative`.
- `GATE5_LOCAL_EVIDENCE_DIR=... GATE5_SELF_HOSTED_EVIDENCE_DIR=... GATE5_TARGET_EVIDENCE_DIR=... GATE5_DRILLS_EVIDENCE_DIR=... GATE5_RELEASE_MANIFEST=... pnpm --dir tests run test:e2e:gate5:verify-evidence` passes and writes the final release manifest with `status=="complete"` and `release_eligible==true`.
- No release completion run uses `GATE5_ALLOW_SYNTHETIC_EVIDENCE`, `GATE5_ALLOW_INSECURE_TARGET_URLS`, or `GATE5_ALLOW_NON_RELEASE_MANIFEST`; those flags are fixture-only and produce non-release manifests.
