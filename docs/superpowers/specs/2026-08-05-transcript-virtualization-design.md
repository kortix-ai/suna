# Session transcript virtualization — design

Date: 2026-08-05
Branch: `virtualized-messages-rendering`
Supersedes the virtualization in PR #6104.

## 1. The problem

The transcript on PR #6104 mounts every rendered node of a session, always. The
virtualizer added by that PR windows nothing.

Measured in Chrome against `localhost:15100`, session
`e025cf03-e258-44c0-835c-8de7998bf012`, signed in as `sutharjay3635@gmail.com`:

| Metric | Value |
| --- | --- |
| `useVirtualizer` `count` | 1 |
| Mounted items after a full top-to-bottom scroll | 1 of 1 |
| `getTotalSize()` | 17,944 px — exactly the single item |
| Transcript DOM nodes | 2,818 |
| Rows inside that single item | 324 |

A second session (`a1476c5f`) measured `count: 2`, both mounted, 915 nodes.

### 1.1 Root cause

The virtualization unit is a **turn**. `groupMessagesIntoTurns`
(`packages/sdk/src/core/turns/grouping.ts:53`) defines a turn as one user
message plus every assistant message linked to it. An agent session where the
user sends one prompt and the agent works for twenty minutes is therefore
**one turn**.

`useVirtualizer({ count: turns.length })` with `count: 1` cannot skip anything.

The list that actually repeats is one level down: the `Segment[]` produced by
`segmentTurn` (`apps/web/src/features/session/turn/segment-turn.ts:23`) and
rendered at `session-chat.tsx:1255`. The DOM confirms it — the `space-y-2`
wrapper at `session-chat.tsx:1242` had 324 children:

```
virtual item (1 of 1)                 17,944 px
└ group/turn space-y-2.5              4 children
  ├ header (report + user bubble)        248 px
  ├ space-y-2                        324 items   <- the real list
  ├ aria-live                              1 px
  └ footer (response + action bar)        97 px
```

Segment heights ranged 20 px to 487 px, median ~24 px, totalling 15,198 px.

### 1.2 Regressions the same PR introduced

These are independent of the dead virtualization and are user-visible today.

1. **Anchors land 48 px low.** `session-chat.tsx:3961` changed the inter-turn
   gap from `mt-12` to `pt-12`. `[data-turn-id]` is on that wrapper, and
   `use-auto-scroll.ts:99` (`measureTarget`), `use-auto-scroll.ts:189`
   (`recalcSpacer`), `use-auto-scroll.ts:339` (`anchorTurn`) and
   `chat-minimap.tsx:172` (`handleJump`) all read its rect or `offsetHeight`.
   A margin was excluded from both; padding is not. Every anchor is off by 48 px,
   and the spacer is 48 px short.

   The inline justification at `session-chat.tsx:3952` is incorrect: virtual-core
   measures via `borderBoxSize`/`offsetHeight`
   (`@tanstack/virtual-core@3.17.3/dist/esm/index.js:133`), not
   `getBoundingClientRect`.

2. **The reader cannot scroll up while streaming.** `resizeItem`
   (`virtual-core/index.js:826`) treats a grown item as being above the viewport
   and calls `applyScrollAdjustment(delta)` → `scrollTo({ top: offset + delta })`
   on the same node `useAutoScroll` owns. With `count: 1`, `itemStart` is 0, so
   the `itemStart < scrollOffset` guard is true for any `scrollTop > 0`. The
   correction is a *downward* programmatic scroll, so none of `useAutoScroll`'s
   three intent detectors (wheel `:453`, touch `:487`, `cur < last - 2` `:527`)
   observe it. The viewport creeps back toward the tail at the streaming rate.

3. **React Compiler is disabled for all of `SessionChat`.** Verified:

   ```
   $ npx eslint src/features/session/session-chat.tsx
   2578:27  warning  Compilation Skipped: Use of incompatible library
            react-hooks/incompatible-library
   ```

   `SessionChat` is 4,204 lines. The compiler previously memoized all of it. The
   `useCallback`/`memo` additions elsewhere in the same diff are manual
   reinstatement of what the virtualizer switched off.

