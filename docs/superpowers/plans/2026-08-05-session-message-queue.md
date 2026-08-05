# Session message queue — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: use `superpowers:executing-plans` or
> `superpowers:subagent-driven-development` to implement task-by-task. Steps use
> checkbox (`- [ ]`) syntax. TDD is mandatory for every task that changes
> behaviour: failing test first, watch it fail, then implement.

**Goal:** A message queued while the agent is running is released exactly once,
only when the turn genuinely ends, one message per turn — and the user can see
the queue and edit, reorder, remove, or stop-and-send any item.

**Architecture:** Pure queue transitions move into `@kortix/sdk`
(`core/session/message-queue.ts`, framework-free, isomorphic tier). `apps/web`
keeps three thin layers over it: a persisted zustand store, a drain hook that
owns boundary detection, and the composer UI. The tool-completion trigger and
the `isBusy` trigger are deleted outright.

**Tech stack:** Next.js 16, React 19, zustand, motion/react, Tailwind v4,
`@phosphor-icons/react`, `bun:test`.

**Spec:** `docs/superpowers/specs/2026-08-05-session-message-queue-design.md`

## Global constraints

- Icons are Phosphor. Lucide names do not exist in this repo.
- Loading is `<Loading />` only — never a spinning icon.
- Never animate `width`/`height`/`margin`. Transform and opacity only.
  Enter/exit easing is ease-out; exit runs ~75–80% of enter.
- No new dependencies. Reorder uses the existing motion primitives plus keyboard
  handlers — no drag-and-drop library.
- `packages/sdk` rules apply to task 1 and task 2: failing test first, exported
  names are a public API contract, never touch the `version` field, adding an
  export requires three synchronized edits.
- Verification is by `bun test` / `tsc --noEmit` / `eslint`. No browser driving,
  no stack boot.
- The word for the concept is **queue**; an item is a **queued message**. Do not
  introduce "pending message", "followup", or "draft" as synonyms.

---

## File structure

| File | Responsibility |
|---|---|
| **new** `packages/sdk/src/core/session/message-queue.ts` | pure transitions over `SessionQueue`; no React, no storage, no timers |
| **new** `packages/sdk/src/core/session/message-queue.test.ts` | the invariants, as unit tests |
| `packages/sdk/package.json` | `exports` + `publishConfig.exports` for `./message-queue` |
| `packages/sdk/src/index.isomorphic.test.ts` | `SUBPATH_TIERS` entry, `isomorphic-core` |
| `packages/sdk/src/core/session/send-queue.ts` | doc note: superseded for host use |
| **new** `apps/web/src/stores/message-queue-store.ts` | zustand + `localStorage`, per-session, over the SDK reducer |
| **new** `apps/web/src/features/session/use-message-queue-drain.ts` | boundary detection, settle window, dispatch |
| **new** `apps/web/src/features/session/composer/queued-messages.tsx` | the queue list UI |
| `apps/web/src/features/session/session-chat.tsx` | delete the inline queue + tool/`isBusy` drain; wire the hook; pass enqueue-time overrides |
| `apps/web/src/features/session/session-chat-input.tsx` | replace the chip row with the list; new props |
| `apps/web/src/features/session/composer-chat-input.tsx` | pass-through props |
| `apps/web/src/features/session/instant-session-shell.tsx` | write to the per-session queue |
| `apps/web/src/stores/session-composer-handoff-store.ts` | delete `usePendingQueueStore` (keep `usePendingFilesStore`) |

---

## Phase 1 — Core queue

### Task 1: Pure queue transitions in the SDK

**Files:** new `packages/sdk/src/core/session/message-queue.ts`; new
`packages/sdk/src/core/session/message-queue.test.ts`

**Produces:** `QueuedMessage`, `SessionQueue`, `createSessionQueue()`,
`enqueue()`, `claimNext()`, `completeInFlight()`, `failInFlight()`,
`retryFailed()`, `removeQueued()`, `editQueued()`, `reorderQueued()`.

- [ ] **Step 1: Failing tests.** The invariants, each named for the root cause it
      closes:
      - `claimNext` returns the head and sets `inFlightId` in one transition;
        a second `claimNext` on the returned state returns `undefined` (RC5).
      - `enqueue` while `inFlightId` is set appends to the tail, never the head.
      - `failInFlight` moves the item to `failed`, clears `inFlightId`, and
        leaves `pending` drainable — a failed item never blocks the tail (RC6,
        and the lockout that deleted the queue in `67749c1f76`).
      - `retryFailed` moves an item from `failed` to the **tail** of `pending`.
      - `reorderQueued` cannot move an item into or past the in-flight slot.
      - `editQueued` on a non-existent id is a no-op returning the same
        reference.
      - `enqueue` preserves `agent` / `model` / `variant` verbatim (RC8).
      - Every transition is pure: the input state object is not mutated.
- [ ] **Step 2: Run** `bun test src/core/session/message-queue.test.ts` → FAIL,
      module not found.
