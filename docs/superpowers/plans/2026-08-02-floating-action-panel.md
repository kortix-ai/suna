# Floating ActionPanel + unified detail shell — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Pull the Easy-mode cards out of the right side panel into a floating overlay over the chat, and make the side panel a single detail shell that hosts terminal, browser, files, and file preview as swappable views.

**Architecture:** Hoist `EasyPanel`'s detail + terminal state into a `SessionPanelProvider` mounted at `SessionLayout`, above both the chat and the side panel. `DetailLayer` absorbs the terminal as a keep-alive `persistentLayer` so there is one card shell, not two. Two independent zustand flags govern the two surfaces.

**Tech Stack:** Next.js, React 19, zustand, motion/react, Tailwind v4, `@phosphor-icons/react`, bun:test.

**Spec:** `docs/superpowers/specs/2026-08-02-floating-action-panel-design.md`

## Global Constraints

- Icons are Phosphor. `CaretDoubleLeftIcon` / `CaretDoubleRightIcon`. Lucide names do not exist in this repo.
- Never animate `width`/`height`/`margin`. Transform + opacity only.
- Enter/exit easing is ease-out. Exit runs ~75–80% of enter. Reduced motion drops movement, keeps opacity.
- Loading is `<Loading />` only — never a spinning icon.
- No new dependencies.
- Do not alter `DetailLayer`'s visual design, its `SLIDE_TRANSITION` (260ms), or its `CROSSFADE_TRANSITION` (130ms).
- Comments in `easy-panel.tsx` explaining motion choreography and effect-subscription rules move verbatim; they are load-bearing.

---

## File Structure

| File | Responsibility |
|---|---|
| `stores/kortix-computer-store.ts` | `isActionPanelOpen` + per-session persistence; chip clear |
| **new** `features/session/action-panel/session-panel-provider.tsx` | all detail/terminal state, openers, consume-effects; `useOptionalSessionPanel` |
| **new** `features/session/action-panel/session-detail-panel.tsx` | side-panel host: `DetailLayer` + persistent terminal |
| **new** `features/session/session-action-panel-overlay.tsx` | floating container + chevron toggle |
| `action-panel/easy/easy-panel.tsx` | reduced to the three cards |
| `action-panel/easy/detail-view.tsx` | `persistentLayer` prop |
| `action-panel/easy/easy-panel-logic.ts` | drop `panelOpen` from `shouldAutoOpenPayoff` |
| `session-layout.tsx` | mount provider; detail-only side panel; `⌘I` repoint |
| `session-chat.tsx` | render overlay + chevron |
| `header/session-site-header.tsx` | delete `PanelRight` toggle + dead props |

---

### Task 1: Store — two independent flags

**Files:** Modify `apps/web/src/stores/kortix-computer-store.ts`; Test `apps/web/src/stores/kortix-computer-store.test.ts`

**Produces:** `isActionPanelOpen: boolean`, `setIsActionPanelOpen(open: boolean): void`, `toggleActionPanel(): void`, `useIsActionPanelOpen(): boolean`

- [ ] **Step 1: Failing test** — `setIsActionPanelOpen(true)` leaves `isSidePanelOpen` false; `setIsSidePanelOpen(true)` leaves `isActionPanelOpen` false; `setActiveSession` round-trips both per session; `setIsActionPanelOpen(true)` clears this session's ready chip.
- [ ] **Step 2: Run** `bun test src/stores/kortix-computer-store.test.ts` → FAIL, `setIsActionPanelOpen is not a function`.
- [ ] **Step 3: Implement.** Add `isActionPanelOpen` and `_actionPanelOpenBySession` to state + `initialState`. `setIsActionPanelOpen` mirrors `setIsSidePanelOpen`'s per-session write but writes **no** width state — `panelSplit`/`panelAspect`/`isExpanded`/`detailOpen` describe a detail's width and the floating panel has none. Extend `setActiveSession` to save/restore `_actionPanelOpenBySession`.
- [ ] **Step 4: Run** → PASS.

