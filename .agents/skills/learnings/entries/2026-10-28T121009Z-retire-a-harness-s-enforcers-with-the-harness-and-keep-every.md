---
recorded: 2026-10-28T12:10:09Z
incident_date: 2026-10-28
---
# Retire a harness's enforcers with the harness, and keep every guard the shared path still runs

**Rule:** When a harness is sunset, delete the tests that exercise only that harness: its process, its config, its storage, and symbols marked `@deprecated` for it. Keep a test whose subject the API or the other harness still calls, even when that subject carries the sunset marker. Before you delete a test, find every production caller of its subject. Example: `legacyRehydrateSpec` is marked OpenCode-only, but every session open and restart calls it, and its test is the cross-project archive guard that `tests/spec/end-to-end.md` SCOPE-3 cites. That test stays.

**Trigger surface:** Deleting tests during the OpenCode sunset, or for any later harness or provider sunset (Daytona).

**Incident:** 2026-10-28, PR #10999. 82 OpenCode-only test files and 233 OpenCode-only tests in 35 mixed files were deleted: 497.4 s of summed CI test time, of which 492.5 s was kortixd (81 % of that lane's 608.7 s). The first inventory also marked two security guards as OpenCode-only; a caller check kept both. `unit-legacy-rehydrate.test.ts` keeps its 5 cross-project archive cases. `tool-host.test.ts` keeps the `POST /kortix/tools/:name` auth cases (401, 403, 404) and the owner-only tool-bridge key, because `src/app/server.ts` mounts that route for every harness. The enforcers named in the entries below no longer exist. The OpenCode-only parts of these rules have no enforcer until OpenCode is deleted. Where a rule also binds pi, the pi test named in that entry, or the harness-agnostic contract test, enforces it.

- `2026-08-14T171525Z-two-proxy-layers-must-agree-on-which-upstream-calls-legitima.md`
- `2026-08-17T031949Z-a-persisted-user-message-is-not-proof-that-its-opencode-turn.md`
- `2026-08-19T143259Z-a-picker-that-offers-a-model-the-runtime-does-not-know-is-a.md`
- `2026-08-20T133711Z-transcript-shape-alone-may-never-end-a-turn-and-every-turn-n.md`
- `2026-08-24T042438Z-a-transcript-list-must-never-carry-attachment-bytes.md`
- `2026-08-25T184146Z-a-boot-budget-measures-lack-of-progress-not-wall-clock.md`
- `2026-08-25T184146Z-a-refresh-never-converges-a-booting-runtime-a-stub-launcher.md`
- `2026-08-25T184146Z-the-daemon-owns-the-opencode-binary-opencode-must-never-upgr.md`
- `2026-08-25T215118Z-every-blocking-opencode-endpoint-must-be-exempted-in-both-pr.md`
- `2026-08-25T233332Z-a-turn-probe-never-lists-the-whole-root-the-list-is-unbounde.md`
- `2026-08-26T001920Z-image-bytes-never-live-in-the-transcript-memory-is-guarded-b.md`
- `2026-09-17T001634Z-queue-placement-controls-when-the-active-response-ends.md`
- `2026-09-17T001634Z-reconstruct-opencode-identities-from-sqlite-columns.md`
- `2026-09-21T124434Z-a-turn-that-died-must-say-why-a-stop-somebody-asked-for-is-t.md`
- `2026-09-25T143826Z-one-stop-during-a-fresh-runtime-s-first-turn-broke-every-lat.md`
- `2026-09-25T171126Z-the-platform-never-writes-a-session-s-tracked-working-tree.md`
- `2026-09-25T223918Z-a-daemon-test-file-that-writes-a-module-level-singleton-clea.md`
- `2026-09-25T224724Z-run-the-package-lane-after-managed-model-routing-or-pricing.md`
- `2026-09-25T230036Z-reset-shared-release-state-before-tests-that-assume-workspac.md`
- `2026-09-25T234308Z-re-check-a-precondition-at-the-moment-it-becomes-irreversibl.md`
- `2026-09-26T211241Z-a-config-release-tool-file-s-shape-is-unverified-until-a-boo.md`
- `2026-09-27T024842Z-every-harness-retries-a-transient-model-error-inside-the-tur.md`
- `2026-09-28T235231Z-curate-modalities-and-reasoning-options-for-every-managed-mo.md`
- `2026-09-29T233534Z-resolve-a-session-s-opencode-root-from-the-control-plane-s-p.md`
- `2026-09-30T001835Z-a-runtime-restart-must-never-kill-an-accepted-turn-and-every.md`
- `2026-09-30T122816Z-in-gateway-mode-route-every-model-ref-opencode-reads-from-th.md`
- `2026-09-30T171738Z-when-a-mechanism-moves-behind-a-flag-keep-the-flag-off-path.md`
- `2026-09-30T175151Z-a-guard-over-a-directory-the-platform-also-writes-must-judge.md`
- `2026-09-30T180907Z-answer-an-upstream-rejection-that-arrives-before-any-output.md`
- `2026-09-30T194126Z-deliver-a-managed-model-field-change-through-the-daemon-or-t.md`
- `2026-10-02T183620Z-register-every-model-a-sandbox-is-told-to-use-the-gateway-de.md`
- `2026-10-05T144244Z-never-let-a-config-release-the-api-cannot-build-replace-a-se.md`
- `2026-10-07T125734Z-never-persist-a-value-that-names-a-listener-the-writing-proc.md`
- `2026-10-08T224239Z-bring-the-base-config-dir-into-the-checkout-on-every-reload.md`
- `2026-10-09T141548Z-never-let-a-config-release-the-api-cannot-build-replace-a-se.md`
- `2026-10-10T174107Z-a-prompt-that-must-reach-a-running-turn-is-an-inbox-row-that.md`
- `2026-10-10T214735Z-guard-the-opencode-boot-root-s-claimed-pin-fallback-with-a-t.md`
- `2026-10-14T221844Z-ship-every-file-the-compiled-governance-makes-an-agent-load.md`
- `2026-10-16T001819Z-prove-a-harness-config-change-in-a-real-session-on-both-harn.md`
- `2026-10-22T184919Z-serve-every-model-its-real-limits-never-cap-a-window-or-a-co.md`
- `2026-10-22T234312Z-a-deployed-smoke-failure-that-repeats-on-its-rerun-is-a-regr.md`

**Enforcement:** none yet: a caller check before a test deletion is a review step. `kortix-namespace-auth-boundary.test.ts` still requires a credential check in every `/kortix/*` route file, including the OpenCode-only catalog route.
