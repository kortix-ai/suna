import { useFilesStore } from '@/features/files';
import { useFilePreviewStore } from '@/stores/file-preview-store';
import { create } from 'zustand';
import { devtools } from 'zustand/middleware';

const HIDE_BROWSER_TAB = true;

/** How long a quick-view request stays honorable. Long enough for a mount +
 *  paint on a slow machine, far too short to replay on a later visit. */
export const QUICK_VIEW_TTL_MS = 10_000;

export type ViewType = 'tools' | 'files' | 'browser' | 'desktop' | 'terminal' | 'changes';

export type ReadyChipOutcome = 'ready' | 'failed' | 'stopped' | 'needs_input';

export interface ReadyChipState {
  sessionId: string;
  outcome: ReadyChipOutcome;
  /** Deliverable count behind the chip (0 for needs_input). */
  count: number;
  /** Human name of the primary deliverable, when there is one. */
  primaryName?: string;
}

/** The panel surfaces reachable from outside the panel. */
export type QuickView = 'terminal' | 'audit' | 'browser' | 'files';

/**
 * Extra aim for a quick-view request — "open the browser" vs "open the browser
 * ON THIS URL".
 *
 * Without it, every caller that knows WHICH page/tab it wants had to write
 * `viewBySession` directly to get there. That key is only read by Advanced
 * mode, so in Easy — the only mode that ships — those writes rendered nothing:
 * the panel opened on the Easy home and the target was dropped. The preview
 * button, localhost links in chat, and both header chips all failed this way.
 */
export interface QuickViewTarget {
  /** `browser`: open at this URL instead of the first running app. */
  url?: string;
  /** `browser`: tab/preview title for the URL above. */
  title?: string;
  /** `files`: land on the Changes diff rather than All files. */
  changes?: boolean;
}

interface KortixComputerState {
  // Main view state
  activeView: ViewType;

  // Panel state. NOT per-session: every session change lands with both right
  // surfaces closed — see `setActiveSession`.
  shouldOpenPanel: boolean;
  isSidePanelOpen: boolean;
  /**
   * The FLOATING action panel — the Outputs/Context/Preview cards overlaying
   * the chat, anchored top right. Entirely separate from `isSidePanelOpen`,
   * which governs the right-hand DETAIL panel (terminal / browser / files /
   * file preview).
   *
   * The two must never move together. Before the split they were one flag,
   * because the cards and the details lived in the same `ResizablePanel` —
   * opening the cards WAS opening the panel. Now: this flag is written by the
   * chat's chevron and by nothing else, while `isSidePanelOpen` is
   * written only by things that produce a detail to look at. Any future action
   * that writes both is the bug this split exists to remove.
   *
   * Deliberately carries none of the width state (`panelSplit`/`panelAspect`/
   * `isExpanded`/`detailOpen`): those describe how wide an open DOCUMENT wants
   * the split to be, and a fixed-width floating overlay has no split to size.
   */
  isActionPanelOpen: boolean;
  _activeSessionId: string | null;
  /**
   * Per session: does that session's detail panel still HOLD something to show
   * (a file/app/step/audit detail, or the terminal layer)?
   *
   * Written by `SessionPanelProvider`, which owns that content in React state.
   * Read by `toggleRightPanel` alone, to answer "what does reopening the right
   * side bring back".
   *
   * It is NOT an open/closed flag. ⌘I closes the panel WITHOUT discarding the
   * provider's content, so this stays true while the panel is down — which is
   * exactly what lets the next press restore it. It goes false on the two
   * events that really do destroy the content: the detail's own close button
   * or Escape, and leaving the session.
   */
  _detailContentBySession: Record<string, boolean>;
  isExpanded: boolean;
  // Easy mode only — the side panel's requested share of the split, as a
  // percentage, when a layer wants more than the default 35/65 card column:
  // 70 while a presentation deliverable is open (the deck needs real width),
  // 50 while the terminal layer is open (a shell earns an even split), null
  // for the default. Ignored in Advanced (its 50/50 story is untouched) and
  // outranked by `isExpanded` (fullscreen wins over any split).
  panelSplit: number | null;
  // Easy mode only — the open document's own aspect ratio (width / height),
  // set once a renderer reports its intrinsic size. Not a split percentage
  // itself: it is meant to be fed through `fitSplitPercent` (in
  // `easy-panel-logic.ts`) to compute one, which is designed to outrank
  // `panelSplit` — a document that knows its own shape should beat the fixed
  // 35/70 guess. null before any measurement lands, or once one is no longer
  // trustworthy (e.g. the detail closed). Ignored in Advanced mode, same as
  // `panelSplit`.
  panelAspect: number | null;
  // Whether the Easy panel is showing a DETAIL (a file/app/step/audit detail
  // or the terminal layer) rather than the card home. Synced by `EasyPanel`;
  // `session-layout` reads it to show the resize grip only while a detail is
  // open — the card home is a fixed-width column with nothing to resize.
  // Ignored in Advanced mode.
  detailOpen: boolean;
  // Transient: rides along with the NEXT `isExpanded`/`panelSplit` change to
  // tell the panel layout to snap instead of animate. Set only when a
  // detail-close collapses fullscreen or drops out of wide (the detail plays
  // its own slide-out — animating the panel width underneath it reads as a
  // second, competing motion). Consumed and cleared by the layout effect that
  // performs the resize.
  skipNextExpandAnimation: boolean;

