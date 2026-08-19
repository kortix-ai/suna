# Session Thread Reliability — Design Spec

Date: 2026-08-15
Status: awaiting Jay's review
Scope: `apps/web` session chat, `@kortix/sdk` session runtime, `apps/api` session lifecycle, `apps/kortix-sandbox-agent-server`

## 1. Problem statement (from Jay, 2026-08-15)

1. When a sandbox stops mid-session and the user sends a message, the chat shows repeated "Interrupted" markers and session error banners. The updates repeat and are wrong: nothing the user did was interrupted.
2. Switching sessions in the project header is not instant. Message rendering waits on runtime status even for already-running sessions. A cached transcript must paint immediately.
3. After pressing Stop and sending a new message, the agent answers the stopped prompt.
4. Streamed content sometimes duplicates.
5. Overall: the session thread must be calm and truthful. No random error surfaces. Cover the edge cases beyond the reported ones.

## 2. Root-cause map (verified in code, 2026-08-15)

### 2.1 Phantom "Interrupted" markers

The label is not a backend record. It renders when the last assistant message carries `info.error.name === 'AbortError'` (`apps/web/src/features/session/session-error-banner.tsx:277-286`, mounted from `session-chat.tsx:1490`, `:1197`). Four producers write that error:

1. User Stop (legitimate): `applyOptimisticAbort` (`packages/sdk/src/react/use-session-send.ts:279-304`).
2. Wire `session.error` SSE (`packages/sdk/src/browser/stores/sync-store.ts:1415-1460`).
3. `server.instance.disposed` → `markSessionAbortedLocally` fabricates a synthetic abort onto **every** non-idle session in the tab (`packages/sdk/src/react/use-opencode-events/handle-event.ts:432-440`).
4. Daemon orphan finalizer: on boot/respawn, an assistant turn with no `time.completed` is aborted via `POST /session/:id/abort` (`apps/kortix-sandbox-agent-server/src/main.ts:1016-1023`, `:1339-1350`).

Compounding defects:

- The finalizer's `inspectRoot` never reads `info.error` (`main.ts:1285-1308`), unlike `turn-auto-resume.ts:128-146`. If `/abort` stamps the error without `time.completed`, every subsequent respawn re-aborts the same message → repeated "Interrupted" re-renders.
- Every prompt can dispose/respawn OpenCode: `syncSandboxEnvForPrompt` posts `refreshModels: true` on every prompt (`apps/api/src/projects/lib/sandbox-env-sync.ts:631`); any env delta triggers `opencode.reloadConfig()` (`apps/kortix-sandbox-agent-server/src/routes/env.ts:196-242`). A dispose fires `server.instance.disposed` → producer 3. Post-wake, the env delta is maximal, so the **first send after a wake** is the most likely to fabricate aborts — exactly the reported symptom.
- The UI renders producer 1 and producers 3/4 identically. Infrastructure state is written into transcript content and read back as "the user stopped this".
- Four divergent abort classifiers exist: `turnErrorIsAbort` (identity, correct), `looksLikeAbortText` (prose), `looksLikeAbortError` (duck-typed), `isAbortErrorLike` in `run-outcome.ts:31-36` (loose `/abort/i`).
- "Checkpoint" is a false friend: `<Checkpoint>` is a UI divider primitive (`apps/web/src/components/ai-elements/checkpoint.tsx`); git checkpoints are unrelated. No backend checkpoint entity exists.

### 2.2 Slow session switch

