# Session Thread Reliability — Implementation Plan

Date: 2026-08-15
Spec: `docs/superpowers/specs/2026-08-15-session-thread-reliability-design.md`
Execution model: sub-agent driven; one worktree per phase branch; every task lands with failing-test-first where it touches `packages/sdk` (TDD mandatory there).
Delivery per repo standard: branch → PR → merge to main → Deploy Dev → verify on dev.

Ordering rationale: Phase 1 removes the false-error producers (highest annoyance, lowest risk). Phase 3 depends on nothing in Phase 2; Phases 2 and 3 can run in parallel worktrees. Phase 4 is SDK-internal. Phase 5 closes with the harness and dev verification.

---

## Phase 1 — Truthful interruption (M1)

### T1. Daemon orphan finalizer becomes idempotent
- Files: `apps/kortix-sandbox-agent-server/src/main.ts` (`inspectRoot` :1285-1308, `confirmTurnOrphaned` :1320-1337), reference `turn-auto-resume.ts:128-146`.
- Change: `inspectRoot` reads `info.error`; a turn already carrying an abort/error is finalized (not re-aborted). Same guard in `finalizeAfterReplacement` (`opencode.ts:1569-1583`).
- Verify (proposed): daemon unit test — boot twice over a turn with `info.error` set and `time.completed` absent → exactly one `/abort` total.

### T2. Infra aborts are typed and never render as user "Interrupted"
- Files: `packages/sdk/src/react/use-opencode-events/handle-event.ts:432-440`, `use-event-stream-refs.ts:113-135`, `browser/stores/sync-store.ts:1415-1460`; `apps/web/src/features/session/session-error-banner.tsx`; daemon abort call sites (tag reason).
- Change: abort error carries `data.reason: 'user' | 'runtime-disposed' | 'orphan-finalized' | 'wake'`. Banner renders the Interrupted checkpoint only for `user`; infra reasons render nothing (or one calm resume row when the turn was genuinely cut).
- Verify (proposed): SDK test — `server.instance.disposed` marks sessions with `reason: 'runtime-disposed'`; web test — that error renders no Interrupted row; user Stop still renders it.

### T3. Env sync stops respawning OpenCode on every prompt
- Files: `apps/api/src/projects/lib/sandbox-env-sync.ts:631`, `apps/api/src/sandbox-proxy/pre-prompt-env-sync.ts:121-129,312-324`, `apps/kortix-sandbox-agent-server/src/routes/env.ts:196-242`.
- Change: `refreshModels` posts only when model-relevant values changed; `reloadConfig` only on material delta (defined allowlist), never on echo of identical values.
- Verify (proposed): daemon test — two identical env posts → zero reloads; api test — second prompt with unchanged env posts no `refreshModels`.

### T4. One abort classifier
- Files: new `packages/sdk` export (identity predicate + reason accessor); delete/redirect `looksLikeAbortText` (`session-error-banner.tsx:42-85`), `looksLikeAbortError` (`use-opencode-events/helpers.ts:44-54`), `isAbortErrorLike` (`action-panel/shared/run-outcome.ts:31-36`).
- Note: SDK export addition = three synchronized edits per `packages/sdk/AGENTS.md`.
- Verify (proposed): `pnpm test -- --sdk-only` + web unit tests; grep proves the prose sniffs are gone.

## Phase 2 — Instant session switch (M2)

### T5. `/start` gets staleTime + known-ready fast path
- Files: `packages/sdk/src/react/use-session.ts:691-701` (+ `sessionStartKey`), `core/rest/projects-client/session-sandbox.ts`.
- Change: cached ready `/start` result within window renders immediately, background revalidate; no unconditional re-POST per mount.
- Verify (proposed): SDK test — remount within window issues zero network `/start` before first paint.

### T6. Transcript paints from persisted pin before `/start`
- Files: `packages/sdk/src/react/initial-session-pin.ts`, `use-session.ts:811-835`, `use-session-sync.ts:106-127`; `apps/web` `page.tsx:195,209`.
- Change: persisted OpenCode pin per Kortix session is the paint key; IDB/memory paint runs independent of `/start` resolution in all hosts.
- Verify (proposed): SDK test — with persisted pin and warm IDB, messages present while `/start` is still pending.

### T7. Stopped sandbox with cached transcript renders the conversation
- Files: `apps/web/src/app/(app)/projects/[id]/sessions/[sessionId]/page.tsx:348-432,473+`, `session-load-state.ts`, `session-terminal-state.ts`.
- Change: `fatal` full-screen card only when no cached transcript; otherwise transcript + waking affordance; composer gated, read path not.
- Verify (proposed): web test — `sandbox.status: 'stopped'` + cached messages → transcript rendered, no restart card.

### T8. Kill the readiness reset races and global client wipe
- Files: `packages/sdk/src/react/use-runtime-reconnect.ts:170-174`, `use-opencode-events/index.ts:93-105`, `core/runtime/client.ts:141-143`, `core/session/current-runtime.ts:55-64`.
- Change: `resetForServerSwitch` cannot undo a later health seed (ordering made explicit); `resetClient` scoped to the replaced runtime URL; remove dead `markRuntimeReadyVerified` or make it load-bearing.
- Verify (proposed): SDK tests for both orderings (cache-hit start, network start); no cross-runtime client eviction.