4. **The minimap's own jump is dead for unmounted turns.**
   `chat-minimap.tsx:165` still resolves targets with
   `contentEl.querySelector('[data-turn-id=…]')` and returns silently on miss.
   The PR converted the other jump path (`session-chat.tsx:2819`) but not this one.

5. **`scrollMargin` is unset.** The virtualized container is not at offset 0 of
   the scroll element — measured 22 px and 45 px in two sessions, and it grows
   when the load-older block or the optimistic turn renders. virtual-core builds
   item coordinates seeded with `scrollMargin` (`index.js:645`) and compares them
   against raw `scrollTop` (`index.js:1213`). Positioning is accidentally correct
   only because the margin is 0; the range window is shifted, and
   `scrollToIndex` (`index.js:951`) lands short by exactly that offset — on both
   callers, including the load-older anchor restore, which runs precisely when
   the offset is at its maximum.

6. **`estimateSize: () => 600` against 17,944 px items.** `getTotalSize()` is
   short by `(real − 600)` for every unmounted item, so the scrollbar rescales
   continuously and `scrollContainerCallbackRef`'s
   `scrollTop = scrollHeight − clientHeight − 300` (`session-chat.tsx:2453`) aims
   at a phantom height, producing two visible jumps on session open.

7. **`getItemKey` is an inline arrow** (`session-chat.tsx:2585`). It is a
   dependency of the measurement memo (`index.js:558`), which compares by
   identity, so every render wipes `pendingMin` (`index.js:574`) and rebuilds the
   whole measurement array. Every streamed token costs an O(N) remeasure.

8. **`overscan: 8`** (`session-chat.tsx:2586`) mounts up to 17 turns. Its stated
   reason — keeping the tail mounted for `useAutoScroll` — was made obsolete by
   the same PR, which switched `findLastTurn` to `[data-last-turn]`
   (`use-auto-scroll.ts:87`).

### 1.3 What `main` had that the PR removed

`main` carried `[content-visibility:auto] [contain-intrinsic-size:auto_600px]`
on each turn wrapper. That is the browser's own off-screen render skipping, and
`auto` makes each element remember its last rendered size, so the 600 px guess
self-corrected per element with no JS cache. For multi-turn threads the PR is a
net regression.

## 2. Goals

1. Mounted DOM is bounded by viewport size, not by session length. Target: the
   17,944 px / 2,818-node session mounts under 400 nodes.
2. No behavior change the reader can see, except that it is faster. Anchoring,
   auto-follow, jump-to-message, the minimap, load-older and rewind all behave
   as they do on `main`.
3. Fix the five regressions in §1.2 that exist today.
4. The virtualization primitive is headless and reusable: the product owns the
   scroll surface and all markup.

### Non-goals

- Windowing *inside* an `ActivityBurst`. `ChainOfThought`
  (`components/ui/chain-of-thought.tsx:135`) clones children with positional
  keys and an `isLast` rail terminator; windowing there would remount every step
  and break the rail. The segment is the floor.
- In-app transcript search. Windowing breaks `Cmd+F` over unmounted content.
  Recorded as a known limitation, not solved here.

## 3. Design

### 3.1 Row model

One flat row list across the whole transcript, one virtualizer.

```ts
type TranscriptRow =
  | { kind: 'compaction';  key: string; turnId: string }
  | { kind: 'turn-head';   key: string; turnId: string; turnIndex: number }
  | { kind: 'segment';     key: string; turnId: string; segIndex: number
                           segment: Segment; isTrailing: boolean }
  | { kind: 'turn-tail';   key: string; turnId: string; turnIndex: number }
```

Row keys derive from part ids, which are stable across re-renders (upserted by
binary search on `p.id`, `sync-store.ts:246`):

```ts
segment.kind === 'burst' ? `burst-${segment.parts[0].id}` : segment.part.id
```

`isTrailing` is computed against the **full** segment array when the row model is
built, never from the window slice. `ActivityBurst` uses
`index === segments.length - 1` (`session-chat.tsx:1263`) to decide open vs
collapsed, which is a 24 px ↔ 487 px difference.