- `/start` is the universal gate. `useQuery(sessionStartKey)` has **no `staleTime`** and re-POSTs on every mount (`packages/sdk/src/react/use-session.ts:691-701`). The OpenCode session id — the key the transcript reads by — normally arrives in that response, so the IndexedDB fast-paint (`use-session-sync.ts:106-127`) inherits the `/start` RTT unless the host passes `initialOpenCodeSessionId`.
- After `/start` resolves, ≥3 serialized React commits run before SSE + reconcile (switch effect → health seed → SSE/network effects).
- `apps/web` `useRuntimeReconnect` calls `resetForServerSwitch()` on first mount, forcing `healthy: null` (`use-runtime-reconnect.ts:170-174`); `markRuntimeReadyVerified()` has zero call sites, so the optimistic fast path is dead code. If `/start` serves from cache, the health-seed effect (deps `[switched]`) fires before the reset and never re-runs — the session then waits on the health poller.
- `setCurrentRuntime` bumps a global version; `resetClient()` clears **every** per-URL client, not just the stale sandbox's (`use-opencode-events/index.ts:93-105`).
- Route-level `fatal` gate: `sandbox.status === 'stopped' | 'error'` replaces the whole chat with a full-screen card (`page.tsx:350`), defeating the SDK's paint-from-disk design. A hibernated session with a complete cached transcript renders a restart card instead of the conversation.
- The cache layers are sound: zustand memory store (last 3 detached sessions), IndexedDB (50 sessions / 7 days), additive merge hydrate. The problem is the gates above them, not a missing cache.

### 2.3 Stopped-prompt replay

- Stop is not a barrier. `cancel()` fires one `session.abort` mutation with swallowed failures (`retry: 2`, `onError: () => {}` — `use-opencode-sessions/messages.ts:560-562`) after the UI has already been set idle optimistically.
- `promptOpenCodeMessage` retries for ~30 s with **no `AbortSignal`** (`messages.ts:469-511`). A prompt still retrying when the user stops lands after the abort and runs the old text.
- `waitForSessionIdle` reads the same store `applyOptimisticAbort` just set to idle (`session-chat.tsx:438-443` vs `:3394-3416`), so it resolves instantly and the next send races the abort.
- Daemon restart replay: `inspectRoot` collapses read failures into `hasMessages: false` (`main.ts:1291,1305-1307`). A cold post-resume OpenCode times out the read → `alreadyDelivered = false` → `KORTIX_INITIAL_PROMPT` is re-delivered into the existing conversation. `waitForRootList` timing out (20 s) creates and pins a brand-new root, orphaning the conversation (`main.ts:1210-1218`).
- Session `/stop` and the reaper never abort the live turn (`stop.ts:16-112`, `stop-box.ts:35-69`); the VM powers off mid-turn, leaving the orphan that triggers the finalizer/replay machinery.
- Prompt dedupe is per-pod, in-memory, 60 s, keyed by body sha256 (`apps/api/src/sandbox-proxy/prompt-dedupe.ts:76-127`): a post-wake retry (wake routinely > 60 s) re-delivers; re-dispatch with the same `clientMessageId` is silently swallowed.

### 2.4 Duplicate streaming

- `applyPartDelta` is `existing + delta` with **no event-id idempotency** (`sync-store.ts:684-700`). One duplicate SSE delivery doubles the text. The prefix-growth guard covers snapshots only.
- Duplicate sources: vendor SSE client retry stacking (guarded only by `sseMaxRetryAttempts: 1`), or a second mounted event-stream subscriber.
- Double user bubble: supersession requires `isDispatched`; `useSession.send()` builds parts with no ids, so `markDispatchedForPartIds` no-ops (`use-session.ts:361-375`, `:996`).
- The `session.error` stub message (`ascendingId('msg')`, sorts below every server id) is never reconciled or removed (`sync-store.ts:1448-1459`).
- `hydrate`'s extras merge keeps SSE-accumulated parts beside re-issued server parts (`sync-store.ts:1068-1090`).

### 2.5 Prior art

PR #6273 (closed, superseded) and PR #6281 (merged 2026-08-08) fixed the parked-sandbox-reads-as-crash class: `derivePhase`, `StopReason`, "Session is waking up" copy are at HEAD. This spec covers the residue. #6273's own "not verified" note stands: the phase-gate wiring seams have no test coverage, and `interrupted-label.test.ts` asserts source text, not behavior.

## 3. Design

### D1 — Interruption is typed, and infra never impersonates the user

