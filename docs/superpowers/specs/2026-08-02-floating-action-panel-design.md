# Floating ActionPanel + unified detail shell

**Date:** 2026-08-02
**Branch:** `refactor/chat-thread-messages`
**Baseline:** `719afc208`

## Problem

Two defects in the session's right panel, one visible and one structural.

1. **The terminal is a second, parallel detail shell.** `easy-panel.tsx:746` renders
   the terminal as a *sibling* `motion.div` of `DetailLayer`, hand-copying the detail
   card's frame (`bg-popover border-border absolute inset-y-3 right-3 left-3 rounded-md
   border shadow`) and its own header. Browser (`AppPreview`), Files
   (`SessionFilesExplorer`), and file preview (`FilePreview`) are all proper `Detail`s.
   The terminal is the only outlier, so it reads as its own sidebar rather than a view
   inside the detail shell.

   The duplication is not laziness. `DetailLayer` unmounts its body through a keyed
   `AnimatePresence`. `SessionTerminalPanel` owns a long-lived PTY WebSocket. Making the
   terminal an ordinary `Detail` drops the shell and replays scrollback on every reopen.

2. **The cards and the details share one open flag.** `EasyPanel` is one component
   owning the home cards (Outputs / Context / Preview) *and* `detail` as local
   `useState`, both rendered inside the same `ResizablePanel`. `isSidePanelOpen` governs
   both. Opening the cards is opening the detail panel, because they are the same panel.

## Goal

- Right side panel keeps the existing detail-view shell, visually unchanged. Terminal,
  browser, file, and file/code preview all render inside it as swappable views.
- The ActionPanel (Easy home: Outputs / Context / Preview cards) leaves the side panel
  and becomes a floating panel overlaying the session chat, anchored top right.
- Two independent open states with zero coupling.

## Non-goals

- No change to the detail-view shell's visual design, motion, or header.
- No change to how browser / file / preview behave inside it.
- No change to `AdvancedPanel` (disabled since the Easy Panel v2 spec, 2026-07-17, but
  kept intact).

---

## 1. Architecture: one provider, two consumers

Splitting the cards and the details across the screen puts them in two React subtrees. A
card row click in the chat overlay must open a detail in the side panel, so the state
must live above both.

Rejected alternatives:

| Approach | Reason rejected |
|---|---|
| Lift `detail` into zustand | Forces `Detail.body` from `ReactNode` to a serializable descriptor plus a render-switch. Rewrites the shell's interface and every opener's call shape. |
| Portal the cards out of the side panel | Cards stay inside a subtree that gets `hidden` and zero width when the panel closes. Fragile. |

**Chosen: hoist state into `SessionPanelProvider`, mounted in `session-layout.tsx`.**

Everything `easy-panel.tsx` owns today moves into the provider:

- State: `detail`, `terminalOpen`, `terminalSwap`, `terminalActivated`, `outputsDefaultOpen`.
- Openers: `openDetail`, `handleOpenOutput`, `openTerminal`, `closeTerminal`,
  `closeDetail`, `openBrowser`, `openFiles`, `openAudit`.
- Consume-effects: payoff, ready-chip, quick-view, file-open, focused-tool-call,
  auto-expand-outputs.
- Store writes: `setIsExpanded`, `setPanelSplit`, `setPanelAspect`, `setDetailOpen`.

Resulting tree:

```
SessionPanelProvider                 owns detail + terminal state, all openers
├── ResizablePanel (main)
│   └── SessionChat
│       └── SessionActionPanelOverlay    floating top-right: Outputs / Context / Preview
└── ResizablePanel (side)
    └── DetailLayer                      terminal | browser | file | preview
```

`Detail` keeps its `ReactNode` body. `DetailLayer`, `FilePreview`, `AppPreview`,
`ToolParts`, `SessionFilesExplorer` are untouched.

Access is via `useOptionalSessionPanel()`, returning `null` outside a provider. This
matters: `<SessionChat>` has two call sites, and
`features/session/sub-session-modal.tsx:49` renders it *outside* `SessionLayout` in
read-only mode. The overlay self-gates to `null` there. The same idiom is already used
by `useOptionalSidebar` in `detail-view.tsx:94`, for the same reason.

## 2. Terminal becomes a view inside the detail shell

`DetailLayer` gains one prop:

```ts
/** Content mounted once for the session's life and shown inside the detail
 *  card frame without unmounting on close. The terminal uses this: its PTY
 *  WebSocket must survive every close, which the keyed AnimatePresence below
 *  cannot promise. Visibility is toggled by `persistentSlotOpen`. */