**Deviation from spec, deliberate:** the spec said *move* the ready-chip clear off `setIsSidePanelOpen`. Instead **add** it to `setIsActionPanelOpen` and keep the four existing clears (`focusToolCall:275`, `setIsSidePanelOpen:298`, `openSidePanel:354`, `requestQuickView:427`). Opening a deliverable directly is also "seen". Adding cannot strand the dot; moving could.

---

### Task 2: `DetailLayer` gains the persistent layer

**Files:** Modify `apps/web/src/features/session/action-panel/easy/detail-view.tsx`; Test `.../detail-view.test.tsx`

**Produces:**
```ts
export interface PersistentLayer {
  open: boolean;
  /** Crossed the detail edge (crossfade) rather than the home edge (slide). */
  swap: boolean;
  title: string;
  icon?: ReactNode;
  onClose: () => void;
  body: ReactNode;
}
// DetailLayer prop: persistentLayer?: PersistentLayer   (replaces `terminalOpen?: boolean`)
```

- [ ] **Step 1: Failing test** — with `persistentLayer.open` toggled true then false, the slot's body node stays in the DOM across the cycle, while an ordinary `detail` body is removed on close.
- [ ] **Step 2: Run** `bun test src/features/session/action-panel/easy/detail-view.test.tsx` → FAIL.
- [ ] **Step 3: Implement.** Move `terminalLayerMotion` usage into `DetailLayer`. Render the layer as a later sibling of the detail `AnimatePresence`, inside the shared `relative` wrapper, reusing the detail card's exact frame classes. Mount-once latch on first `open`. `covered = detail !== null || !!persistentLayer?.open`. Mobile branch ignores `persistentLayer` — the terminal is its own Drawer there.
- [ ] **Step 4: Run** → PASS. `terminalLayerMotion` and `detailCardVariants` keep their existing unit tests untouched.

---

### Task 3: `SessionPanelProvider`

**Files:** Create `apps/web/src/features/session/action-panel/session-panel-provider.tsx`; Modify `.../easy/easy-panel.tsx`, `.../easy/easy-panel-logic.ts`

**Consumes:** Task 2's `PersistentLayer`.
**Produces:**
```ts
interface SessionPanelValue {
  files: OutputItem[]; context: DerivedContext; apps: OutputItem[];
  outputsDefaultOpen: boolean;
  detail: Detail | null; terminalOpen: boolean; terminalActivated: boolean; terminalSwap: boolean;
  sessionId: string; projectSessionId?: string;
  openDetail(next: Detail): void;
  handleOpenOutput(o: OutputItem, siblings?: OutputItem[], source?: OpenSource): void;
  closeDetail(): void; openTerminal(): void; closeTerminal(): void;
  openBrowser(t?: { url?: string; title?: string }): void;
  openFiles(changes?: boolean): void; openAudit(): void;
}
export function useOptionalSessionPanel(): SessionPanelValue | null;
```

- [ ] **Step 1:** Move state, derivations, all eight openers, and all six consume-effects out of `easy-panel.tsx` into the provider **verbatim**, comments included. Memoize the context value.
- [ ] **Step 2:** Drop `panelOpen` from `shouldAutoOpenPayoff` in `easy-panel-logic.ts` and from its call site. Update `easy-panel-logic.test.ts`.
- [ ] **Step 3:** Reduce `easy-panel.tsx` to the three cards reading from the context.
- [ ] **Step 4: Run** `bun test src/features/session/action-panel/` → PASS.

**Load-bearing:** the six consume-effects subscribe to a store **value**, never a stable action, because the surface stays mounted behind a closed panel. Preserve that exactly — it looks like a missing-dep lint and is not.

---

### Task 4: Side panel becomes detail-only

**Files:** Create `apps/web/src/features/session/action-panel/session-detail-panel.tsx`; Modify `apps/web/src/features/session/session-layout.tsx`

