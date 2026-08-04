# Session message queue — design

**Date:** 2026-08-05
**Branch:** `better-queue`
**Baseline:** `9f1d940c97`
**Surface:** `apps/web` session composer (`apps/mobile` unchanged, see Non-goals)

## Problem

A message typed while the agent is running does not stay queued. It is released
into the middle of the live turn, and sometimes released twice.

Reported symptoms, in the user's words:

1. "If the agent is running and I send a message, it gets to the queue. If a tool
   call, like Run Command, comes, the queue breaks, releases, and sends the
   message directly to the agent, breaking the flow."
2. "Sometimes the queue sends a message many times… It gets sent twice."
3. There is no queue UI beyond a one-line chip with an `X`. No list, no edit, no
   send-now, no reorder.

All three are real and all three are reproducible from the code.

### How the code got here

| Commit | Change |
|---|---|
| — | `apps/web/src/stores/message-queue-store.ts` (297 lines) + `use-message-queue-drain.ts` (96 lines). Per-session, `localStorage`-persisted, agent/model/variant captured at enqueue, `paused`/`failed` flags, send-now. |
| `a9fc74d9d3` | `refactor(web): rewrite message queue to drain in one batch` |
| `67749c1f76` | `Remove client message queue` — deleted the store, the drain hook, and all queue UI. Stated reason: "A failed item stuck at the queue head blocked every subsequent send (lockout)." Sends went direct. |
| current | A ~40-line queue re-added inline inside `session-chat.tsx` with a *tool-completion* drain trigger. |

The current implementation is the third generation and the weakest: it dropped
persistence, per-session scoping, enqueue-time config capture, and failure
handling, and it added a drain trigger that fires mid-turn by design.

`apps/mobile` still runs a descendant of generation 1
(`apps/mobile/stores/message-queue-store.ts`) — persisted, one-at-a-time,
reorderable. Web is the regressed surface.

---

## Root causes

Ten distinct defects. RC1–RC6 produce the reported symptoms; RC7–RC10 are why it
cannot be fixed by a one-line patch.

### RC1 — A finished tool call is treated as a safe boundary

`apps/web/src/features/session/session-chat.tsx:2939-2960`

```ts
if ((status === 'completed' || status === 'error') && !seen.has(part.id)) {
  seen.add(part.id);
  hitToolBoundary = true;
}
…
if (!hitToolBoundary && !hitIdleBoundary) return;
```

Any tool part reaching `completed` or `error` drains the entire queue. A turn
that runs Bash → Read → Edit hits three boundaries while still mid-turn. **This
is symptom 1 exactly.** A tool completing means the agent is still working; it is
the opposite of a safe boundary.

### RC2 — `isBusy` is a 300 ms visual debounce, used as a run-completion signal

`session-chat.tsx:1972-1982`

```ts
busyTimerRef.current = setTimeout(() => setIsBusy(false), 300);
```

`isBusy` exists to stop the busy indicator flickering between agentic steps. The
drain reads it as "the turn ended". Any gap ≥300 ms in server status between
steps therefore reads as turn-end and fires a drain. A UI fade timer is not a
transaction boundary.

### RC3 — Loading older history fabricates boundaries

`seenCompletedToolIdsRef` is a lifetime `Set` of tool ids already reacted to. It
is seeded lazily, so *any* completed tool part that enters `messages` for the
first time counts as a fresh boundary — including tool parts prepended by
`session-older-autoload.ts` when the user scrolls up, and every historical tool
part after a remount. Scrolling through history can send the queue.

### RC4 — The whole queue drains into one turn

`session-chat.tsx:2966-2974`

```ts
for (const item of queue) {
  try { await handleSend(item.text, item.files, item.mentions); }
  catch { failed.push(item); }
}
```

`handleSend` resolves when the server **accepts** the prompt (204), not when the
turn finishes. So items 2..N are dispatched while item 1's turn is running — the
loop reproduces symptom 1 on its own, even with RC1 fixed.