persistentSlot?: ReactNode;
persistentSlotOpen?: boolean;
```

Rules:

- The keyed `AnimatePresence` continues to wrap only non-persistent details.
- The persistent slot mounts once `persistentSlotOpen` first turns true (the existing
  `terminalActivated` latch, moved to the provider), then stays mounted with `inert` +
  `opacity 0` + `pointer-events-none` while closed.
- The slot renders inside the **same** card frame as a detail. No second frame.
- Mutual exclusion is preserved: opening a detail closes the terminal and vice versa,
  and the existing swap/crossfade choreography carries the exchange.

Deleted: the duplicated `motion.div` frame at `easy-panel.tsx:746-772` and its header.
`terminalLayerMotion` folds into the shell's existing swap logic.

The shell's visible design is unchanged: same frame, same `SLIDE_TRANSITION` (260ms),
same `CROSSFADE_TRANSITION` (130ms), same header layout.

Mobile is unchanged: the terminal remains its own `Drawer`, as today.

## 3. Two independent states

New store field in `kortix-computer-store.ts`, with the same per-session persistence the
existing panel flag uses (`_panelOpenBySession`):

```
isActionPanelOpen   floating cards over the chat
isSidePanelOpen     the detail panel
```

Writers, exhaustively:

| Trigger | Writes |
|---|---|
| Chevron in `session-chat.tsx` | `isActionPanelOpen` |
| `⌘I` (`session-layout.tsx:196-207`) | `isActionPanelOpen` |
| Header terminal / browser / files (`openSessionQuickView`) | `isSidePanelOpen` + detail |
| Tool-call click in chat (`focusToolCall`) | `isSidePanelOpen` + step detail |
| File path click in chat (`fileOpenBySession`) | `isSidePanelOpen` + file detail |
| Card row click in the floating panel | `isSidePanelOpen` + that detail |
| End-of-run payoff | `isSidePanelOpen` + primary deliverable |

No trigger writes both. `⌘I` is repointed from the side panel to the floating panel. The
hotkey effect lives in `session-layout.tsx:196-207`, not in `session-chat.tsx`.

**Header change.** The `PanelRight` toggle at `session-site-header.tsx:282-301` is
deleted, along with its `Hint` / `Kbd` wrapper and the now-dead `onToggleSidePanel` and
`isSidePanelOpen` props. The side panel has no manual open control by design: it opens
with content and closes via its own X or Escape. An empty detail view is not a state
worth reaching.

**Ready chip — and a live bug the split would otherwise create.** The dot rides on that
same `PanelRight` button (`session-site-header.tsx:293`), and it is cleared by
`setIsSidePanelOpen(true)` at `kortix-computer-store.ts:298`. Both halves must move
together: the dot moves to the chevron, and the clear moves to `setIsActionPanelOpen`.
Moving only the dot leaves it announcing a deliverable that nothing can ever dismiss.

The chip announces a finished deliverable, and deliverables are listed in the Outputs
card, so the floating panel is the correct destination for the tap.

Note `requestPrimaryOpen` / `pendingPrimaryOpenSessionId` (`kortix-computer-store.ts:405`)
has **no production caller** — only `mode-gate.test.tsx:154` and
`kortix-computer-store.test.ts:32`. The chip-consume effect at `easy-panel.tsx:500` is
therefore unreachable in the shipped path today. It moves to the provider unchanged; this
work neither revives nor removes it.

`setIsSidePanelOpen`'s reset of `panelSplit` / `panelAspect` / `isExpanded` on close
(`kortix-computer-store.ts:300+`) stays with the side panel — those states describe a
detail's width, which the floating panel does not have.

**Payoff.** `shouldAutoOpenPayoff` in `easy-panel-logic.ts:343` loses its `panelOpen`
parameter, so an end-of-run deliverable opens the side panel even when it is closed.
This is safe against replay: the predicate still fires only on the `wasRunning &&
!isRunning` edge, only when `outcome === 'succeeded'`, only when `!detailOpen`, and only
when `!interactedThisRun`. The edge is the real guard; `panelOpen` was a redundant
second one.

## 4. Floating panel

- `absolute`, anchored top-right of the chat area, clearing the header row.
- Fixed width `380px`, `max-w-[calc(100vw-2rem)]`. Bounded height with internal scroll.
- **No wrapper.** No card, radius, shadow, border, or background. The three cards carry
  their own `bg-card` and border and are the only visible containers. The chat reads
  through the gaps between them.
- Container is `pointer-events-none`; the cards are `pointer-events-auto`, so gaps do
  not intercept text selection in the chat underneath.
- `z-20`: above chat content (`z-10`), below the selection popup (`z-50`).
- Enter/exit: slide + fade from the right. Exit subtler than entrance, per the
  `animations-dev` doctrine. Reduced motion trades the slide for a fade.

**Toggle.** Icon button, `absolute` top-right of the chat area.

- closed → `CaretDoubleLeftIcon`
- open → `CaretDoubleRightIcon`

This repo is Phosphor (`@phosphor-icons/react`); lucide's `ChevronsLeft` / `ChevronsRight`
do not exist here. Both icons are new imports — no double-caret icon is currently used
anywhere in `apps/web/src`.

**Mobile.** The floating overlay is desktop-only. At 375px a top-right panel is the whole
screen, so mobile keeps the existing `Drawer` presentation; the chevron opens the drawer.

## 5. Side-panel width logic

With the cards gone, the side panel shows a detail whenever it is open. Consequences in
`session-layout.tsx`:

- The Easy-mode default of 35/65 (a narrow card column) no longer applies. The panel opens
  at the width the detail asks for: `panelAspect` if the document measured itself, else
  `panelSplit` (70 presentation / 50 terminal), else the default.
- `detailOpen` currently gates the resize grip's visibility so the fixed-width card home
  shows no grip. That condition is now always true when the panel is open, so
  `handleVisible` reduces to `handleEnabled`.
- `resolveSideSize`'s `isEasy` branch simplifies accordingly.

## 6. File-by-file scope

| File | Change |
|---|---|
| `stores/kortix-computer-store.ts` | add `isActionPanelOpen` + actions + per-session persistence; move the ready-chip clear off `setIsSidePanelOpen` |
| **new** `features/session/action-panel/session-panel-provider.tsx` | hoisted state, openers, consume-effects, `useOptionalSessionPanel` |
| **new** `features/session/session-action-panel-overlay.tsx` | floating container + chevron toggle |
| `action-panel/easy/easy-panel.tsx` | reduce to cards-only; ~250 lines move to the provider |
| `action-panel/easy/detail-view.tsx` | add `persistentSlot` / `persistentSlotOpen` |
| `action-panel/easy/easy-panel-logic.ts` | drop `panelOpen` from `shouldAutoOpenPayoff` |
| `session-layout.tsx` | mount provider; side panel renders detail only; width logic simplifies; repoint `⌘I` |
| `session-chat.tsx` | render overlay + chevron (chevron carries the ready-chip dot) |
| `header/session-site-header.tsx` | delete `PanelRight` toggle, its props, and the ready-chip dot |
| `action-panel/index.tsx` | unchanged (still selects Easy vs Advanced) |

## 7. Verification

Unit / component:

- `kortix-computer-store.test.ts` — writing `isActionPanelOpen` never moves
  `isSidePanelOpen`, and the reverse. Per-session persistence for both. The ready chip
  clears on `setIsActionPanelOpen(true)` and no longer on `setIsSidePanelOpen(true)`.
- `detail-view.test.tsx` — `persistentSlot` stays mounted across a detail open/close
  cycle; the keyed `AnimatePresence` still unmounts ordinary detail bodies.
- `easy-panel-logic.test.ts` — `shouldAutoOpenPayoff` fires with the panel closed; still
  refuses on a non-edge, on failure, on `detailOpen`, and on `interactedThisRun`.
- `session-site-header.test.tsx` — the panel toggle is gone.

Browser, per CLAUDE.md's required standard — assertions on DOM and network, not only
screenshots:

1. Chevron opens the floating panel; assert the side panel's width stays 0.
2. Header terminal button opens the side panel; assert the floating panel state is
   unchanged and no second frame is in the DOM.
3. Terminal open → open a file detail → reopen terminal; assert the PTY WebSocket was
   never torn down and scrollback did not replay.
4. Browser / file / preview each render inside the detail card, not as their own layer.
5. Run to completion with the side panel closed; assert the payoff opens it once.

Lint / types: `npx eslint <changed files>`; `tsc --noEmit` grepped for the changed files
only (the React 19/18 types mismatch emits ~1500 bogus `TS2786`).

## Open risks

- `easy-panel.tsx` is 834 lines with dense, load-bearing comments explaining motion
  choreography and effect ordering. The extraction must carry those comments to the
  provider verbatim, not drop them.
- Six consume-effects all depend on subscribing to a changing store *value* rather than a
  stable action, because the panel stays mounted behind a closed side panel. That
  reasoning still holds in the provider, which is also always mounted. The effects must
  not be rewritten to subscribe to actions during the move.