- [ ] **Step 1:** `SessionDetailPanel` renders `<DetailLayer detail persistentLayer>` with no home children on desktop; on mobile it renders today's combined composition (cards as `DetailLayer` children + terminal Drawer).
- [ ] **Step 2:** `session-layout.tsx` mounts `SessionPanelProvider` around the whole `ResizablePanelGroup`; side panel body becomes `SessionDetailPanel`.
- [ ] **Step 3:** `handleVisible` reduces to `handleEnabled` — with the cards gone there is no fixed-width home to hide the grip for.
- [ ] **Step 4:** Repoint `⌘I` (`session-layout.tsx:196-207`) to `toggleActionPanel`.

---

### Task 5: Floating overlay + chevron

**Files:** Create `apps/web/src/features/session/session-action-panel-overlay.tsx`; Modify `apps/web/src/features/session/session-chat.tsx`

- [ ] **Step 1:** Overlay returns `null` when `useOptionalSessionPanel()` is null (covers `sub-session-modal.tsx:49`, which renders `SessionChat` outside `SessionLayout`) and when `useIsMobile()`.
- [ ] **Step 2:** Geometry — `absolute` top-right of the chat area, `w-[380px] max-w-[calc(100vw-2rem)]`, bounded height with internal scroll, `z-20`. Container `pointer-events-none`, cards `pointer-events-auto`. No wrapper background, border, radius, or shadow.
- [ ] **Step 3:** Motion — enter `opacity 0 → 1`, `translateX(8px) → 0` at 200ms `cubic-bezier(0.23, 1, 0.32, 1)`; exit 160ms (80%). `useReducedMotion()` drops the translate, keeps the fade.
- [ ] **Step 4:** Chevron — `absolute` top-right, `CaretDoubleLeftIcon` closed / `CaretDoubleRightIcon` open, `active:scale-[0.96]`, carries the ready-chip dot when the overlay is closed.
- [ ] **Step 5:** Render both in `session-chat.tsx` inside the `relative` root.

---

### Task 6: Delete the header toggle

**Files:** Modify `apps/web/src/features/session/header/session-site-header.tsx`; Test `.../session-site-header.test.tsx`

- [ ] **Step 1:** Delete the `PanelRight` `Button` + its `Hint`/`Kbd` wrapper (`:267-301`), the `PanelRight` import, the ready-chip dot, and the now-dead `onToggleSidePanel` / `isSidePanelOpen` props.
- [ ] **Step 2:** Remove the props at the `session-chat.tsx:3617` call site; drop `handleTogglePanel` if it has no other consumer.
- [ ] **Step 3: Run** `bun test src/features/session/header/` → PASS.

---

### Task 7: Verify

- [ ] `npx eslint` on every changed file — clean.
- [ ] `tsc --noEmit`, grepped to the changed files only (the React 19/18 mismatch emits ~1500 bogus `TS2786`).
- [ ] `bun test` on the touched suites.
- [ ] Browser, per CLAUDE.md — assertions on DOM and network, not screenshots alone:
  1. Chevron opens the overlay; side panel width stays 0.
  2. Header terminal opens the side panel; overlay state unchanged; exactly one card frame in the DOM.
  3. Terminal → file detail → terminal: PTY WebSocket never torn down, scrollback intact.
  4. Browser / file / preview each render inside the detail card.
  5. Run to completion with the side panel closed: payoff opens it once.

---

## Self-review

**Spec coverage.** §1 provider → Task 3. §2 persistent slot → Task 2. §3 two states → Tasks 1, 4, 5, 6. §4 geometry/motion → Task 5. §5 width logic → Task 4 Step 3. §6 file table → all tasks. §7 verification → Task 7.

**Type consistency.** `persistentLayer` names match between Tasks 2 and 4. `handleOpenOutput`'s signature matches its existing definition in `easy-panel.tsx:316`. `OutputItem` / `Detail` are imported, not redefined.

**Known deviation.** Task 1 adds rather than moves the ready-chip clear; rationale recorded in that task.