- [ ] **Step 3: Implement.** Plain functions, `(state, args) => state`. No
      `Date.now()` inside — `createdAt` is passed in, so tests are
      deterministic. No `crypto` global — ids are passed in.
- [ ] **Step 4: Run** → PASS.

### Task 2: Export the module

**Files:** `packages/sdk/package.json`; `packages/sdk/src/index.isomorphic.test.ts`;
`packages/sdk/src/core/session/send-queue.ts`

- [ ] **Step 1:** Add `./message-queue` to `exports` as `./src/core/session/message-queue.ts`.
- [ ] **Step 2:** Add the matching `publishConfig.exports` entry (`types` + `import`).
- [ ] **Step 3:** Add the `SUBPATH_TIERS` row, tier `isomorphic-core`.
- [ ] **Step 4:** Add a doc note to `send-queue.ts` — it stays exported and
      tested (public API), and is superseded by `message-queue.ts` for host use.
- [ ] **Step 5: Run** `pnpm --filter @kortix/sdk test` → the tripwire and
      `package-exports.test.ts` pass; check the count against the baseline.

### Task 3: Persisted per-session store

**Files:** new `apps/web/src/stores/message-queue-store.ts`; new
`apps/web/src/stores/message-queue-store.test.ts`

**Produces:** `useMessageQueueStore` with `enqueue`, `remove`, `edit`,
`reorder`, `claimNext`, `complete`, `fail`, `retry`, `clearSession`,
`getSessionQueue(sessionId)`, `hydrate()`.

- [ ] **Step 1: Failing tests.**
      - Queues are isolated per `sessionId`; enqueueing to A never appears in B
        (RC7).
      - `enqueue` → reload (re-run `hydrate` against the same `localStorage`) →
        the text, `agent`, `model`, `variant`, and order are restored.
      - An item with attachments rehydrates with `hadAttachments > 0` and no
        `files` — the UI can say so instead of silently dropping them.
      - A `v2` payload under the old key is ignored, not migrated.
      - A corrupt / non-array payload hydrates to an empty queue, not a throw.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.** zustand over the task-1 reducer. Key
      `kortix_message_queue_v3`. Writes are debounced and wrapped in
      `try/catch` — a full or blocked `localStorage` must never break sending.
      Guard `typeof window`.
- [ ] **Step 4: Run** → PASS.

**Note the store test footgun:** `apps/web` runs `bun test` without `--isolate`,
so zustand module state is shared across files in a run. Reset the store in
`beforeEach`, and spread the real module in any `mock.module`.

---

## Phase 2 — Drain

### Task 4: The drain hook

**Files:** new `apps/web/src/features/session/use-message-queue-drain.ts`; new
`apps/web/src/features/session/message-queue-boundary.ts`; new
`apps/web/src/features/session/message-queue-boundary.test.ts`

**Produces:** `canDrainQueue(gates): boolean` (pure, in `message-queue-boundary.ts`)
and `useMessageQueueDrain({ sessionId, gates, send })`.

- [ ] **Step 1: Failing tests** against the pure `canDrainQueue`:
      - `false` while `isServerBusy` (RC2 — the debounced `isBusy` is not an
        input at all; assert the gate object has no such field).
      - `false` while `pendingSendInFlight`, `isOptimisticCompacting`, or
        `hasIncompleteAssistant`.
      - `false` while `hasActiveQuestion`, `hasPendingApproval`, or
        `pendingPermissions.length > 0` — draining into a question would answer
        it with unrelated text; draining past an approval would bypass the gate.
      - `true` only when every gate is clear.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement `canDrainQueue`.** → PASS.
- [ ] **Step 4: Implement the hook.**
      - Requires an observed `busy → idle` **transition** since the last
        dispatch, not a level.
      - Arms a `QUEUE_SETTLE_MS = 700` timer when `canDrainQueue` first goes
        true; cancels it if any gate re-closes. Only a continuously-clear window
        dispatches.
      - Dispatch: `claimNext()` (synchronous claim), then `send()` with the
        item's captured `agent`/`model`/`variant`, then `complete()` or
        `fail()`.
      - **Does not depend on `messages`** (RC1, RC3) — assert this by the
        dependency array in review.
- [ ] **Step 5:** Delete `seenCompletedToolIdsRef`, `wasBusyForDrainRef`, and
      the whole tool-boundary effect from `session-chat.tsx:2937-2979`.

### Task 5: Wire `session-chat.tsx`

**Files:** `apps/web/src/features/session/session-chat.tsx`

- [ ] **Step 1:** Delete the inline `queuedMessages` state, `queuedMessagesRef`,
      `queuedIdCounterRef`, the seeding effect, and the drain effect.
- [ ] **Step 2:** Read the queue from the store, scoped to this `sessionId`.
- [ ] **Step 3:** `handleQueueMessage` captures the live agent / model / variant
      at enqueue time and stores them on the item (RC8).
- [ ] **Step 4:** Mount `useMessageQueueDrain`, passing the real gates from §1 of
      the spec and a `send` that forwards the captured overrides into
      `handleSend`'s existing fourth parameter.
