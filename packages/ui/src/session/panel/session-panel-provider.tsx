'use client';

import { useTranslations } from '../../i18n';
/**
 * `SessionPanelProvider` — the single owner of everything a session's panel
 * surfaces show, hoisted above BOTH of them.
 *
 * The two surfaces live on opposite sides of the screen and in different React
 * subtrees: the Outputs/Context/Preview cards float over the chat (inside
 * `SessionChat`, in the main resizable panel), and every detail — terminal,
 * browser, files, file preview — renders in the right-hand detail panel. A row
 * clicked in the cards has to open a detail on the other side of that divide,
 * so the state cannot live in either one. It lives here, mounted at
 * `SessionLayout`, wrapping both.
 *
 * This is a MOVE, not a rewrite. Everything below came out of `easy-panel.tsx`
 * — which owned the cards and the detail together, back when they were the same
 * panel — with its comments intact. Two behaviors are load-bearing and easy to
 * "clean up" by mistake:
 *
 *  1. Every consume-effect subscribes to a store VALUE, never to the (stable)
 *     consume action. Both surfaces stay mounted while their panel is closed,
 *     so a request that only flipped a stable reference would never re-render
 *     anyone and the handoff would silently dead-end.
 *  2. The terminal is not a `detail`. It is a keep-alive layer with its own
 *     open flag, because `DetailLayer` tears a detail's body down on close and
 *     that would drop a live PTY WebSocket. See `PersistentLayer`.
 */

import { SessionAuditPanel } from './session-audit-panel';
import { SessionRemindersPanel } from './session-reminders-panel';
import { SessionFilesExplorer } from './session-files-explorer';
import { useSandboxProxy } from '../../internal/hooks/use-sandbox-proxy';
import { useIsMobile } from '../../hooks/use-mobile';
import { track } from '../../lib/telemetry';
import { parseLocalhostUrl } from '@kortix/sdk';
import {
  useKortixComputerStore,
} from '../../internal/stores/kortix-computer-store';
import { usePresentationViewerStore } from '../../files/renderers/presentation/presentation-viewer-store';
import { useSessionBrowserStore } from '../../internal/stores/session-browser-store';
import { useSessionComposerPrefillStore } from '../composer/stores/session-composer-prefill-store';
import {
  panelToRestore,
  rememberedPanelOf,
  useSessionPanelMemoryStore,
} from '../../internal/stores/session-panel-memory-store';
import { useUserPreferencesStore } from '../../internal/stores/user-preferences-store';
import { getProjectSession, SANDBOX_PORTS } from '@kortix/sdk';
import { qk } from '@kortix/sdk/react';
import { FileTextIcon as FileText } from '@phosphor-icons/react';
import { useQueryClient } from '@tanstack/react-query';
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { AppPreview } from './easy/app-preview';
import type { Detail } from './easy/detail-view';
import {
  isWideDeliverable,
  neighborOutputs,
  outputKey,
  quickBrowserOutput,
} from './easy/easy-panel-logic';
import { FilePreview, reportsIntrinsicSize } from './easy/file-preview';
import { type deriveContext, type OutputItem } from './shared/derive-panels';
import { usePanelDerivations } from './shared/use-panel-derivations';
import { usePanelHandoffs } from './shared/use-panel-handoffs';
import { useDeliverableReadiness } from './shared/use-deliverable-readiness';

/** Where an open was triggered from. Telemetry only (W5) — never read for
 *  behavior, only reported alongside `deliverable_opened`. */
export type OpenSource = 'row' | 'auto' | 'chip' | 'nav' | 'quick' | 'restore';

/** How long a remembered file preview waits for the transcript to derive its output. */
const FILE_RESTORE_WAIT_MS = 10_000;

export interface SessionPanelValue {
  sessionId: string;
  projectId?: string;
  projectSessionId?: string;

  /** Card data — everything the floating overlay renders. */
  files: OutputItem[];
  context: ReturnType<typeof deriveContext>;
  apps: OutputItem[];
  outputsDefaultOpen: boolean;

  /** Detail-panel state — everything the side panel renders. */
  detail: Detail | null;
  terminalOpen: boolean;
  terminalSwap: boolean;