### RC5 — The drain has no lock; its guard reads one-commit-stale state

The drain's only guard is `queuedMessagesRef.current.length === 0`. That ref is
written by a **separate** `useEffect` keyed on `[queuedMessages]`
(`session-chat.tsx:2101-2104`), so it lags the state it mirrors by one commit,
and `setQueuedMessages([])` inside the drain does not clear it synchronously.
Nothing claims the items being drained at the moment the drain starts. A second
drain that observes the pre-clear ref sends the same items again.

### RC6 — Retry without idempotency, plus requeue-on-throw

`packages/sdk/src/react/use-opencode-sessions/messages.ts:31-38` retries a failed
send on transport error, any 5xx, 408, and 429 — `TRANSIENT_BACKOFF_MS =
[400, 1000, 2000]`, and `BOOT_BACKOFF_MS` up to ~30 s for a 503. No idempotency
key is sent; `session-chat.tsx:2831-2834` explicitly does *not* send the message
or part ids.

So a prompt that reached the server but whose ACK was lost is delivered twice.
The drain then compounds it: on final throw it pushes the item back
(`session-chat.tsx:2977`), and the next boundary sends it a third time. **This is
symptom 2.**

### RC7 — The queue is component state and dies silently

`useState<QueuedMessage[]>` inside `SessionChat`. Not persisted, not keyed by
session. Switching session tabs, refreshing, or any remount destroys queued
messages with no notice. The handoff bucket `usePendingQueueStore`
(`apps/web/src/stores/session-composer-handoff-store.ts`) is global and carries
no `sessionId`, so `consumePendingQueue()` hands the instant-shell's queued
messages to whichever `SessionChat` mounts first.

### RC8 — Enqueue-time agent/model/variant is documented but not wired

`handleSend` accepts an `overrides` parameter whose doc comment reads "used by
the message queue drain so a queued message uses the agent/model/variant captured
at enqueue time" (`session-chat.tsx:2626-2640`). The drain never passes it, and
`QueuedMessage` (`session-chat.tsx:409`) has no such fields. Change the model
while a message is queued and it sends under the new one.

### RC9 — There is no queue UI

`session-chat-input.tsx:1104-1131` renders one chip per queued message with a
remove button. No list container, no count, no edit, no send-now, no reorder,
no persistence indicator, no failure state.

### RC10 — A correct queue already exists in the SDK and nothing imports it

`packages/sdk/src/core/session/send-queue.ts` (144 lines, tested) implements
one-at-a-time dispatch, an `inFlight` lock, never-jump-the-line ordering, and
phase reporting. `grep` finds zero call sites. The host reimplemented a worse
one inline, against the repo rule that data/runtime logic lives in the SDK.

---

## Goals

1. A queued message is released **only** when the turn it was queued behind has
   genuinely ended, and never because of a tool call, a status flap, or a history
   load.
2. A queued message is delivered **exactly once**.
3. One message per turn. Three queued messages produce three turns, in order.
4. The queue survives refresh and session-tab switch, per session, per browser.
5. The user can see the full queue and act on every item: **edit**, **send now
   (stop & send)**, **remove**, **reorder**.
6. The failure mode that caused `67749c1f76` to delete the queue — a failed head
   item locking out every later send — cannot recur.

## Non-goals

- The server-side native runtime queue (`delivery: 'queue'` on the v2
  `/api/session/{id}/prompt` route). Tracked separately; this design keeps the
  queue client-side and says so honestly.
- `apps/mobile`. It has its own working queue. Sharing the reducer is a
  follow-up, not this change.
- Channel queues in `apps/api/src/channels/*` — unrelated concept (concurrency
  admission), same word.
- Cross-device queue sync. Per browser only.
- Queuing file attachments across a refresh — `File` objects cannot be
  serialized. See "Attachments and persistence".