Shell-mode turns (`session-chat.tsx:1118`) and compaction cards
(`session-chat.tsx:1149`) are single rows — they have no segment list.

### 3.2 `useVirtualList` — headless primitive

`apps/web/src/hooks/use-virtual-list.ts`.

```ts
useVirtualList<T>({
  rows: readonly T[],
  getRowKey: (row: T, index: number) => string,
  estimateRowHeight: (row: T, index: number) => number,
  scroll: { mode: 'element'; ref } | { mode: 'window' },
  overscan?: number,
  snapshot?: VirtualListSnapshot,
}): {
  items, totalSize, scrollMargin,
  measureRef, scrollToKey, scrollToIndex,
  snapshot(): VirtualListSnapshot,
}
```

Responsibilities, each addressing a numbered defect from §1.2:

- **Auto `scrollMargin`** (defect 5). Measures the list container's offset within
  the scroller on layout and whenever the container resizes, and feeds it to
  `useVirtualizer`. Consumers position with `start - scrollMargin`, matching
  `@tanstack/react-virtual/dist/esm/index.js:41`. This is not optional once the
  margin is non-zero.
- **Stable options** (defect 7). `getItemKey` and `estimateSize` are
  `useCallback`-wrapped so the measurement memo is not invalidated per render.
- **Streaming growth** (defect 2). Sets `anchorTo` / `followOnAppend`
  (available in virtual-core 3.17.3, `index.js:269`, `:302`) and assigns
  `shouldAdjustScrollPositionOnItemSizeChange` on the instance — it is an
  instance property, not an option (`index.d.ts:117`) — so a tail-growing row
  does not drag the reader down.
- **Prepend anchoring.** Anchors on row key, not node identity, so a load-older
  prepend that unmounts the anchor node still restores.
- **Snapshot** — `{ offset, measurements: Array<[key, size]> }`, restored via
  `initialOffset` + `initialMeasurementsCache` (`index.js:267`, `:622`), which
  the current code does not supply.

Placed in **its own small component** (`TranscriptRows`), not in `SessionChat`.
`react-hooks/incompatible-library` (defect 3) skips React Compiler for the
component that calls `useVirtualizer`; scoping it to a small component keeps the
compiler running on the other 4,200 lines. Verified by eslint before and after.

### 3.3 Splitting `SessionTurnImpl`

`SessionTurnImpl` (`session-chat.tsx:609–1467`, 861 lines) becomes:

- `useTurnModel(props): TurnModel` — the derived state at `:629–1112`. Runs
  **once per turn**; turns are few.
- `TurnHead` — `:1188–1225` (report card, `SubSessionModal`,
  `SystemMessageIndicator`, `UserMessage`).
- `TurnSegment` — `:1256–1301`, one segment.
- `TurnTail` — `:1306–1465` (aria-live, streaming response, inline content,
  response section, retry/busy, error, action bar, `ConnectProviderDialog`).

Turn-level flags (`hasSteps`, `hasReasoning`, `working`, `shouldUseInlineContent`,
`answeredQuestionPartsById`) are derived from the whole turn and gate segment
rendering — `:1294` returns `null` for a text segment when `!hasSteps`. They live
on `TurnModel` and are passed down, so a segment's render never depends on its
neighbours being mounted.

### 3.4 Three windowing blockers

| Blocker | Failure | Fix |
| --- | --- | --- |
| `space-y-2` (`:1242`) and `space-y-2.5` (`:1187`) | Tailwind v4 compiles to `:not(:last-child)`. A windowed subset loses one gap, so measured row heights stop summing to the container height. | Per-row padding. |
| `ActivityBurst.open` + `userToggled` (`activity-burst.tsx:172`), `BasicTool.open` (`tool/shared/infrastructure.tsx:1272`), `FileList.expandedIndex` (`tool/shared/file-list.tsx:192`), `ThoughtStepBody.expanded` (`activity-burst.tsx:42`) | Unmount destroys them. Scroll away from an expanded card and back → collapsed, and its measured height silently changed. | Lift to a per-session `Map<rowKey, uiState>` held outside the windowed subtree. |
| `group-hover/turn` (`:1426`, `user-message.tsx:671`) | Head and tail are separate virtual items with no shared ancestor, so hovering the middle stops revealing the action bar. | Delegated `mouseover` on the container toggling `data-turn-hovered`; the three utility strings gain a `group-data-[turn-hovered]/turn:` variant. Zero re-renders. |