  // Tool navigation state (for external tool click triggers)
  pendingToolNavIndex: number | null;

  // Side-panel Actions focus — the tool callID the panel should jump to when
  // the user clicks a tool call in the chat. By callID (not index) so it stays
  // correct regardless of ordering.
  focusedToolCallId: string | null;

  // W1 — the deliverable announces itself while the panel is closed.
  readyChip: ReadyChipState | null;
  // Chip tap → open the panel WITH the primary deliverable already open.
  pendingPrimaryOpenSessionId: string | null;

  // Command-palette "Open Terminal"/"Open Audit"/"Open Browser" → open the
  // panel WITH that detail already showing. Session-scoped and one-shot, same
  // contract as `pendingPrimaryOpenSessionId`/`consumePrimaryOpen` above —
  // EasyPanel stays mounted behind a closed panel on desktop, so this must be
  // a changing STORE VALUE the consume effect subscribes to, not a stable
  // action reference.
  pendingQuickView: {
    sessionId: string;
    view: QuickView;
    /** When the request was made — consume discards anything older than
     *  {@link QUICK_VIEW_TTL_MS}. A quick-view is a "right now" intent; a
     *  request that couldn't be consumed promptly must never replay later
     *  (the "terminal randomly pops up" bug). */
    requestedAt: number;
    /** Optional aim for the request — see {@link QuickViewTarget}. */
    target?: QuickViewTarget;
  } | null;

  // Mobile dev tools (header's Developer Tools / command palette): the tool
  // opens in its own top-level drawer (`MobileToolDrawer`), fully decoupled
  // from the Easy/Advanced panel — no `isSidePanelOpen`, no pending consume.
  // Closing the drawer lands back on chat. Desktop never sets this.
  mobileToolView: QuickView | null;

  // === ACTIONS ===

  setActiveView: (view: ViewType) => void;

  // For external triggers (clicking file in chat) — delegates to useFilesStore + opens panel
  openFileInComputer: (filePath: string, filePathList?: string[], targetLine?: number) => void;

  // Open files browser without selecting a file — delegates to useFilesStore + opens panel
  openFileBrowser: () => void;

  // Navigate to a specific tool call (clicking tool in ThreadContent)
  navigateToToolCall: (toolIndex: number) => void;

  // Clear pending tool nav after KortixComputer processes it
  clearPendingToolNav: () => void;

  // Open the side panel (Actions view) focused on a specific tool call.
  focusToolCall: (callId: string) => void;
  // Clear the focus request after the panel has jumped to it.
  clearFocusedToolCall: () => void;