## Phase 3 — Stop is a barrier (M3)

### T9. `cancel()` cancels in-flight delivery and awaits the abort
- Files: `packages/sdk/src/react/use-session.ts:1051-1059`, `use-opencode-sessions/messages.ts:469-511,536-564`, `use-session-send.ts:279-304,572-576`.
- Change: `AbortSignal` through `promptOpenCodeMessage`; `cancel()` resolves on abort ack or bounded timeout; failures surface (no `onError: () => {}`).
- Verify (proposed): SDK test — prompt mid-retry + cancel → prompt never delivered; abort failure propagates.

### T10. `waitForSessionIdle` waits on confirmed idle
- Files: `apps/web/src/features/session/session-chat.tsx:438-443,3394-3446`; SDK primitive for "abort settled".
- Change: stop→send-now sequences on the ack from T9, not the optimistic store flip.
- Verify (proposed): web test — stop then immediate send: send dispatches only after abort settles.

### T11. Server-side stop closes the turn first
- Files: `apps/api/src/projects/session-lifecycle/stop.ts:79`, `apps/api/src/projects/reaping/stop-box.ts:50`, daemon `routes/abort.ts`.
- Change: best-effort daemon `/kortix/abort` (bounded) before `provider.stop()`; stop proceeds regardless of abort outcome.
- Verify (proposed): api test — stop on busy session issues abort first; timeout still stops the box.

### T12. Daemon boot never replays the initial prompt
- Files: `apps/kortix-sandbox-agent-server/src/main.ts:1008-1075,1185-1218,1291-1307`, `opencode-turn-state.ts:44-58`.
- Change: `inspectRoot` returns tri-state (`known`); unknown → no initial-prompt delivery, no new root; `waitForRootList` timeout paths re-check before pinning a fresh root.
- Verify (proposed): daemon tests — read timeout on cold boot → zero deliveries; existing root never orphaned.

### T13. Durable prompt idempotency across wake
- Files: `apps/api/src/sandbox-proxy/prompt-dedupe.ts`, `packages/sdk` `messages.ts:206-240` (clientMessageId semantics), `session-lifecycle/deliver.ts:28-64`, `engine.ts:599-611`.
- Change: retries of one logical send dedupe durably past 60 s/pod boundaries; a genuinely new send is never swallowed; accepted-but-unacked deliveries are not re-posted blind.
- Verify (proposed): api/SDK tests — same clientMessageId retry post-wake → one delivery; new id → delivered.

## Phase 4 — Idempotent streaming (M4)

### T14. Part-delta idempotency
- Files: `packages/sdk/src/browser/stores/sync-store.ts:684-700`, `core/stream/event-stream.ts:170-188,326-350`.
- Change: sequence identity on delta application (duplicate delivery = no-op); single-live-stream invariant asserted.
- Verify (proposed): SDK test — replay identical delta stream twice → byte-identical text.

### T15. One user bubble
- Files: `packages/sdk/src/react/use-session.ts:361-375,996`, `use-session-send.ts:96-101`.
- Change: `send()` assigns part ids and marks dispatched; supersession works for the plain-text path.
- Verify (proposed): SDK test — optimistic send + server echo → one user message.

### T16. Stub and merge hygiene
- Files: `sync-store.ts:1448-1459` (error stub), `:1068-1090` (extras merge), `:587-603` (bridge retirement).
- Change: stub reconciled away on hydrate; extras dedupe by content identity; bridges retire on any real part.
- Verify (proposed): SDK tests for each of the three.

## Phase 5 — Regression harness + dev proof (M5)

### T17. Behavior tests replace source-text assertions
- Files: `apps/web/src/features/session/interrupted-label.test.ts` (replace), new render tests for the page phase gate; SDK `use-session-phase` staleness seam.
- Verify (proposed): reverting T2's host gate or the phase wiring turns tests red (mutation check by hand).

### T18. End-to-end flows + dev verification
- Files: `tests/spec/end-to-end.md` + `tests/src/flows/*` (park→wake→send, stop→send, rapid switch), route manifest regenerated if routes change.
- Verify (proposed): `pnpm test` green locally; after merge + Deploy Dev, the three journeys pass against dev.kortix.com; deployed SHA confirmed.

---

## Dependencies

- T2 depends on T4 (classifier ships first or same PR).
- T10 depends on T9. T12 is independent of T9-T11. T17 depends on T2/T7.
- Phases 2 and 3 parallelizable in separate worktrees; Phase 4 parallel with either.

## Risks

- T3 (env-sync allowlist) risks under-reloading: a material config change must still respawn. Mitigate with an explicit allowlist test enumerating every env key the daemon consumes.
- T13 touches delivery semantics used by Slack/channels; flows in `tests/src/flows` covering channels must stay green.
- T7 changes a terminal-state UX that #6281 just reworked; keep `StopReason`-driven copy intact.