  openDetail: (next: Detail) => void;
  handleOpenOutput: (output: OutputItem, siblings?: OutputItem[], source?: OpenSource) => void;
  closeDetail: () => void;
  openTerminal: () => void;
  closeTerminal: () => void;
  openBrowser: (target?: { url?: string; title?: string }) => void;
  openFiles: (changes?: boolean) => void;
  openAudit: () => void;
  openReminders: () => void;
}

/**
 * Exported so a test can inject a stub value and render the cards (or
 * `ActionPanel`) without standing up the whole provider — which pulls in the
 * sandbox proxy, react-query and four stores for behavior those tests are not
 * about. That seam is the main practical dividend of hoisting the state here.
 */
export const SessionPanelContext = createContext<SessionPanelValue | null>(null);

/**
 * The panel value, or null outside a provider.
 *
 * Optional on purpose, exactly as `useOptionalSidebar` is: `SessionChat` has a
 * second call site in `sub-session-modal.tsx` that renders it read-only and
 * OUTSIDE `SessionLayout`. The floating overlay self-gates to null there rather
 * than every call site having to know which tree it is in.
 */
export function useOptionalSessionPanel(): SessionPanelValue | null {
  return useContext(SessionPanelContext);
}

export function SessionPanelProvider({
  sessionId,
  isSessionBusy = false,
  projectId,
  projectSessionId,
  children,
}: {
  /** The runtime session id: the root thread of the session log. */
  sessionId: string;
  /** The session's own busy/retry status — see `deriveIsRunning`. */
  isSessionBusy?: boolean;
  /** Route ids the Audit detail needs to resolve a session's audit trail —
   *  see `session-audit-shared.ts`. Absent while booting/transient, in which
   *  case the palette's "Open Audit" consume below becomes a no-op. */
  projectId?: string;
  projectSessionId?: string;
  children: ReactNode;
}) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const tReminders = useTranslations('reminders');
  const { steps, outputs, context, apps, files, isRunning, outcome } = usePanelDerivations({
    sessionId, projectId, projectSessionId, isSessionBusy,
  });

  // The provider owns the detail because the two surfaces that need it are in
  // different subtrees — see this file's header.
  const [detail, setDetail] = useState<Detail | null>(null);

  // Leaving a detail always returns to the home cards, so it must also drop the
  // panel out of fullscreen — the store `isExpanded` a detail entered when the
  // app/file was maximized. Without this the panel stays pinned at 100% width
  // and renders full-bleed instead of snapping back to the resizable split;
  // worse, "Ask for changes" targets the chat composer, which fullscreen has
  // collapsed to zero width.
  // Only the exits route through here. Paging between siblings does NOT: the
  // prev/next closures call `handleOpenOutput` again, which reaches `setDetail`
  // through `openDetail` — so fullscreen survives the move from one deliverable
  // to the next, and so does the panel width when both sides measure (see
  // `openDetail`'s `measures` check).
  const setIsExpanded = useKortixComputerStore((s) => s.setIsExpanded);
  // Split override: a presentation deliverable grows the panel to its widest
  // split (70/30, Marko's feedback) and the terminal layer to an even 50/50,
  // instead of the default — see `isWideDeliverable`/`handleOpenOutput`/
  // `openTerminal` below. `panelSplit` mirrors `isExpanded`'s shape exactly
  // (same store, same `animate` opt, same `skipNextExpandAnimation` flag) —
  // see the store's doc comment.
  const setPanelSplit = useKortixComputerStore((s) => s.setPanelSplit);
  // The measured shape of whatever document is open, which outranks
  // `panelSplit` once it lands (see `resolveSideSize`). Cleared in lockstep
  // with every `panelSplit` write below — a ratio that outlives the document
  // it was measured from would silently win over the split the new layer
  // asked for, so the two states are never allowed to disagree.
  const setPanelAspect = useKortixComputerStore((s) => s.setPanelAspect);
  const setIsSidePanelOpen = useKortixComputerStore((s) => s.setIsSidePanelOpen);

  const closeDetail = useCallback(() => {
    setDetail(null);
    // The detail panel is content-driven: with nothing to show it has no
    // reason to stay on screen, and there is no longer a card home behind it
    // to fall back to (the cards moved to the floating overlay). Closing the
    // last detail closes the panel. `setIsSidePanelOpen(false)` also resets the
    // width states, which is why the explicit `animate: false` calls that used
    // to follow are gone — see the store.
    setIsSidePanelOpen(false);
    setIsExpanded(false, { animate: false });
  }, [setIsSidePanelOpen, setIsExpanded]);

  /**
   * The terminal is a PERSISTENT layer, never a `detail` — `SessionTerminalPanel`
   * owns a long-lived PTY WebSocket that must not tear down every time the
   * user glances away, and `DetailLayer` unmounts its body via a keyed
   * `AnimatePresence` on every close (that's correct for a file preview, fatal
   * for a live shell: the connection drops and scrollback replays on reopen).
   * So it gets its own `open` flag and is handed to `DetailLayer` as a
   * `persistentLayer`, which renders it inside the SAME card frame a detail
   * wears and animates it between the same resting states, staying mounted
   * throughout with `inert` + zero opacity while closed. `terminalSwap` records
   * which of the two edges (home or detail) the current toggle crossed, since
   * at render time an open terminal with a null detail can't tell them apart.
   *
   * Because it isn't a `detail`, `DetailLayer`'s Escape/Tab/arrow-key hooks
   * stay inert while it's open (`useDetailKeyboard` only listens when
   * `detail` is non-null) — keystrokes fall straight through to xterm. That's
   * deliberate, not an oversight: adding an Escape-to-close here would eat the
   * Escape key every vim/nano/fzf user inside the shell needs. The X button
   * is the only way to close it.
   */
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [terminalSwap, setTerminalSwap] = useState(false);

  // Publish "a detail is showing" (a detail OR the terminal layer) to the
  // store. Panel close and session switch reset the flag store-side.
  const setDetailOpen = useKortixComputerStore((s) => s.setDetailOpen);
  useEffect(() => {
    setDetailOpen(detail !== null || terminalOpen);
  }, [detail, terminalOpen, setDetailOpen]);

  // Publish the same fact SESSION-KEYED, which `toggleRightPanel` (⌘I) reads to
  // decide what reopening the right side brings back.
  //
  // Two flags rather than one because they answer different questions.
  // `detailOpen` above is "is a detail on screen right now" and is reset
  // store-side whenever the panel closes; this one is "does this session still
  // HAVE a detail to return to", which must survive the panel closing — ⌘I
  // closes the panel without discarding `detail`, and that is precisely what
  // makes the next press restore it. Keyed by session because sessions kept in
  // background tabs stay mounted, so an unkeyed flag would have the last
  // provider to render answer for all of them.
  const setDetailContent = useKortixComputerStore((s) => s.setDetailContent);
  useEffect(() => {
    setDetailContent(sessionId, detail !== null || terminalOpen);
  }, [sessionId, detail, terminalOpen, setDetailContent]);

  // A SESSION CHANGE ends the detail's life. ⌘I is a minimise within a session,
  // so the detail survives it — but only until the user leaves. Come back and
  // the right side starts over: ⌘I opens the cards, not the browser tab you had
  // up on a page you have since navigated away from.
  //
  // Keyed on the store's active session rather than on this provider's own
  // `sessionId`, so BOTH ends of a switch are covered by one effect: the
  // session being left drops its detail, and the one being entered drops
  // anything it was still holding from an earlier visit.
  //
  // Firing on mount is harmless and intentional — `detail` is null then, so
  // both updates are no-ops. Functional updates keep this depending on the
  // session change alone, so it cannot loop through its own state.
  const activeSessionId = useKortixComputerStore((s) => s._activeSessionId);
  useEffect(() => {
    setDetail((current) => (current ? null : current));
    setTerminalOpen((open) => (open ? false : open));
  }, [activeSessionId]);

  // Forget the session when its provider goes away: an unmounted provider has
  // dropped its detail state, so a `true` left behind would promise ⌘I content
  // that no longer exists and reopen an empty panel. Read through `getState()`
  // so the teardown cannot capture a stale action, and so it runs on unmount
  // ONLY, never on a content change.
  useEffect(
    () => () => useKortixComputerStore.getState().setDetailContent(sessionId, null),
    [sessionId],
  );

  // Mutual exclusion: the terminal layer and a `detail` never show at once —
  // opening one closes the other, and the toggle records HOW (`terminalSwap`):
  // over a detail it's a crossfade, from home it's the arrival slide.
  // The terminal earns an even 50/50 split (a shell at the default is a
  // squeezed ribbon of wrapped lines) — the width glides on open alongside the
  // layer's own motion (the same pairing a presentation's 70/30 open plays)
  // and snaps on close, the rule every detail exit already follows: the layer
  // plays its own slide-out, and a width animation under it would be a second,
  // competing motion.
  const openTerminal = useCallback(() => {
    setTerminalSwap(detail !== null);
    setDetail(null);
    setIsSidePanelOpen(true);
    setIsExpanded(false, { animate: false });
    setTerminalOpen(true);
    setPanelSplit(50);
    setPanelAspect(null);
  }, [detail, setIsSidePanelOpen, setIsExpanded, setPanelSplit, setPanelAspect]);

  const closeTerminal = useCallback(() => {
    setTerminalSwap(false);
    setTerminalOpen(false);
    setIsSidePanelOpen(false);
  }, [setIsSidePanelOpen]);

  // Every `detail` open funnels through here (instead of raw `setDetail`) so
  // opening a file/app/step/Audit always closes the terminal — the other half
  // of the mutual exclusion above, with the same choreography note: replacing
  // an open terminal is a swap (the detail appears instantly UNDER it, the
  // terminal fades out above — see `Detail.swapIn`), arriving from home is
  // the slide. Also the generic split default: steps, Context rows, and Audit
  // never widen the panel, so this resets it on every open.
  // `handleOpenOutput` is the one caller that knows better — it calls
  // `setPanelSplit` again right after `openDetail`, so its explicit value (70
  // for a presentation, null otherwise) wins over this default.
  const openDetail = useCallback(
    (next: Detail) => {
      setTerminalSwap(terminalOpen);
      setTerminalOpen(false);
      setDetail({ ...next, swapIn: terminalOpen });
      // The detail panel is content-driven — this is the one place that opens
      // it, because this is the one place that gives it something to show.
      setIsSidePanelOpen(true);
      setPanelSplit(null);
      // The outgoing document's ratio dies with it — UNLESS the incoming one
      // will report a ratio of its own (`measures`), in which case holding the
      // old value is what keeps A4 → A4 paging perfectly still instead of
      // gliding down to the default column and straight back up. The incoming
      // measurement overwrites it; a file that fails to open clears it from
      // `FilePreview`. `handleOpenOutput` sets a split of its own right after
      // this, but never an aspect.
      if (!next.measures) setPanelAspect(null);
    },
    [terminalOpen, setIsSidePanelOpen, setPanelSplit, setPanelAspect],
  );

  // Present mode (W14): the fullscreen deck viewer fetches its own slide/
  // metadata URLs (it calls useSandboxProxy() itself — see
  // FullScreenPresentationViewer), so `sandboxUrl` only has to be a truthy
  // proxied base URL the viewer can build its PDF/PPTX export and Google
  // Slides upload requests against (`${sandboxUrl}/presentation/convert-to-*`
  // — the /presentation router the sandbox agent server mounts at its root,
  // i.e. Kortix Master, port 8000). It is never a raw sandbox host: every
  // sandbox surface here (AppPreview, browser/desktop tabs) reaches its port
  // through this same proxy.
  const { getServiceUrl } = useSandboxProxy();

  /**
   * "Send to agent" for a stopped app — surfaced from the AppPreview's
   * "Couldn't load" error state (the screen that says the app on port N may
   * not be running, next to Retry), in the same shape as the merge-conflict
   * "Solve with agent" affordance. A dead/empty app is the one state where
   * opening the app shows the user nothing useful, so the one thing they can
   * still do is ask the agent to bring it back. Hands the session composer a
   * starter prompt naming the app and its port, and steps out of the way.
   * The composer is disabled while the sandbox sleeps, but the prefill is
   * held in the store and lands the instant the box is awake — which is
   * exactly the moment the app would be reachable again. Persistent
   * apps/artifacts will replace this; until then it's the bridge.
   *
   * Arrived from main while this file was being extracted out of
   * `easy-panel.tsx`; it lives here now because `handleOpenOutput` does.
   */
  const sendAppToAgent = useCallback(
    (app: OutputItem) => {
      track('app_send_to_agent_clicked', { kind: app.kind });
      const port = parseLocalhostUrl(app.url)?.port;
      const portHint = port ? ` on port ${port}` : '';
      useSessionComposerPrefillStore
        .getState()
        .setPrefill(
          sessionId,
          `The app \`${app.name}\`${portHint} isn’t running anymore. Go start it again.`,
        );
      closeDetail();
    },
    [sessionId, closeDetail],
  );

  /**
   * Opening an output shows the THING, not the machinery around it: a running
   * app opens as the app, a file opens as that one file — never the file
   * manager, which is a filing cabinet in answer to "show me the page".
   *
   * Both bring their own toolbar, so the layer's header is suppressed for both
   * (one bar, not two), and both fill the pane, so neither takes the layer's
   * padding.
   *
   * `siblings` is the list the row came from (files or apps — never both
   * mixed, so "next" always means what that list's own order means). It's an
   * argument, not a closed-over card list, so the callback itself stays
   * dependency-free and every caller supplies its own list explicitly (W10).
   * Nav is attached only once 2+ openable siblings exist — a lone file earns
   * no prev/next row.
   *
   * `source` is telemetry-only (W5) — see `OpenSource`.
   */
  const handleOpenOutput = useCallback(
    (output: OutputItem, siblings?: OutputItem[], source: OpenSource = 'row') => {
      // The human title, when the output carries one (W3) — never the raw
      // filename in a spot the user reads as the thing's name.
      const displayName = output.title ?? output.name;

      // Wide split (Marko's feedback): a presentation deliverable grows the
      // panel to its widest split with the glide — see `isWideDeliverable`.
      // Set AFTER `openDetail` below, whose own generic default
      // (`setPanelSplit(null)`, for steps/context/audit) would otherwise win.
      const split = isWideDeliverable(output) ? 70 : null;

      // Present (W14): only for outputs derive-panels.ts tagged with a real
      // deck name (a presentation_gen create/export call — never a `show`n
      // .pptx FILE, which has no metadata.json/slide-html behind it).
      const present =
        output.kind === 'presentation' && output.presentationName
          ? () => {
              const kortixMasterPort = Number.parseInt(SANDBOX_PORTS.KORTIX_MASTER, 10);
              const sandboxBaseUrl = getServiceUrl(kortixMasterPort)?.replace(/\/+$/, '');
              if (!sandboxBaseUrl) return;
              track('present_opened');
              usePresentationViewerStore
                .getState()
                .openPresentation(output.presentationName!, sandboxBaseUrl);
            }
          : undefined;

      const openable = (siblings ?? []).filter((s) => s.path || s.url);
      const { prev, next, position } =
        openable.length > 1
          ? neighborOutputs(openable, outputKey(output))
          : { prev: null, next: null, position: '' };
      const nav =
        prev || next
          ? {
              prev: prev ? () => handleOpenOutput(prev, siblings, 'nav') : null,
              next: next ? () => handleOpenOutput(next, siblings, 'nav') : null,
              position,
            }
          : undefined;

      // An app opens even with NO url — the quick "Open Browser" with nothing
      // running hands over `url: ''`, and `AppPreview` renders its recents/
      // port landing for that. Guarding on `output.url` here silently ate the
      // click (the browser button did nothing), which reads as broken.
      if (output.kind === 'app') {
        track('deliverable_opened', { kind: output.kind, source });
        openDetail({
          key: `app:${output.url || 'landing'}`,
          title: displayName,
          hideHeader: true,
          padded: false,
          nav,
          body: (
            <AppPreview
              url={output.url ?? ''}
              name={displayName}
              projectId={projectId}
              shareContext={
                projectId && projectSessionId
                  ? { projectId, sessionId: projectSessionId }
                  : undefined
              }
              onClose={closeDetail}
              onSendToAgent={() => sendAppToAgent(output)}
            />
          ),
        });
        setPanelSplit(split);
        return;
      }

      if (!output.path) return;
      track('deliverable_opened', { kind: output.kind, source });
      openDetail({
        key: `file:${output.path}`,
        title: displayName,
        icon: <FileText className="text-muted-foreground size-4 shrink-0" />,
        hideHeader: true,
        padded: false,
        nav,
        // `output.name` is the real filename — `displayName` may be a human
        // title carrying no extension, which this predicate reads.
        measures: reportsIntrinsicSize(output.name),
        body: (
          <FilePreview
            path={output.path}
            name={displayName}
            fileName={output.name}
            shareContext={
              projectId && projectSessionId ? { projectId, sessionId: projectSessionId } : undefined
            }
            onClose={closeDetail}
            onPresent={present}
          />
        ),
      });
      setPanelSplit(split);
    },
    [
      sessionId,
      getServiceUrl,
      closeDetail,
      openDetail,
      setPanelSplit,
      projectId,
      projectSessionId,
      sendAppToAgent,
    ],
  );

  // W1/W9 — announce finished deliverables and blocked-on-you states while the
  // panel is closed. Headless: writes the ready chip; the header renders it.
  useDeliverableReadiness(sessionId, { isRunning, outcome, outputs });

  const openAudit = useCallback(() => {
    openDetail({
      key: 'audit',
      title: tI18nComplete.raw('textbb6aea287396'),
      padded: false,
      body: <SessionAuditPanel projectId={projectId} projectSessionId={projectSessionId} />,
    });
  }, [openDetail, projectId, projectSessionId, tI18nComplete]);

  // A session with more reminders than the header popover holds opens them here.
  const openReminders = useCallback(() => {
    openDetail({
      key: 'reminders',
      title: tReminders('title'),
      body: <SessionRemindersPanel projectId={projectId} projectSessionId={projectSessionId} />,
    });
  }, [openDetail, projectId, projectSessionId, tReminders]);

  /**
   * The opt-in File Explorer (Marko's ask). Never a default view and never a
   * tab — it opens only when asked for, exactly like Terminal and Audit, so
   * Easy keeps its one-home shape.
   *
   * `padded: false` — the explorer owns its own chrome (version header, tabs,
   * toolbar) and would sit inside a second frame otherwise. The layer header
   * stays ON, unlike a file preview: the explorer's own header names a
   * version, not this detail, so there is no duplicate name to collapse.
   */
  const openFiles = useCallback(
    (changes = false) => {
      openDetail({
        // The Changes diff and All files are two landings of one surface, so
        // the key differs — re-opening on the other tab must re-animate rather
        // than be treated as the same detail already showing.
        key: changes ? 'files:changes' : 'files',
        title: changes ? 'Changes' : 'Files',
        padded: false,
        body: (
          <SessionFilesExplorer
            chatSessionId={sessionId}
            projectId={projectId}
            projectSessionId={projectSessionId}
            ephemeral
            initialMode={changes ? 'changes' : 'files'}
          />
        ),
      });
    },
    [openDetail, sessionId, projectId, projectSessionId],
  );

  /**
   * Header/palette "Open Browser": the in-panel port browser (`AppPreview`),
   * defaulting to the first running app's url when the session has one, else
   * an empty url — `AppPreview` renders its "no app yet" landing (focused
   * address bar) for that instead of iframing a guessed port. Routes through
   * `handleOpenOutput` with a synthetic app `OutputItem` rather than opening
   * `AppPreview` directly: that's the one path that already carries the wide
   * split, the terminal mutual-exclusion, and `deliverable_opened` telemetry,
   * so this reads as "click the first Apps-card row" instead of a second,
   * parallel way to open the same detail that could drift from it later. The
   * synthetic `callID` never collides with a real tool call's, so it can't be
   * mistaken for one if it ever leaked into a siblings list.
   */
  const openBrowser = useCallback(
    (target?: { url?: string; title?: string }) => {
      // A targeted request (a `show` preview button, a localhost link in chat)
      // names the exact page it wants. Without honoring it the browser would
      // open on the first running app instead — right surface, wrong page.
      handleOpenOutput(quickBrowserOutput(apps, target), undefined, 'quick');
    },
    [apps, handleOpenOutput],
  );

  const { outputsDefaultOpen, pendingQuickView } = usePanelHandoffs({
    sessionId, projectId, projectSessionId, isRunning, outcome, apps, files, steps,
    detail, handleOpenOutput, openDetail, openTerminal, openAudit, openReminders, openBrowser, openFiles,
  });

  // The panel comes back with the session: what it showed is remembered while
  // it is open, and reopened on the way back while the session still runs.
  // Keyed by the Kortix session, so the boot shell and the chat share it. See
  // `session-panel-memory-store.ts`.
  const memoryKey = projectSessionId ?? sessionId;
  // The visible, non-transient panel: the same session the header's own Terminal
  // and Browser buttons open into (`getActivePanelSessionId`). The boot shell is
  // never it, so it neither restores nor records.
  const isActivePanel = useSessionBrowserStore((s) => s.activeSessionId === sessionId);
  const sidePanelOpen = useKortixComputerStore((s) => s.isSidePanelOpen);
  const advancedPanel = useUserPreferencesStore((s) => s.preferences.panelMode === 'advanced');
  const isMobile = useIsMobile();
  const queryClient = useQueryClient();
  // Nothing is recorded before the arrival is decided: until then the panel is
  // closed by the arrival itself, not by the person.
  const [restoreSettled, setRestoreSettled] = useState(false);
  const [pendingFileRestore, setPendingFileRestore] = useState<string | null>(null);
  const restoreStartedRef = useRef(false);
  useEffect(() => {
    if (restoreStartedRef.current || !isActivePanel) return;
    restoreStartedRef.current = true;
    const remembered = useSessionPanelMemoryStore.getState().bySession[memoryKey];
    if (!remembered || isMobile || !projectId || !projectSessionId) {
      setRestoreSettled(true);
      return;
    }
    let alive = true;
    // A FRESH row, never the cached one: it can be 30 s old, and reopening a
    // Terminal on a session stopped since then wakes its computer (measured).
    void queryClient
      .fetchQuery({
        queryKey: qk.project.session(projectId, projectSessionId),
        queryFn: () => getProjectSession(projectId, projectSessionId, { showErrors: false }),
        staleTime: 0,
      })
      .then((row) => {
        if (!alive) return;
        const panel = panelToRestore({
          remembered,
          status: row.status,
          panelOpen: useKortixComputerStore.getState().isSidePanelOpen,
          isMobile,
        });
        if (panel?.kind === 'open') useKortixComputerStore.getState().openSidePanel();
        else if (panel?.kind === 'view') {
          useKortixComputerStore.getState().requestQuickView(panel.view, sessionId, panel.target);
        } else if (panel?.kind === 'file') setPendingFileRestore(panel.path);
      })
      .catch(() => undefined)
      .finally(() => {
        if (alive) setRestoreSettled(true);
      });
    return () => {
      // Cancelled (unmount, or the panel stopped being the visible one): no
      // restore, and recording opens up again.
      alive = false;
      setRestoreSettled(true);
    };
  }, [isActivePanel, memoryKey, isMobile, projectId, projectSessionId, queryClient, sessionId]);
  // A file preview reopens once the transcript has derived its output, and only
  // if the person has not opened something else meanwhile.
  useEffect(() => {
    if (!pendingFileRestore) return;
    const timer = setTimeout(() => setPendingFileRestore(null), FILE_RESTORE_WAIT_MS);
    return () => clearTimeout(timer);
  }, [pendingFileRestore]);
  useEffect(() => {
    if (!pendingFileRestore) return;
    const output = files.find((o) => o.path === pendingFileRestore);
    if (!output) return;
    setPendingFileRestore(null);
    if (!useKortixComputerStore.getState().isSidePanelOpen)
      handleOpenOutput(output, files, 'restore');
  }, [pendingFileRestore, files, handleOpenOutput]);
  useEffect(() => {
    if (!restoreSettled || !isActivePanel || !sidePanelOpen) return;
    // A request this panel has not opened yet: its content is on the way.
    if (pendingQuickView?.sessionId === sessionId || pendingFileRestore) return;
    useSessionPanelMemoryStore
      .getState()
      .remember(
        memoryKey,
        advancedPanel
          ? { kind: 'open' }
          : rememberedPanelOf({ terminalOpen, detailKey: detail?.key ?? null }),
      );
  }, [
    restoreSettled,
    isActivePanel,
    sidePanelOpen,
    pendingQuickView,
    pendingFileRestore,
    sessionId,
    advancedPanel,
    terminalOpen,
    detail,
    memoryKey,
  ]);

  const value = useMemo<SessionPanelValue>(
    () => ({
      sessionId,
      projectId,
      projectSessionId,
      files,
      context,
      apps,
      outputsDefaultOpen,
      detail,
      terminalOpen,
      terminalSwap,
      openDetail,
      handleOpenOutput,
      closeDetail,
      openTerminal,
      closeTerminal,
      openBrowser,
      openFiles,
      openAudit,
      openReminders,
    }),
    [
      sessionId,
      projectId,
      projectSessionId,
      files,
      context,
      apps,
      outputsDefaultOpen,
      detail,
      terminalOpen,
      terminalSwap,
      openDetail,
      handleOpenOutput,
      closeDetail,
      openTerminal,
      closeTerminal,
      openBrowser,
      openFiles,
      openAudit,
      openReminders,
    ],
  );

  return <SessionPanelContext.Provider value={value}>{children}</SessionPanelContext.Provider>;
}