  // Panel control
  clearShouldOpenPanel: () => void;
  setIsSidePanelOpen: (open: boolean) => void;
  /** The floating action panel. Writes `isActionPanelOpen` and nothing else —
   *  never any side-panel state. */
  setIsActionPanelOpen: (open: boolean) => void;
  toggleActionPanel: () => void;
  /**
   * ⌘I / Ctrl+I — the ONE toggle for the whole right side.
   *
   * The two surfaces stay independent in state (see `isActionPanelOpen`), but
   * the user sees one thing: whatever is currently docked to the right of the
   * chat. So this reads them together:
   *
   * - anything open (cards, a detail, or cards behind a detail) → close BOTH.
   * - nothing open, this session still holds detail content → reopen that
   *   detail. "Open and close generally whatever was last open."
   * - nothing open, nothing held → open the action panel. It is the default
   *   right-side surface, and the only one with an empty-open state a key
   *   press can reach.
   *
   * The memory is SESSION-SCOPED and dies with the session, which is the whole
   * reconciliation of the two rules this went through: within a session ⌘I is
   * a minimise/restore pair, so closing a browser and pressing again brings the
   * browser back; leave the session and come back and there is nothing to
   * restore, so it opens the cards. A detail you last saw on another page is
   * never what a key press resurrects.
   *
   * Deliberately NOT `toggleActionPanel` + a second binding: two hotkeys for
   * one visual region is the bug this replaces.
   */
  toggleRightPanel: () => void;
  /** Call when a session becomes visible. Both right surfaces close — panel
   *  state never travels between sessions. */
  setActiveSession: (sessionId: string | null) => void;
  /** `SessionPanelProvider` publishing whether `sessionId`'s detail panel holds
   *  content. Pass `null` to forget the session (the provider unmounted). */
  setDetailContent: (sessionId: string, has: boolean | null) => void;
  openSidePanel: () => void;
  closeSidePanel: () => void;
  /** `animate: false` snaps the panel to its new width with no transition —
   *  used when leaving a detail, so its own slide-out isn't doubled by a
   *  competing width animation. Omitted/`true` keeps the expand/collapse glide
   *  (the deliberate fullscreen/minimize toggles). */
  setIsExpanded: (expanded: boolean, opts?: { animate?: boolean }) => void;
  toggleExpanded: () => void;
  /** Easy mode only. `animate: false` snaps the panel to its new width with
   *  no transition — same contract as `setIsExpanded`'s `opts.animate`, and
   *  it shares the very same `skipNextExpandAnimation` flag: the layout only
   *  needs to know THAT the next width change should snap, not which of the
   *  two states caused it. */
  setPanelSplit: (split: number | null, opts?: { animate?: boolean }) => void;
  /** Mirrors `setPanelSplit` exactly — same `animate` contract, same shared
   *  `skipNextExpandAnimation` flag. */
  setPanelAspect: (aspect: number | null, opts?: { animate?: boolean }) => void;
  setDetailOpen: (open: boolean) => void;

  // Ready chip state management
  setReadyChip: (chip: ReadyChipState) => void;
  clearReadyChip: () => void;
  requestPrimaryOpen: (sessionId: string) => void;
  consumePrimaryOpen: (sessionId: string) => boolean;

  /** Command palette → open the ACTIVE session's panel to `view` (terminal,
   *  audit, or browser). Resolves the session from `_activeSessionId` (not a
   *  param) — the palette has no reliable way to name the active session
   *  itself, see `command-palette.tsx`'s handler comment. Also opens the panel
   *  the same way `focusToolCall` does: `isSidePanelOpen` true, the
   *  per-session map updated, and this session's own ready chip cleared. */
  requestQuickView: (view: QuickView, explicitSessionId?: string, target?: QuickViewTarget) => void;
  /** One-shot, session-scoped consume — mirrors `consumePrimaryOpen`. Returns
   *  the requested view (and any target that came with it) when it belonged to
   *  `sessionId`, else null. */
  consumeQuickView: (
    sessionId: string,
    now?: number,
  ) => { view: QuickView; target?: QuickViewTarget } | null;

  /** Mobile only — open `view` in the standalone tool drawer. */
  openMobileTool: (view: QuickView) => void;
  closeMobileTool: () => void;

  // Reset all state (full reset)
  reset: () => void;
}

const initialState = {
  activeView: 'tools' as ViewType,
  shouldOpenPanel: false,
  isSidePanelOpen: false,
  isActionPanelOpen: false,
  _activeSessionId: null as string | null,
  _detailContentBySession: {} as Record<string, boolean>,
  isExpanded: false,
  panelSplit: null as number | null,
  panelAspect: null as number | null,
  detailOpen: false,
  skipNextExpandAnimation: false,
  pendingToolNavIndex: null as number | null,
  focusedToolCallId: null as string | null,
  readyChip: null as ReadyChipState | null,
  pendingPrimaryOpenSessionId: null as string | null,
  pendingQuickView: null as {
    sessionId: string;
    view: QuickView;
    requestedAt: number;
    target?: QuickViewTarget;
  } | null,
  mobileToolView: null as QuickView | null,
};

