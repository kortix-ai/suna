# PR #6957 - code-quality and frontend QA report

**PR:** [kortix-ai/suna#6957](https://github.com/kortix-ai/suna/pull/6957)

**Title:** `fix(session): nine session-runtime defects - stop button, keepalive evidence, history pages, terminal cards, boot flag, agent roster`

**Reviewed original head:** `5c609e689e03f2a93468e32257ac537e7e1f1517`

**Fix commit:** `7cc805c37578d66c50ef9ebed1c76c58ed45eb64`

**Reviewed code head:** `1f86186e6d0c9c526960e9b18834e65395e7d1fc`

**CI repair commit:** `fb372de577`

**Current main:** `6f34da6c51bfd932493dbfb49d81dbe4f10cab1c`

**Reviewed on:** 2026-08-28

**Decision:** **DO NOT MERGE YET**

## Executive result

The original PR head was not safe to ship. Browser testing reproduced a queue integrity failure. The first answer appeared under the second prompt. The second requested answer did not appear.

The new fix commit closes the three confirmed implementation gaps:

1. JAY-720 now preserves the last successful history cursor after a partial page failure.
2. JAY-721 now bounds the first never-settling `/start` request.
3. Active turns now reject inbox admission with `turn_active`. The queue drains one prompt per session.

The same commit also fixes two related frontend correctness gaps:

- Empty assistant records with zero parts and zero tokens no longer create blank turns.
- Queue snapshots now use one freshness gate inside each SDK observation path.

The updated branch has no merge conflict with `main`. GitHub reports `mergeable: true`.

The first final-head CI run found one additional blocker. The sandbox-agent job typechecked imported worker source without installing the worker package dependencies. Commit `fb372de577` adds that package-local install step. The exact typecheck and Linux binary build pass locally.

The branch is still not ready to merge for two reasons:

1. The post-fix browser run proved queue persistence, serialization, and refresh visibility. The cloud runtime then ended with `runtime_gone` before P2 completed automatically.
2. GitHub checks for the new PR head are still running.

No PR merge occurred.

## Review scope

The current PR diff contains:

- 48 changed files.
- 1,428 additions.
- 284 deletions.
- 29 branch commits relative to current `main`.

Evidence sources:

- PR diff, commit history, and GitHub checks.
- Linear project `Session State Protocol`.
- Linear Phase 0 issues JAY-717 through JAY-726.
- Marko's `kortix-critical-streaming-chatux.md`.
- SDK, API, CLI, web, lint, type, and install checks.
- Real Chromium testing against the local frontend and API.
- A real cloud sandbox.
- Database and HTTP observations for queue rows.

The report does not contain the test account password.

## Original-head browser failure

### Queue integrity failed

Test sequence:

1. P1 requested a 30-second tool wait and exact output `FINAL_P1_DONE`.
2. The UI showed the Stop control.
3. P2 requested exact output `FINAL_P2_DONE` while P1 was active.
4. Both lifecycle rows reached terminal states.
5. The browser DOM and lifecycle timestamps were inspected.

Observed timestamps:

| Prompt | Turn started | Turn ended | Duration |
|---|---:|---:|---:|
| P1 | 17:43:26.534 UTC | 17:43:59.945 UTC | 33.411 s |
| P2 | 17:43:38.791 UTC | 17:44:01.254 UTC | 22.463 s |

The turns overlapped for about 21.154 seconds.

Visible result:

- The P2 bubble requested `FINAL_P2_DONE`.
- The response below P2 was `FINAL_P1_DONE`.
- No assistant response contained `FINAL_P2_DONE`.
- The lifecycle layer marked both rows as delivered.

This is a data-attribution failure. It is not a cosmetic ordering problem.

## Fixes implemented

### JAY-720 - partial history retry cursor

Before:

- Partial pages rendered after a later page failed.
- The controller retried from the original cursor.

After:

- The page callback receives the full `SessionSyncPage`.
- Each successful page hydrates messages and commits its cursor.
- The retry starts from the last committed cursor.

Regression proof:

- A failure after cursor 5 now retries with `before=cursor-5`.

### JAY-721 - first never-settling start request

Before:

- The first unresolved `/start` request did not arm the give-up timer.
- The session could remain in `starting` forever.

After:

- `useSessionStartGiveUp` owns the deadline and verdict.
- The first unresolved request arms the deadline.
- Later data or errors clear the timer and verdict.

Regression proof:

- A mounted hook test reaches the bounded give-up verdict for a never-resolving first request.
- A second test proves later success clears the verdict.

### Durable queue serialization

Before:

- A prompt submitted during a live turn could be forwarded immediately.
- Two turns could overlap for one session.

After:

- `sessionHoldsTurnAuthority` refuses admission with `turn_active`.
- The drain sends only one row for each session.
- Sibling rows return to the queue with bounded backoff.
- The engine no longer starts same-session prompt deliveries concurrently.

Regression proof:

- Admission tests cover current and legacy active-turn records.
- Queue tests prove one drain sends only the head row.
- The second row remains queued until the active turn ends.

### Empty assistant turn suppression

The turn grouper now skips a parentless assistant row only when all conditions are true:

- It has zero parts.
- It has exact zero input and output tokens.
- It has no error.

Error stubs remain visible.

### Frontend queue snapshot freshness

`applyInboxObservation` now applies the same observation timestamp to:

- The session working projection.
- Optimistic prompt reconciliation.
- The React Query cache result.

An older empty snapshot cannot erase a newer queue row. A newer empty snapshot can remove it.

### Timing test determinism

The prior CI failure depended on wall-clock subtraction. `splitTimingDurations` now owns deterministic duration splitting. Its tests cover normal subtraction and crossed rounded clocks.

## Post-fix browser evidence

Test target:

- Frontend: `http://localhost:15300`
- API: `http://localhost:15308`
- Auth: supplied account, omitted from this report
- Project: `d4914405-5405-451e-b5a4-208b4ad2d854`
- Session: `04bf02de-c7d5-40f0-b5cd-61c3b6df0c1c`

Sequence:

1. P1 requested a 20-second wait and exact output `FIRST_OK_0828`.
2. P2 requested exact output `SECOND_OK_0828` while P1 was active.
3. Both `POST /prompts` calls returned HTTP 202.
4. `GET /prompts` retained P2 with reason `turn_active` and attempts `0`.
5. A browser refresh preserved P1 and P2.
6. The queued P2 row remained visible with the `Remove from queue` control.

Verified:

- No same-session overlap occurred during the observed window.
- P2 remained in the durable queue.
- The frontend displayed P2 as queued.
- Refresh did not erase the queue row.
- The Stop control did not replace queue visibility.

Not verified:

- The runtime ended with `runtime_gone`.
- P1 was requeued with `redelivered after runtime_gone`.
- P2 remained waiting.
- The run did not prove automatic P2 completion and parent-to-answer attribution.

## Automated verification

| Surface | Result |
|---|---:|
| Focused SDK regression files | 71 pass, 0 fail |
| Mounted start give-up hook | 2 pass, 0 fail |
| Full SDK package suite before main sync | Pass |
| Full SDK package suite after main sync | Pass |
| SDK typecheck after main sync | Exit 0 |
| SDK packed install smoke | Exit 0 |
| Focused API queue and timing files after main sync | 38 pass, 0 fail |
| Sandbox agent typecheck after CI repair | Exit 0 |
| Sandbox agent Linux binary build after CI repair | Exit 0 |
| Full API suite before main sync | 8,748 pass, 79 skip, 0 fail |
| Full web suite before main sync | 8,648 pass, 0 fail |
| Standalone CLI suite before main sync | 1,243 pass, 0 fail |
| Changed-file ESLint | 0 errors, 32 warnings |
| `git diff --check` | Clean |

The root `pnpm test -- --packages-only` run failed in its concurrent CLI sub-lane without useful output. The same CLI suite passed standalone with 1,243 tests. Treat the root package lane as unresolved until CI completes.

The web `tsc --noEmit` command exits 2 with 17 test typing errors in four unchanged files:

- `app/(system)/api/og/template/template-url.test.ts`
- `features/file-viewer/preview-fit.test.tsx`
- `features/session/action-panel/easy/easy-panel-logic.test.ts`
- `features/session/action-panel/snapshots-tab.test.tsx`

The repository instructions describe about 15 errors in three files. The baseline has drifted. No changed PR file appears in this output.

## Linear issue verification

| Issue | Result after fixes | Status |
|---|---|---|
| JAY-717 | Retryable provider errors remain non-idle in unit coverage. Real provider retry not induced. | Partial |
| JAY-718 | Stop remains visible during a long turn. Provider retry not induced. | Mostly verified |
| JAY-719 | Keepalive no longer counts as runtime process evidence. | Verified by tests |
| JAY-720 | Partial pages commit and retry resumes from the last cursor. | Fixed and verified |
| JAY-721 | First unresolved start request reaches the bounded give-up verdict. | Fixed and verified |
| JAY-722 | Active provisioning does not paint a terminal card. | Browser verified |
| JAY-723 | Initial poison flag clears after daemon success. Real poison sequence not induced. | Partial |
| JAY-724 | Browser can read `X-Kortix-Boot-Phase`. | Browser verified |
| JAY-725 | Agent roster cache keys include the prompt directory. Custom directory browser run not performed. | Partial |
| JAY-726 | Empty zero-token assistant rows are removed. Error stubs remain. | Fixed by tests |
| JAY-291 | Legacy queue now serializes one prompt per session. Protocol v2 migration remains. | Improved, not complete |

All PR-related issues remain `In Progress`. Repository policy allows `Done` only after merge, dev deployment, and dev verification.

## Marko critical-issue mapping

Marko's report lists 16 critical streaming and chat UX incidents.

| Marko item | Covered by | Current assessment |
|---|---|---|
| 1-3: unacceptable streaming, mid-turn death, silent death | JAY-430 and its blockers; JAY-566; JAY-723 | Not closed by this PR |
| 4: 140 MB history serialization and OOM | JAY-686, JAY-689, JAY-351 | Not closed by this PR |
| 5: UI slower than terminal | JAY-697 and Session State Protocol performance phases | Not closed by this PR |
| 6: agent and stream architecture | Session State Protocol phases 1-4 | Phase 0 only |
| 7-10: queue and reconnection errors | JAY-291, JAY-572, JAY-726, current fix | Serialization improved; full browser completion still needed |
| 11: dashboard resumes the previous warm session | JAY-596 | Not closed by this PR |
| 12: slow session resume | JAY-697 | Not closed by this PR |
| 13: failed-session redirect softlock | JAY-729 | New urgent ticket |
| 14-15: stop/restart state and bricked sessions | JAY-430, JAY-566, JAY-723 | Not closed by this PR |
| 16: unexplained terminal incident | Requires incident-specific evidence | Not proven fixed |

The PR is Phase 0 symptom relief. It is not the final Session State Protocol architecture.

## New Linear tickets

### JAY-728 - one freshness clock for queue snapshots

Risk:

- POST, GET, bundle, and stream observations can still use clocks created at different layers.
- A correct local gate does not prove cross-transport ordering.

Required proof:

- One server-defined ordering value or monotonic revision.
- Tests where stale POST, GET, bundle, and stream responses arrive in every order.

### JAY-729 - failed-session redirect escape

Risk:

- A failed session can repeatedly auto-redirect the user back to the same broken route.

Required proof:

- A deterministic failed-session browser journey.
- A visible escape action.
- No automatic redirect loop after the user leaves.

## Thermo-nuclear code-quality findings

### Correct improvements

- `useSessionStartGiveUp` isolates timing state from the 1,500-line session hook.
- Queue freshness now passes through one helper per observation.
- The false stream-attached polling mode was removed.
- `terminal-card-gate.ts` now accepts the SDK's `SessionStartStage` type.
- Reconciler comments now match the four subsystem reads and actual polling behavior.

### Remaining maintainability debt

Large production files remain:

| File | Lines |
|---|---:|
| `apps/web/src/features/session/session-chat.tsx` | 5,433 |
| daemon `main.ts` | 3,234 |
| SDK `sync-store.ts` | 2,723 |
| lifecycle `engine.ts` | 2,244 |
| SDK `use-session.ts` | 1,521 |
| session route `page.tsx` | 1,417 |

No PR file crossed from under 1,000 lines to over 1,000 lines. The PR does not create this debt. Phase 2 must remove duplicate state derivation from these hosts.

Several tests still assert source text. Mounted behavior tests provide stronger proof. New critical state work must prefer mounted or black-box behavior.

The unrelated `globals.css` text-blur removal expands the review surface. Move it to a separate PR before merge unless it is a documented dependency.

## Final shipping gate

Do not merge PR #6957 until all items pass:

1. GitHub checks pass for the final PR head after the report commit.
2. A stable real sandbox completes P1 and P2 automatically.
3. The DOM contains both exact assistant outputs under the correct parent prompts.
4. Lifecycle timestamps prove no same-session overlap.
5. Refresh during P1 preserves P2 and later drains it.
6. JAY-728 and JAY-729 remain tracked until their acceptance tests pass.
7. Merge, deploy to dev, verify the deployed SHA, then mark PR issues `Done`.

Current confidence:

- **Code-level confidence:** High for JAY-720, JAY-721, queue serialization, empty assistant suppression, and local queue freshness.
- **User-flow confidence:** Medium. Persistence and visibility passed. Automatic second-prompt completion did not finish because the runtime disappeared.
- **Ship confidence:** Not yet. CI and one stable two-prompt browser completion remain.
