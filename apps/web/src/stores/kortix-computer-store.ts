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

  // Panel state — per-session so switching tabs preserves each session's panel state
  shouldOpenPanel: boolean;
  isSidePanelOpen: boolean;
  _panelOpenBySession: Record<string, boolean>;
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
  _actionPanelOpenBySession: Record<string, boolean>;
  _activeSessionId: string | null;
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
  /** The floating action panel. Writes `isActionPanelOpen` and that session's
   *  entry in `_actionPanelOpenBySession` — never any side-panel state. */
  setIsActionPanelOpen: (open: boolean) => void;
  toggleActionPanel: () => void;
  /** Call when a session tab becomes active — restores that session's panel state */
  setActiveSession: (sessionId: string | null) => void;
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
  _panelOpenBySession: {} as Record<string, boolean>,
  isActionPanelOpen: false,
  _actionPanelOpenBySession: {} as Record<string, boolean>,
  _activeSessionId: null as string | null,
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
        if (sessionId) {
          update._panelOpenBySession = {
            ...get()._panelOpenBySession,
            [sessionId]: true,
          };
        }
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
        if (sessionId) {
          update._panelOpenBySession = { ...get()._panelOpenBySession, [sessionId]: open };
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
        if (sessionId) {
          update._actionPanelOpenBySession = {
            ...get()._actionPanelOpenBySession,
            [sessionId]: open,
          };
        }
        set(update);
      },

      toggleActionPanel: () => {
        get().setIsActionPanelOpen(!get().isActionPanelOpen);
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
        // Save current panel state for the previous session. Both surfaces are
        // remembered independently — a user who left session A with the cards
        // up and the detail panel closed must come back to exactly that, not
        // to whichever state session B happened to leave behind.
        const panelMap = { ...get()._panelOpenBySession };
        const actionPanelMap = { ...get()._actionPanelOpenBySession };
        if (prev) {
          panelMap[prev] = get().isSidePanelOpen;
          actionPanelMap[prev] = get().isActionPanelOpen;
        }
        // Restore panel state for the new session (default to false if unseen)
        const restored = sessionId ? (panelMap[sessionId] ?? false) : false;
        const restoredActionPanel = sessionId ? (actionPanelMap[sessionId] ?? false) : false;
        set({
          _activeSessionId: sessionId,
          _panelOpenBySession: panelMap,
          isSidePanelOpen: restored,
          _actionPanelOpenBySession: actionPanelMap,
          isActionPanelOpen: restoredActionPanel,
          // Reset expanded/split/detail state when switching sessions
          isExpanded: false,
          panelSplit: null,
          panelAspect: null,
          detailOpen: false,
        });
      },

      openSidePanel: () => {
        const sessionId = get()._activeSessionId;
        const update: Partial<KortixComputerState> = { isSidePanelOpen: true };
        // Only clear THIS session's own announcement — session B opening its
        // panel must not destroy session A's unseen ready chip.
        if (get().readyChip?.sessionId === sessionId) update.readyChip = null;
        if (sessionId) {
          update._panelOpenBySession = { ...get()._panelOpenBySession, [sessionId]: true };
        }
        set(update);
      },

      closeSidePanel: () => {
        const sessionId = get()._activeSessionId;
        const update: Partial<KortixComputerState> = {
          isSidePanelOpen: false,
          isExpanded: false,
          panelSplit: null,
          panelAspect: null,
          detailOpen: false,
        };
        if (sessionId) {
          update._panelOpenBySession = { ...get()._panelOpenBySession, [sessionId]: false };
        }
        set(update);
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
        // `_activeSessionId` is only maintained for TAB-system sessions
        // (session-layout gates `setActiveSession` on `isActiveTab`) — on the
        // standalone /projects/:id/sessions/:id route it stays null, which
        // silently dropped the pending view (panel opened, terminal never
        // came). Callers that can resolve the active panel session (via
        // session-browser-store's `getActivePanelSessionId`, which IS
        // maintained on every route) pass it explicitly.
        const sessionId = explicitSessionId ?? get()._activeSessionId;
        const update: Partial<KortixComputerState> = { isSidePanelOpen: true };
        // Only clear THIS session's own announcement — same rule every other
        // panel-opening action follows (see `focusToolCall`/`openSidePanel`).
        if (get().readyChip?.sessionId === sessionId) update.readyChip = null;
        if (sessionId) {
          update._panelOpenBySession = { ...get()._panelOpenBySession, [sessionId]: true };
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

export const useIsExpanded = () => useKortixComputerStore((state) => state.isExpanded);

export const useToggleExpanded = () => useKortixComputerStore((state) => state.toggleExpanded);

// Ready chip state selectors
export const useReadyChip = () => useKortixComputerStore((state) => state.readyChip);

export const useClearReadyChip = () => useKortixComputerStore((state) => state.clearReadyChip);