export const useKortixComputerStore = create<KortixComputerState>()(
  devtools(
    (set, get) => ({
      ...initialState,

      setActiveView: (view: ViewType) => {
        // If browser tab is hidden and trying to set browser view, default to tools
        const effectiveView = HIDE_BROWSER_TAB && view === 'browser' ? 'tools' : view;
        // Terminal and Desktop are now in the right sidebar - redirect to tools
        const finalView =
          effectiveView === 'terminal' || effectiveView === 'desktop' || effectiveView === 'changes'
            ? 'tools'
            : effectiveView;
        set({ activeView: finalView });
      },

      openFileInComputer: (filePath: string, _filePathList?: string[], targetLine?: number) => {
        // Open the file in the global preview dialog (same as clicking a file
        // in the explorer / a path in chat).
        useFilePreviewStore.getState().openPreview(filePath, targetLine);
      },

      openFileBrowser: () => {
        // Delegate file state to the unified files store
        useFilesStore.getState().navigateToPath('.');

        set({
          activeView: 'tools',
          shouldOpenPanel: true,
        });
      },

      navigateToToolCall: (toolIndex: number) => {
        set({
          activeView: 'tools',
          pendingToolNavIndex: toolIndex,
          shouldOpenPanel: true,
        });
      },

      clearPendingToolNav: () => {
        set({ pendingToolNavIndex: null });
      },

      focusToolCall: (callId: string) => {
        const sessionId = get()._activeSessionId;
        const update: Partial<KortixComputerState> = {
          focusedToolCallId: callId,
          activeView: 'tools',
          isSidePanelOpen: true,
        };
        // Only clear THIS session's own announcement — session B opening its
        // panel must not destroy session A's unseen ready chip.
        if (get().readyChip?.sessionId === sessionId) update.readyChip = null;
        set(update);
      },

      clearFocusedToolCall: () => {
        set({ focusedToolCallId: null });
      },

      clearShouldOpenPanel: () => {
        set({ shouldOpenPanel: false });
      },

      setIsSidePanelOpen: (open: boolean) => {
        const sessionId = get()._activeSessionId;
        const update: Partial<KortixComputerState> = { isSidePanelOpen: open };
        // Only clear THIS session's own announcement — session B opening its
        // panel must not destroy session A's unseen ready chip.
        if (open && get().readyChip?.sessionId === sessionId) update.readyChip = null;
        // Every REAL close path routes through here (the detail's own close
        // button/Escape, mobile drawer dismiss) — reset the width states or a stale
        // `panelSplit`/`isExpanded` survives into the next open. Snap, not
        // glide: the panel is disappearing; animating widths under a hidden
        // panel is pointless, and the next open's resize effect must read
        // clean state. `closeSidePanel`/`handleSidePanelClose` stay harmless
        // and idempotent on top of this.
        if (!open) {
          update.panelSplit = null;
          update.panelAspect = null;
          update.isExpanded = false;
          update.detailOpen = false;
          update.skipNextExpandAnimation = true;
        }
        set(update);
      },

      setIsActionPanelOpen: (open: boolean) => {
        const sessionId = get()._activeSessionId;
        const update: Partial<KortixComputerState> = { isActionPanelOpen: open };
        // The ready chip's dot lives on the chevron that drives this flag, so
        // opening the floating panel is what dismisses it. Note this is an
        // ADDITIONAL clear, not a moved one: the side-panel actions still clear
        // it too, because opening the deliverable itself also counts as having
        // seen it. Only THIS session's announcement — session B opening its
        // panel must not destroy session A's unseen chip (same rule as
        // `setIsSidePanelOpen`/`focusToolCall`/`openSidePanel`).
        if (open && get().readyChip?.sessionId === sessionId) update.readyChip = null;
        // No width state touched on close, unlike `setIsSidePanelOpen`:
        // `panelSplit`/`panelAspect`/`isExpanded`/`detailOpen` belong to the
        // detail panel's split, which this overlay is not part of. Clearing
        // them here would collapse an open detail's width from an unrelated
        // surface's toggle.
        set(update);
      },

      toggleActionPanel: () => {
        get().setIsActionPanelOpen(!get().isActionPanelOpen);
      },

      toggleRightPanel: () => {
        const { isSidePanelOpen, isActionPanelOpen, _activeSessionId } = get();

        if (isSidePanelOpen || isActionPanelOpen) {
          // Both down together — the user asked for the right side to go away,
          // and leaving the cards behind a just-closed detail is the "it didn't
          // close" bug. Widths reset the same way every other close path resets
          // them, and snap rather than glide — the panel is leaving, so there
          // is nothing to animate under.
          //
          // `detailOpen` and `_detailContentBySession` are deliberately NOT
          // touched: this is a minimise, not a discard. The provider keeps the
          // detail, and that is what the next press brings back.
          set({
            isSidePanelOpen: false,
            isActionPanelOpen: false,
            isExpanded: false,
            panelSplit: null,
            panelAspect: null,
            skipNextExpandAnimation: true,
          });
          return;
        }

        // Reopen what this session was last showing. The map only ever holds
        // the CURRENT session's live content (the provider clears it on the way
        // out — see `SessionPanelProvider`), so this can never resurrect a
        // detail from a page the user has since left.
        const hasDetail = _activeSessionId
          ? (get()._detailContentBySession[_activeSessionId] ?? false)
          : false;
        if (hasDetail) get().openSidePanel();
        else get().setIsActionPanelOpen(true);
      },

      setActiveSession: (sessionId: string | null) => {
        // A quick-view is an intent about the session it was made in — it must
        // not replay when some other session mounts later. Cleared even on the
        // no-op re-activation path below, or a request planted for another
        // session (explicitSessionId) would survive it.
        const pendingQuickView = get().pendingQuickView;
        if (pendingQuickView && pendingQuickView.sessionId !== sessionId) {
          set({ pendingQuickView: null });
        }
        const prev = get()._activeSessionId;
        if (prev === sessionId) return;
        // EVERY session change lands closed. Both surfaces, no exceptions, no
        // per-session memory.
        //
        // This used to restore each session's remembered panel state, which is
        // where the "new session opens on a loading panel" bug lived: panel
        // state outlived the session it belonged to, so session B inherited
        // session A's open detail panel and rendered it with nothing in it —
        // B's provider has no detail of its own to show. Restoring correctly
        // is not worth defending; a session you have just navigated to is a
        // session you have not asked anything of yet, so the right side has
        // nothing to say and should not be on screen.
        //
        // The detail CONTENT map survives on purpose: a tab kept mounted in
        // the background still holds its detail, so returning to it and
        // pressing ⌘I brings that back rather than the empty card home.
        set({
          _activeSessionId: sessionId,
          isSidePanelOpen: false,
          isActionPanelOpen: false,
          isExpanded: false,
          panelSplit: null,
          panelAspect: null,
          detailOpen: false,
          // Snap. The outgoing session's width must not glide away under the
          // incoming one's first paint.
          skipNextExpandAnimation: true,
          // The same rule applied to every OTHER request that can outlive the
          // session that made it. Each of these is a global one-shot consumed
          // by whichever layout/provider is mounted, so a request made in
          // session A and not consumed before the user left would be picked up
          // by session B — opening B's panel on a tool call B does not have, or
          // on nothing at all. A pending intent belongs to the session that
          // made it and dies with it. (`pendingQuickView` is handled above: it
          // carries its own session id, so it survives a switch TO its own
          // session and is dropped for any other. `readyChip` is deliberately
          // untouched — announcing a finished deliverable across sessions is
          // the entire point of it.)
          shouldOpenPanel: false,
          focusedToolCallId: null,
          pendingToolNavIndex: null,
          // A tool drawer belonging to the session the user just left.
          mobileToolView: null,
          // The ⌘I restore memory dies with the session. Within a session the
          // key is a minimise/restore pair; across one it is not, and a detail
          // last seen on a page the user has navigated away from must never be
          // what a key press brings back.
          //
          // Cleared wholesale rather than per session id, and stated HERE
          // rather than left to the providers: every mounted provider drops its
          // own detail on this same change and republishes, so the two agree —
          // but the rule holds even if a provider is slow, unmounted, or never
          // mounted at all.
          _detailContentBySession: {},
        });
      },

      setDetailContent: (sessionId: string, has: boolean | null) => {
        const map = get()._detailContentBySession;

        // An open detail panel may never outlive the content that justified
        // it. `setActiveSession` already lands every session change closed,
        // but it returns early when the id is UNCHANGED — and unchanged is
        // exactly the case that broke: leave a session for /connectors or
        // /skills and come back, and it is the same session id, so none of
        // that reset runs. What did run is this provider's unmount cleanup
        // (`setDetailContent(sessionId, null)`), so the content went away
        // while `detailOpen` stayed true. The panel came back open, over a
        // provider with nothing in it, and rendered blank.
        //
        // Enforcing it HERE rather than at the navigation makes it an
        // invariant instead of a patch: this is the single point where
        // "does this session have detail content" changes, so there is no
        // second route into the broken state to remember later.
        const losingDetail = has === null || has === false;
        const isActive = get()._activeSessionId === sessionId;
        const closeDetail = losingDetail && isActive && get().detailOpen;

        if (has === null) {
          if (!(sessionId in map)) {
            if (closeDetail) set({ detailOpen: false });
            return;
          }
          const next = { ...map };
          delete next[sessionId];
          set({ _detailContentBySession: next, ...(closeDetail ? { detailOpen: false } : {}) });
          return;
        }
        if (map[sessionId] === has) {
          if (closeDetail) set({ detailOpen: false });
          return;
        }
        set({
          _detailContentBySession: { ...map, [sessionId]: has },
          ...(closeDetail ? { detailOpen: false } : {}),
        });
      },


      openSidePanel: () => {
        const sessionId = get()._activeSessionId;
        const update: Partial<KortixComputerState> = { isSidePanelOpen: true };
        // Only clear THIS session's own announcement — session B opening its
        // panel must not destroy session A's unseen ready chip.
        if (get().readyChip?.sessionId === sessionId) update.readyChip = null;
        set(update);
      },

      closeSidePanel: () => {
        set({
          isSidePanelOpen: false,
          isExpanded: false,
          panelSplit: null,
          panelAspect: null,
          detailOpen: false,
        });
      },

      setIsExpanded: (expanded: boolean, opts?: { animate?: boolean }) => {
        set({ isExpanded: expanded, skipNextExpandAnimation: opts?.animate === false });
      },

      toggleExpanded: () => {
        // The deliberate fullscreen/minimize button — always glides.
        set((state) => ({ isExpanded: !state.isExpanded, skipNextExpandAnimation: false }));
      },

      setPanelSplit: (split: number | null, opts?: { animate?: boolean }) => {
        set({ panelSplit: split, skipNextExpandAnimation: opts?.animate === false });
      },

      setPanelAspect: (aspect: number | null, opts?: { animate?: boolean }) => {
        set({ panelAspect: aspect, skipNextExpandAnimation: opts?.animate === false });
      },

      setDetailOpen: (open: boolean) => {
        if (get().detailOpen !== open) set({ detailOpen: open });
      },

      setReadyChip: (chip: ReadyChipState) => {
        set({ readyChip: chip });
      },

      clearReadyChip: () => {
        if (get().readyChip) set({ readyChip: null });
      },

      requestPrimaryOpen: (sessionId: string) => {
        set({ pendingPrimaryOpenSessionId: sessionId });
      },

      consumePrimaryOpen: (sessionId: string) => {
        if (get().pendingPrimaryOpenSessionId !== sessionId) return false;
        set({ pendingPrimaryOpenSessionId: null });
        return true;
      },

      requestQuickView: (view: QuickView, explicitSessionId?: string, target?: QuickViewTarget) => {
        // `_activeSessionId` is maintained on every route now (session-layout
        // calls `setActiveSession` whenever a layout is the visible one, not
        // just for the active TAB). Callers that can resolve the panel session
        // themselves — via session-browser-store's `getActivePanelSessionId` —
        // still pass it explicitly, which stays the more direct answer.
        const sessionId = explicitSessionId ?? get()._activeSessionId;
        const update: Partial<KortixComputerState> = { isSidePanelOpen: true };
        // Only clear THIS session's own announcement — same rule every other
        // panel-opening action follows (see `focusToolCall`/`openSidePanel`).
        if (get().readyChip?.sessionId === sessionId) update.readyChip = null;
        if (sessionId) {
          update.pendingQuickView = { sessionId, view, requestedAt: Date.now(), target };
        }
        set(update);
      },

      consumeQuickView: (sessionId: string, now: number = Date.now()) => {
        const pending = get().pendingQuickView;
        if (!pending || pending.sessionId !== sessionId) return null;
        set({ pendingQuickView: null });
        if (now - pending.requestedAt > QUICK_VIEW_TTL_MS) return null;
        return { view: pending.view, target: pending.target };
      },

      openMobileTool: (view: QuickView) => {
        set({ mobileToolView: view });
      },
      closeMobileTool: () => {
        set({ mobileToolView: null });
      },

      reset: () => {
        console.log('[KortixComputerStore] Full reset');
        useFilesStore.getState().reset();
        set(initialState);
      },
    }),
    {
      name: 'kortix-computer-store',
      /**
       * Persist the ONE durable preference and nothing else.
       *
       * There was no `partialize`, so zustand wrote the whole state to
       * localStorage — including `detailOpen`, `isSidePanelOpen`,
       * `_activeSessionId`, `_detailContentBySession`, `focusedToolCallId`
       * and the one-shot flags. On the next load the panel reopened against a
       * session whose provider had not mounted yet and had nothing to show:
       * an open, blank panel, restored from disk.
       *
       * None of it deserved persisting. `setActiveSession` already resets
       * `panelSplit`, `panelAspect`, `isExpanded` and `detailOpen` on every
       * session change, so persisting them could only ever restore a value
       * that the next session change throws away. The `_`-prefixed fields are
       * internal bookkeeping about what is mounted RIGHT NOW, which is the
       * one kind of state that must never survive the process that observed
       * it. `pendingQuickView`, `readyChip`, `pendingToolNavIndex`,
       * `focusedToolCallId` and `skipNextExpandAnimation` are one-shot
       * intents; a stale one firing on load is a request the user made in
       * another session, possibly days ago.
       *
       * `activeView` survives because it is a genuine preference — which tab
       * of the panel you like — and it is content-independent: it decides
       * what the panel shows once something opens it, never whether anything
       * opens.
       */
      partialize: (state: KortixComputerState) => ({ activeView: state.activeView }),
    },
  ),
);