---

## 1. The boundary: what "the turn ended" actually means

The single most important decision. The drain must consume a signal that means
*the run finished*, not one that means *the spinner should fade*.

```ts
const canDrain =
  !isServerBusy &&            // sessionStatus.type is neither 'busy' nor 'retry'
  !pendingSendInFlight &&     // our own send has not been acknowledged yet
  !isOptimisticCompacting &&
  !hasActiveQuestion &&       // a structured question is on screen
  !hasPendingApproval &&      // a connector action is awaiting approval
  pendingPermissions.length === 0 &&
  !hasIncompleteAssistant;    // the last assistant message is still open
```

Every one of these already exists in `session-chat.tsx`. None of them is
`isBusy`.

**Edge case the current code gets wrong.** Draining while a question or approval
is pending would answer the question with unrelated queued text, or blow past an
approval gate. The composer already locks itself for both
(`lockForQuestion`, `lockForApproval`) — the drain must honour the same locks.

**Settle window.** `sessionStatus` flaps between agentic steps. The drain arms a
`QUEUE_SETTLE_MS = 700` timer when `canDrain` first becomes true and cancels it
if any gate re-closes. Only a continuously-clear window fires the drain. This is
the mechanism that RC2's 300 ms fade timer was accidentally serving, made
explicit and made long enough to be true.

**Transition, not level.** The drain requires an observed `busy → idle`
transition since the last dispatch. A session that is idle when a message is
enqueued sends immediately through the normal path and never enters the queue.

Boundaries **removed**: tool-part completion (RC1), `isBusy` (RC2), and any
signal derived from the `messages` array (RC3). The drain effect no longer
depends on `messages`.

## 2. Exactly-once delivery

Three layers, because one is not enough.

**Layer 1 — a synchronous claim.** Dispatch takes the head item out of the store
*synchronously* and sets `inFlightId` in the same `set()` call. A second drain
entering the same tick sees `inFlightId !== null` and returns. No ref, no
cross-effect mirror, no stale read. This is what `send-queue.ts` already does
with its `inFlight` set (RC10) and what the current code lacks (RC5).

**Layer 2 — an idempotency key per queued message.** Each item carries a
`clientMessageId` generated at enqueue. It is passed through `handleSend` as the
optimistic message id and — critically — the item is **not re-queued** on throw
if the send got as far as the server. The store records `attempts` and
`lastError`, and the item moves to a terminal `failed` state, not back to the
head.

**Layer 3 — the failed item never blocks the queue.** This is the explicit fix
for the lockout that killed generation 1. A failed item is lifted out of the
pending list into a `failed` list rendered with a retry affordance. The pending
list keeps draining. **The queue can never wedge.**

## 3. Ordering and one-per-turn

`dispatch()` takes exactly one item. The next dispatch requires a *new*
`busy → idle` transition. Concretely:

```
enqueue A, B, C   (agent busy)
turn 1 ends  → dispatch A → session goes busy → turn 2
turn 2 ends  → dispatch B → session goes busy → turn 3
turn 3 ends  → dispatch C
```

Never jump the line: enqueueing while `inFlightId` is set always appends, even if
the session momentarily reads idle.

## 4. State shape

Lives in `apps/web/src/stores/message-queue-store.ts`, keyed by `sessionId`.
Pure transitions live in the SDK (§7).

```ts
interface QueuedMessage {
  id: string;                 // client-only queue id
  clientMessageId: string;    // idempotency key, survives retry
  sessionId: string;
  text: string;
  files?: AttachedFile[];     // in-memory only, see below
  mentions?: TrackedMention[];
  /** Captured at enqueue — closes RC8. */
  agent?: string | null;
  model?: { providerID: string; modelID: string } | null;
  variant?: string | null;
  createdAt: number;
  attempts: number;
  lastError?: string;
}

interface SessionQueue {
  pending: QueuedMessage[];
  failed: QueuedMessage[];
  inFlightId: string | null;
}
```