- Introduce one SDK abort classification with two identities: `user-abort` (Stop pressed) and `infra-abort` (disposed / orphan-finalized / wake). Producers 3 and 4 must tag their reason; the synthetic client abort (`markSessionAbortedLocally`) and the daemon finalizer both carry it.
- UI: `user-abort` renders the existing "Interrupted" checkpoint row. `infra-abort` renders nothing when the turn later resumes cleanly, or a single calm "Session woke from sleep" row — never an error banner, never repeated.
- Delete the three prose/duck-typed abort sniffs; one exported identity predicate; `run-outcome.ts` reuses it.
- Daemon finalizer becomes idempotent: `inspectRoot` reads `info.error` (as `turn-auto-resume` already does) and never re-aborts an already-errored turn.
- Env-sync stops respawning OpenCode on no-op deltas: `reloadConfig` only when a value materially changed; `refreshModels: true` is not posted unconditionally on every prompt.

### D2 — Cached transcripts paint instantly; runtime status only gates *sending*

- Invariant: rendering a transcript requires only a session id and cached data. Runtime readiness gates the composer and live stream, never the read path.
- `/start` query gets a `staleTime` and a known-ready fast path: returning to a session whose runtime was ready within the window renders immediately and revalidates in the background.
- The OpenCode pin is persisted per Kortix session and used as the paint key before `/start` resolves (the `persistedPin` path becomes load-bearing everywhere, not only when the web list is warm).
- Route-level `fatal` for `stopped` renders transcript + waking affordance when a cached transcript exists; the full-screen card is reserved for truly unrenderable states (404, identity unavailable, no cache).
- Fix the `resetForServerSwitch` ordering hole; scope `resetClient()` to the stale runtime only; collapse the serialized seed commits.

### D3 — Stop is a barrier

- `cancel()` (a) aborts in-flight prompt delivery via `AbortSignal` threaded through `promptOpenCodeMessage`, (b) awaits abort acknowledgment (bounded), (c) surfaces failure instead of `onError: () => {}`.
- `waitForSessionIdle` waits on confirmed idle (server status or abort ack), not the optimistic store write.
- `stopSession` and the reaper call the daemon `/kortix/abort` before `provider.stop()`, closing turns with `time.completed` — removing the orphan class at the source.
- `inspectRoot` returns the tri-state `known` flag already defined in `opencode-turn-state.ts:44-58`; unknown never re-delivers the initial prompt and never creates a new root over an existing conversation.
- Prompt delivery gets stable idempotency across wake: `clientMessageId` semantics defined so a retry is deduped durably and a new send is never swallowed.

### D4 — Streaming is idempotent

- Part deltas carry/respect a sequence identity so duplicate delivery is a no-op.
- `send()` assigns part ids and marks them dispatched — one user bubble.
- The `session.error` stub is reconciled away on hydrate; extras merge dedupes by content identity; bridged parts retire on any real part.

### D5 — The regression harness exists

- Replace `interrupted-label.test.ts` source-text assertions with behavior tests.
- Cover the two wiring seams #6273 shipped unguarded (phase gate in `page.tsx`, SDK `startSettled` staleness).
- e2e flows: park → wake → send (no phantom Interrupted), stop → immediate send (new prompt only), rapid session switching (instant paint from cache).

## 4. Non-goals

- No change to sandbox parking policy, billing activation, or wake-lease mechanics (landed in #6281).
- No adoption of the runtime's native v2 prompt queue in this cycle (documented gap in `core/session/send-queue.ts`; revisit after D3).
- No visual redesign of the chat; only truthful state rendering.

## 5. Success criteria

1. Reopening a parked session and sending a message produces zero "Interrupted" rows and zero error banners; the turn answers the new message. (e2e)
2. Switching between two warm sessions paints the transcript in < 200 ms perceived (from memory/IDB), with no full-screen loader. (browser journey, timing assert)
3. Stop → send within 1 s: the reply addresses only the new prompt; the old prompt never runs. (e2e)
4. Injected duplicate SSE delivery of a part delta produces byte-identical transcript text. (SDK test)
5. Daemon restart over an errored turn: exactly zero re-aborts, zero initial-prompt re-deliveries. (daemon tests)