### 3.5 Inter-turn gap

Revert `pt-12` to a form whose rect matches the turn's content (defect 1): the
gap moves to a dedicated spacer or to an inner wrapper, so `[data-turn-id]`'s
rect excludes it and `measureTarget` / `recalcSpacer` / `anchorTurn` /
`handleJump` all measure what they did on `main`.

### 3.6 Consumers to adapt

- `use-auto-scroll.ts` — `[data-last-turn]` moves to the last `turn-tail` row.
  `recalcSpacer` keeps the existing "tail unmounted → hold current value" bail-out.
- `chat-minimap.tsx` — `handleJump` routes through `scrollToKey` (defect 4).
  `renderedIdsKey` continues to re-arm the observer.
- `session-chat.tsx:2810` jump-to-message — resolves a row key, not a turn index.
- `session-history-scroll.ts` — `turnId` anchor already added; it now resolves a
  row key.

### 3.7 Estimates and overscan

`estimateRowHeight` is per row kind, from the measured distribution: segments
~48 px (median 24 px, mean 47 px), heads ~248 px, tails ~97 px. Not one 600 px
constant for everything (defect 6). `overscan` drops to 6 rows — with ~48 px
rows that is ~290 px of lead-in, against the ~300,000 px the current
`overscan: 8` mounts (defect 8).

## 4. Testing

**Unit (`bun test`, pure, no DOM):**
- Row model: turns+segments → rows; `isTrailing` only on the true last segment;
  shell and compaction turns produce a single row; keys stable across a streamed
  token that changes only the last segment.
- Snapshot round-trip: `snapshot()` → `restore()` yields the same offset and
  measurement cache.
- `scrollMargin` arithmetic: `start - scrollMargin` positioning.

**The regression test that would have caught this bug** — assert `count` is the
row count and that the row count exceeds the turn count for a single-turn,
many-segment fixture. The existing 18 tests pass on a dead virtualizer because
none of them assert anything about how many items are mounted.

**Browser (Chrome, `localhost:15100`, session `e025cf03`):**
- Mounted rows ≪ total rows, and the mounted set changes during a full scroll.
  This is the assertion that fails on the current PR.
- Screenshot diff per stage against `main` — approved verification method.
- Scroll up mid-stream and confirm the viewport does not creep down (defect 2).
- Send a message and confirm the bubble parks where it does on `main`, not
  48 px lower (defect 1).
- Minimap jump to an unmounted turn (defect 4).
- Load older history and confirm no viewport jump (defect 5).
- `npx eslint src/features/session/session-chat.tsx` — no
  `react-hooks/incompatible-library` on `SessionChat` (defect 3).

## 5. Staging

Each stage is independently verifiable and leaves the app working.

1. `useVirtualList` + row model + unit tests. Pure, additive, nothing wired up.
2. Split `SessionTurnImpl` into `useTurnModel` + `TurnHead`/`TurnSegment`/`TurnTail`.
   No virtualization. Screenshot diff must be clean.
3. Wire the transcript onto the flat row model and `useVirtualList`. Restore the
   inter-turn gap semantics. Screenshot diff must be clean.
4. UI-state lifting, hover delegation, and consumer adaptation
   (auto-scroll, minimap, jump, history anchor).
5. Browser verification of every item in §4 on the user's session.

## 6. Known limitations

- `Cmd+F` and `Cmd+A` over the transcript reach only mounted rows. There is no
  in-app transcript search to replace them. Pre-existing to any windowing
  approach; recorded, not solved.
- A pending permission card can scroll out of the DOM. It remains answerable
  from the composer and reappears on scroll-back; the lifted UI state keeps its
  reply-in-flight state.