### Attachments and persistence

`File` objects and `blob:` URLs cannot be serialized and do not survive a
reload. The persisted shape therefore carries `text`, `mentions`, `agent`,
`model`, `variant`, and a `hadAttachments: number` count. On rehydrate, an item
that had attachments renders with an explicit "attachments were not restored"
note rather than silently sending a message the user believes carries files.
Stating the gap beats a silent truncation.

Storage key: `kortix_message_queue_v3`. `v1` (mobile) and `v2` (deleted web
store) are left alone; a `v2` payload is ignored, not migrated — those queues
have been dead since `67749c1f76` and their contents are months stale.

## 5. UI

Replaces the chip row at `session-chat-input.tsx:1104-1131`.

**Collapsed** (default, ≤2 items): the existing rows, plus per-row actions.
**Expanded** (≥3 items, or on click): a header — `3 queued · sends when this turn
ends` — over a scrollable list, max-height ~40vh.

Per row:

| Control | Behaviour |
|---|---|
| Drag handle | Reorder within `pending`. Keyboard: `↑`/`↓` with the row focused. |
| Text | Click to edit inline. `Enter` saves, `Esc` cancels, empty text removes. |
| **Stop & send** | Aborts the running turn, then dispatches this item. Labelled exactly that — the button says what it does, so interruption only ever happens because the user asked for it. Disabled when the session is already idle (it just sends). |
| Remove | Drops the item. `Cmd+Z` undo toast for 5 s. |

The `failed` list renders below `pending`, dimmed, each row with the error text
and a **Retry** button that moves it back to the tail of `pending`.

Motion follows the repo doctrine already in this file: `AnimatePresence` with
`layout`, spring `{ duration: 0.3, bounce: 0 }`, transform and opacity only.

**Accessibility.** The list is a `role="list"`; reorder is operable from the
keyboard; each action button has an explicit `aria-label`; queue depth changes
announce via a polite live region.

## 6. Instant-shell handoff

`usePendingQueueStore` (global, unkeyed — RC7) is deleted. The instant session
shell writes directly into the per-session queue under the session id it is
about to navigate to, and `SessionChat` reads its own session's queue. No
consume-once bucket, no cross-session leak, no ordering guess.

## 7. Where the code lives

Per the repo rule that runtime logic belongs to `@kortix/sdk` and hosts are thin:

| Layer | Location | Framework |
|---|---|---|
| Queue transitions (enqueue, dispatch-claim, complete, fail, retry, reorder, edit) as **pure functions** over `SessionQueue` | `packages/sdk/src/core/session/message-queue.ts` | none — isomorphic tier |
| Persistence + React binding | `apps/web/src/stores/message-queue-store.ts` (zustand + `localStorage`) | web |
| Boundary detection + dispatch | `apps/web/src/features/session/use-message-queue-drain.ts` | web |
| Presentation | `apps/web/src/features/session/composer/queued-messages.tsx` | web |

`send-queue.ts` (RC10) keeps its name and its tests — it is a published export —
and is documented as superseded by `message-queue.ts` for host use.

The pure reducer is what makes the invariants testable without a browser: "two
dispatches in one tick claim one item", "a failed head does not block the tail",
"reorder cannot move the in-flight item" are unit tests over plain objects.

## 8. What this does not fix

Stated plainly rather than implied:

- **A queue in a tab still dies with the tab's browser profile.** Persistence is
  `localStorage`, per browser. Another device sees nothing.
- **RC6's underlying cause is server-side.** Layer 2 stops the *queue* from
  double-sending. A retry inside `promptOpenCodeMessage` that duplicates a
  prompt the server already accepted is only fully fixed by an idempotency key
  the server honours. This design keeps the client from making it worse and
  leaves a note where the server fix belongs.
- **File attachments do not survive a reload.** §4.