// === SELECTOR HOOKS ===

// Main view state
export const useKortixComputerActiveView = () =>
  useKortixComputerStore((state) => state.activeView);

// Individual selectors for pending tool navigation (stable primitives)
export const useKortixComputerPendingToolNavIndex = () =>
  useKortixComputerStore((state) => state.pendingToolNavIndex);

export const useKortixComputerClearPendingToolNav = () =>
  useKortixComputerStore((state) => state.clearPendingToolNav);

// Side-panel Actions focus (clicking a tool call in chat)
export const useFocusedToolCallId = () =>
  useKortixComputerStore((state) => state.focusedToolCallId);

export const useClearFocusedToolCall = () =>
  useKortixComputerStore((state) => state.clearFocusedToolCall);

// Side panel state selectors
export const useIsSidePanelOpen = () => useKortixComputerStore((state) => state.isSidePanelOpen);

export const useSetIsSidePanelOpen = () =>
  useKortixComputerStore((state) => state.setIsSidePanelOpen);

// Floating action panel (the cards over the chat) — deliberately its own pair
// of hooks, so a component reaching for one surface can never accidentally
// subscribe to, or write, the other.
export const useIsActionPanelOpen = () =>
  useKortixComputerStore((state) => state.isActionPanelOpen);

export const useToggleActionPanel = () =>
  useKortixComputerStore((state) => state.toggleActionPanel);

/** ⌘I / Ctrl+I — the single right-side toggle. See `toggleRightPanel`. */
export const useToggleRightPanel = () =>
  useKortixComputerStore((state) => state.toggleRightPanel);

export const useIsExpanded = () => useKortixComputerStore((state) => state.isExpanded);

export const useToggleExpanded = () => useKortixComputerStore((state) => state.toggleExpanded);

// Ready chip state selectors
export const useReadyChip = () => useKortixComputerStore((state) => state.readyChip);

export const useClearReadyChip = () => useKortixComputerStore((state) => state.clearReadyChip);
