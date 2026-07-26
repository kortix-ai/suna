# API hot-path latency implementation plan

## Phase 1: Baseline

1. Record current dev and production route counts and percentiles.
2. Record ECS and Supabase regions.
3. Trace execution-lease, project-access, model, and session request graphs.

## Phase 2: Execution leases

1. Add failing sandbox reporter tests.
2. Add failing API lease-operation tests.
3. Add the dedicated JSON execution-lease route.
4. Remove API provider touches from renewals.
5. add legacy `turn-stream` compatibility delegation.
6. Remove idle and reconnect discovery.
7. Add single-flight renewal coalescing.
8. Set the heartbeat interval to 60 seconds.
9. Set the lease TTL to 180 seconds.
10. Correct OpenAPI and request-deadline classification.

## Phase 3: Session resume

1. Add a failing authorization side-effect contract test.
2. Remove speculative resume from `loadProjectForUser()`.
3. Delete unused speculative-resume selection and throttle code.
4. Keep explicit session-open allocation unchanged.

## Phase 4: Client readiness

1. Claim each SDK task in `packages/sdk/PROGRESS.md`.
2. Port the preserved initial-session-pin change onto current `main`.
3. Add RED then GREEN SDK tests.
4. Start model-picker and project-detail requests in parallel.
5. Stop gating provider-management loading on runtime provider completion.
6. Update the SDK progress log.

## Phase 5: Verification

1. Run focused API and sandbox daemon tests.
2. Run API and sandbox daemon typechecks.
3. Run SDK typecheck, full suite, and packed-install smoke.
4. Run focused web tests, ESLint, and changed-file type output.
5. Run authenticated local HTTP requests.
6. Run Chromium network and DOM assertions.
7. Compare request counts and latency to the baseline.

## Phase 6: Delivery

1. Rebase on current `origin/main`.
2. Push the branch.
3. Open a PR.
4. Wait for required checks.
5. Merge the PR.
6. Follow Deploy Dev to completion.
7. Prove the deployed API and web artifacts contain the merge SHA.
8. Re-run the deployed API and Chromium checks.