- [ ] **Step 5:** `handleQueueSendNow(id)` — call `handleStop()`, wait for
      `isServerBusy` to clear (do **not** use a fixed `setTimeout`; subscribe to
      the status), then dispatch that item.
- [ ] **Step 6: Run** `bunx tsc --noEmit` in `apps/web` → no new errors beyond
      the known `@types/bun` `test.each` baseline.

### Task 6: Instant-shell handoff

**Files:** `apps/web/src/features/session/instant-session-shell.tsx`;
`apps/web/src/stores/session-composer-handoff-store.ts`;
`apps/web/src/stores/session-composer-handoff-store.test.ts`

- [ ] **Step 1: Failing test.** A message queued in the shell under session A is
      readable from the store under session A and **not** under session B (RC7).
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3:** Point the shell's `onQueueMessage` at
      `useMessageQueueStore.enqueue(sessionId, …)`. Delete `usePendingQueueStore`
      and its tests; keep `usePendingFilesStore` untouched.
- [ ] **Step 4: Run** → PASS. Then `grep -rn "usePendingQueueStore" apps` → no
      hits.

---

## Phase 3 — UI

### Task 7: The queue list

**Files:** new `apps/web/src/features/session/composer/queued-messages.tsx`;
new `apps/web/src/features/session/composer/queued-messages-logic.ts`; new
`apps/web/src/features/session/composer/queued-messages-logic.test.ts`

- [ ] **Step 1: Failing tests** on the pure helpers in `-logic.ts`:
      `shouldExpandQueue(count, userToggled)`, `queueSummaryLabel(count)`,
      `nextFocusAfterRemove(items, removedIndex)`, and the keyboard reorder
      mapping (`↑`/`↓` → `reorder` args, clamped at the ends).
- [ ] **Step 2: Run** → FAIL. **Step 3:** Implement → PASS.
- [ ] **Step 4: Build the component.** Collapsed ≤2 items, expandable list above
      3 with header `N queued · sends when this turn ends`, `max-h-[40vh]`,
      scrollable. Per row: reorder handle (pointer + `↑`/`↓`), inline edit
      (`Enter` saves, `Esc` cancels, empty removes), **Stop & send**, remove.
      Failed items render below, dimmed, with the error and **Retry**.
      Rehydrated items that lost attachments show an explicit note.
- [ ] **Step 5: Accessibility.** `role="list"`, per-action `aria-label`, polite
      live region announcing queue depth, full keyboard operability.
- [ ] **Step 6:** Read `.claude/skills/kortix-design-system/SKILL.md` and compose
      from `@/components/ui/*`. Motion: `AnimatePresence` + `layout`, spring
      `{ duration: 0.3, bounce: 0 }`, transform/opacity only.

### Task 8: Composer wiring

**Files:** `apps/web/src/features/session/session-chat-input.tsx`;
`apps/web/src/features/session/composer-chat-input.tsx`

- [ ] **Step 1:** Replace the chip block at `session-chat-input.tsx:1104-1131`
      with `<QueuedMessages … />`.
- [ ] **Step 2:** Widen the props: `onEditQueuedMessage`,
      `onReorderQueuedMessage`, `onSendQueuedMessageNow`, `onRetryQueuedMessage`,
      and a richer `queuedMessages` item type.
- [ ] **Step 3:** Thread the same props through `composer-chat-input.tsx`.
- [ ] **Step 4:** Keep every new prop `useCallback`-stable at the call site —
      `SessionChatInput` is `memo`'d and an inline literal silently defeats it.
- [ ] **Step 5:** Update the stale comment at `session-chat-input.tsx:1207-1209`
      ("no separate Add to queue affordance needed"), which now contradicts the
      code.

---

## Phase 4 — Verification

### Task 9: Gates

**Files:** none — this task runs commands and records output.

- [ ] `pnpm --filter @kortix/sdk test` — full suite, count checked against the
      baseline.
- [ ] `pnpm --filter @kortix/sdk typecheck`
- [ ] `cd apps/web && bun test src/stores/message-queue-store.test.ts src/features/session/message-queue-boundary.test.ts src/features/session/composer/queued-messages-logic.test.ts`
- [ ] `cd apps/web && bunx tsc --noEmit` — no new errors over the known
      `@types/bun` `test.each` baseline in 3 files.
- [ ] `cd apps/web && npx eslint src/stores/message-queue-store.ts src/features/session/use-message-queue-drain.ts src/features/session/message-queue-boundary.ts src/features/session/composer/queued-messages.tsx src/features/session/composer/queued-messages-logic.ts src/features/session/session-chat.tsx` — zero errors.
- [ ] `grep -rn "seenCompletedToolIdsRef\|usePendingQueueStore" apps` — no hits.

**Regression assertions to state explicitly in the PR**, each tied to its root
cause: tool completion no longer drains (RC1); `isBusy` is not a drain input
(RC2); the drain effect does not depend on `messages` (RC3); one dispatch per
turn (RC4); the claim is synchronous (RC5); a failed item cannot block the tail
(RC6); the queue is per-session and persisted (RC7); enqueue-time
agent/model/variant is passed through (RC8).
