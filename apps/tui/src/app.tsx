/**
 * The layout frame, the route state, the command runner and the global keymap.
 *
 * The TUI is SESSION-FIRST. One session fills the screen; with none open, the
 * draft view stands in for the session it is about to create. Every action is
 * a slash command typed into that one input (`commands/registry.ts`), and
 * `runCommand` below is the one place each command is carried out. The
 * sidebar is an optional view (`/sidebar`, `Alt+B`), hidden by default and
 * remembered in `tui.json`; the chords are accelerators for the same commands.
 *
 * Everything visible is a child: the sidebar, the session column (which brings
 * the terminal panel with it) or the draft, the secondary screens, and the one
 * overlay slot. Route state lives here and nowhere else (SPEC §3).
 *
 * ── Why the overlays are here and not in the features ──
 * `ui/Panel` sets `overflow: 'hidden'`, and an absolutely positioned child is
 * scissored to its containing panel's rectangle. A `<Modal>` mounted from
 * inside a panel therefore renders as a sliver. So the app owns ONE overlay
 * slot at the root of the tree. The command panels (`/sessions`, `/workspaces`,
 * a confirm) are in-flow lists above the input instead, so they are passed
 * DOWN into the session column.
 *
 * ── Why the global handler gates on focus ──
 * `useKeyboard` subscribes at the GLOBAL level, which OpenTUI dispatches BEFORE
 * the focused renderable (`docs/opentui-api-reference.md` §2.4). A bare-letter
 * global binding is therefore a keystroke stolen from whatever text field has
 * focus. `?` is global only when no text input and no terminal has focus;
 * while the slash menu is open, Tab, Ctrl+P and Ctrl+N are the menu's; while
 * the terminal is focused only `TERMINAL_RESERVED_CHORDS` are the app's —
 * `Ctrl+C` belongs to the shell, so quitting there is `Ctrl+Q`.
 */

import { clearAuth } from '@kortix/cli/src/api/auth.ts';
import { webDashboardUrl } from '@kortix/cli/src/web-url.ts';
import { sessionParentId } from '@kortix/sdk';
import { useFeatureFlag, useProjectSessions, useProjects } from '@kortix/sdk/react';
import { useKeyboard, useRenderer, useTerminalDimensions } from '@opentui/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { type Focus, type Overlay, type Route, globalKeyAction } from './app-keys.ts';
import { type ResolvedHost, hostOrigin } from './auth/hosts.ts';
import { type CommandPanel, CommandPanelView, type ConfirmAction } from './commands/panels.tsx';
import {
  COMMANDS,
  type CommandContext,
  type CommandName,
  unavailableReason,
} from './commands/registry.ts';
import {
  compactSession,
  deleteSession,
  errorText,
  forkSession,
  reloadSession,
  renameSession,
  restartSession,
  sessionWebUrl,
  shareSession,
  startSession,
  toggleArchive,
  togglePin,
} from './commands/session-actions.ts';
import { HelpOverlay } from './features/help/index.ts';
import { useInboxUnread } from './features/inbox/index.ts';
import { type LinkRow, LinksOverlay } from './features/links/index.ts';
import { PortsOverlay, type UsePortsResult } from './features/ports/index.ts';
import { type ComposerMetrics, DraftView, SessionView } from './features/session/index.ts';
import { focusHints } from './features/session/session-view.tsx';
import { Sidebar, type SidebarNavItem } from './features/sidebar/index.ts';
import { kortix } from './kortix.ts';
import { copyToClipboard } from './lib/clipboard.ts';
import { useCopyOnSelect } from './lib/copy-on-select.ts';
import { openUrl } from './lib/open-url.ts';
import { writePrefs } from './lib/prefs.ts';
import { type Tab, TabsBar } from './layout/tabs-bar.tsx';
import { UI_PANEL_ROWS, UiPanel } from './layout/ui-panel.tsx';
import { DEFAULT_UI, type ModuleId, type UiPrefs, toggleModule } from './layout/ui-prefs.ts';
import { sessionTitle } from './lib/session-groups.ts';
import { type AgentNav, AgentNavProvider, type PeekTarget } from './features/agents/agent-nav.tsx';
import { PeekView } from './features/agents/peek-view.tsx';
import { SCREEN_TITLE, Screen, type ScreenRoute, isScreenRoute } from './screens.tsx';
import { theme } from './theme.ts';
import { printable } from './lib/printable.ts';
import { PICK_WORKSPACE_TEXT } from './lib/workspaces.ts';
import { Panel, type SplashLine, StatusBar, Toast, type ToastKind } from './ui/index.ts';

const SIDEBAR_WIDTH = 28;
/** The draft's tab id: no session has it. */
const DRAFT_TAB = 'draft';
/** Where `/feedback` sends a bug report or an idea. */
const FEEDBACK_URL = 'https://github.com/kortix-ai/CompanyOS/issues/new';
/** Below this width the terminal panel takes the whole main area. */
export const SPLIT_MIN_COLUMNS = 100;
/** Below this width the sidebar never draws, whatever was chosen. */
export const SIDEBAR_MIN_COLUMNS = 60;
/** Ctrl+C arms the quit; a second press inside this window leaves. */
const QUIT_ARM_MS = 2000;

/** The flags the command table gates on. One project-detail read serves all. */
const COMMAND_FLAGS = [
  'drives',
  'artifacts',
  'chat',
  'reminders',
  'goals',
  'agent_teams',
] as const;

/**
 * The Tab ring for a route.
 *
 * Session-first: with the sidebar hidden the input is the only place to be,
 * so Tab never leaves it (the terminal joins only while its panel is open).
 * PgUp/PgDn scroll the transcript from the input. With the sidebar shown the
 * ring is sidebar → transcript → composer → terminal; the transcript joins
 * only when a session is open (the draft has none).
 */
export function focusOrder(
  route: Route,
  showSidebar: boolean,
  terminalOpen: boolean,
  hasSession = true,
): Focus[] {
  const order: Focus[] = showSidebar ? ['sidebar'] : [];
  if (route === 'session') {
    if (hasSession && showSidebar) order.push('transcript');
    order.push('composer');
    if (terminalOpen && hasSession) order.push('terminal');
  } else {
    order.push('screen');
  }
  return order;
}

/**
 * What `Alt+T` / `/terminal` does. The panel is a shell INSIDE the open
 * session's sandbox, so with no session there is nothing to open: focus must
 * not move to a region that does not render. Pure so the rule is testable.
 */
export function terminalToggle(
  open: boolean,
  sessionId: string | null,
): { open: boolean; focus: Focus | null; toast: string | null } {
  if (open) return { open: false, focus: 'composer', toast: null };
  if (!sessionId) {
    return {
      open: false,
      focus: null,
      toast:
        'Open a session first: the terminal runs inside its sandbox. Type /sessions or a prompt.',
    };
  }
  return { open: true, focus: 'terminal', toast: null };
}

/**
 * Whether the sidebar column is drawn: chosen (`/sidebar`, `Alt+B`, the saved
 * choice, `--sidebar`) and not squeezed out by a narrow terminal.
 */
export function sidebarVisible(width: number, shown: boolean): boolean {
  return shown && width >= SIDEBAR_MIN_COLUMNS;
}

export function nextFocus(current: Focus, order: Focus[], step: 1 | -1): Focus {
  const index = order.indexOf(current);
  if (index < 0) return order[0] as Focus;
  const next = (index + step + order.length) % order.length;
  return order[next] as Focus;
}

/**
 * The project flags the command table gates on, by key. A flag still loading
 * is left out, which the table reads as "allow": a command must not flicker
 * dimmed while the project detail loads. Every `useFeatureFlag` call reads
 * the same project-detail query, so this is one request.
 */
function useCommandFlags(projectId: string | null): Record<string, boolean> {
  const drives = useFeatureFlag(projectId, 'drives');
  const artifacts = useFeatureFlag(projectId, 'artifacts');
  const channels = useFeatureFlag(projectId, 'chat');
  const reminders = useFeatureFlag(projectId, 'reminders');
  const goals = useFeatureFlag(projectId, 'goals');
  const teams = useFeatureFlag(projectId, 'agent_teams');
  return useMemo(() => {
    const states = {
      drives,
      artifacts,
      chat: channels,
      reminders,
      goals,
      agent_teams: teams,
    } satisfies Record<(typeof COMMAND_FLAGS)[number], typeof artifacts>;
    const known: Record<string, boolean> = {};
    for (const key of COMMAND_FLAGS) if (!states[key].isLoading) known[key] = states[key].enabled;
    return known;
  }, [drives, artifacts, channels, reminders, goals, teams]);
}

export interface AppProps {
  host: ResolvedHost;
  /** The project the session list reads. Resolved at boot. */
  projectId: string | null;
  /** The account that project belongs to. */
  accountId?: string | null;
  /** Pre-selected session, from `KORTIX_SESSION_ID`. */
  initialSessionId?: string | null;
  /** `--terminal`: open the sandbox terminal panel at boot, focused. Needs a session. */
  initialTerminalOpen?: boolean;
  /** The layout at boot: the saved `/ui` choice, with `--sidebar` / `--no-sidebar` applied. */
  initialUi?: UiPrefs;
  /** The first-run layout picker was already answered. False opens it at boot. */
  onboarded?: boolean;
  /** Tear the renderer down and leave. `src/main.tsx` owns the real exit. */
  onQuit: () => void;
  /** `/hosts`. `src/main.tsx` remounts the app on the new host. */
  onSwitchHost?: () => void;
  /** A boot-time workaround (a dead default project) to show once. */
  bootNotice?: string | null;
  /** Remember the layout. Test seam; production writes `tui.json`. */
  saveUi?: (ui: UiPrefs) => void;
  /** Remember that the first-run picker was answered. */
  saveOnboarded?: () => void;
}

export function App({
  host,
  projectId: initialProjectId,
  accountId: initialAccountId = null,
  initialSessionId = null,
  initialTerminalOpen = false,
  initialUi = DEFAULT_UI,
  onboarded = true,
  onQuit,
  onSwitchHost,
  bootNotice = null,
  saveUi = (next) => void writePrefs({ ui: next }),
  saveOnboarded = () => void writePrefs({ onboarded: true }),
}: AppProps) {
  // A SIGWINCH re-renders through this hook, and the re-render is what
  // repaints: every region's width/height is derived from it.
  const dimensions = useTerminalDimensions();
  const renderer = useRenderer();

  const [route, setRoute] = useState<Route>('session');
  /** What the open screen starts on: an artifact id, a file path, a provider id. */
  const [screenTarget, setScreenTarget] = useState<string | null>(null);
  /**
   * The open screen holds Esc (`ScreenProps.onHoldsBack`). The screen clears it
   * when it unmounts. Not reset on route change here: a parent effect runs after
   * the child's, so it would erase what a screen reports on its first render.
   */
  const [screenHoldsBack, setScreenHoldsBack] = useState(false);
  const [overlay, setOverlay] = useState<Overlay>(null);
  const bootTerminal = initialTerminalOpen && Boolean(initialSessionId);
  const [focus, setFocus] = useState<Focus>(bootTerminal ? 'terminal' : 'composer');
  const [terminalOpen, setTerminalOpen] = useState(bootTerminal);
  const [ui, setUiState] = useState<UiPrefs>(initialUi);
  const sidebarShown = ui.sidebar.on;
  /** Sessions opened in this run, in order: the tabs module draws them. */
  const [openTabs, setOpenTabs] = useState<string[]>(initialSessionId ? [initialSessionId] : []);
  const [quitArmed, setQuitArmed] = useState(false);
  const [projectId, setProjectId] = useState<string | null>(initialProjectId);
  const [accountId, setAccountId] = useState<string | null>(
    initialAccountId || host.accountId || null,
  );
  const [sessionId, setSessionId] = useState<string | null>(initialSessionId);
  const [toast, setToast] = useState<{ message: string; kind: ToastKind; seq: number } | null>(
    null,
  );
  const [panel, setPanel] = useState<CommandPanel | null>(
    onboarded ? null : { kind: 'ui', welcome: true },
  );
  const [seed, setSeed] = useState<{ text: string; seq: number } | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  /** `/life`: each bump starts Game of Life on the splash. */
  const [lifeSignal, setLifeSignal] = useState(0);
  // Hoisted from `SessionView`: the ports API, the links rows and the
  // runtime's capabilities. The overlays they feed live at the root.
  const [portsApi, setPortsApi] = useState<UsePortsResult | null>(null);
  const onPortsApi = useCallback((api: UsePortsResult) => setPortsApi(api), []);
  const [links, setLinks] = useState<LinkRow[]>([]);
  const [capabilities, setCapabilities] = useState<readonly string[] | null>(null);

  const wide = dimensions.width >= SPLIT_MIN_COLUMNS;
  const showSidebar = sidebarVisible(dimensions.width, sidebarShown);
  const hasSession = Boolean(projectId && sessionId);
  const order = useMemo(
    () => focusOrder(route, showSidebar, terminalOpen, hasSession),
    [route, showSidebar, terminalOpen, hasSession],
  );

  useEffect(() => {
    if (!order.includes(focus))
      setFocus(order.includes('composer') ? 'composer' : (order[0] as Focus));
  }, [order, focus]);

  // A stale ports API (from the previous session's `SessionView` instance)
  // must never answer for the new one. `sessionId` is a re-run trigger only.
  // biome-ignore lint/correctness/useExhaustiveDependencies(sessionId): trigger-only dependency, not read in the body.
  // Only on a CHANGE of session: on mount it would close the first-run
  // layout picker before it was ever seen (measured).
  const shownSession = useRef(sessionId);
  useEffect(() => {
    if (shownSession.current === sessionId) return;
    shownSession.current = sessionId;
    setPortsApi(null);
    setLinks([]);
    setCapabilities(null);
    setPanel(null);
  }, [sessionId]);

  useEffect(() => {
    if (!quitArmed) return;
    const timer = setTimeout(() => setQuitArmed(false), QUIT_ARM_MS);
    return () => clearTimeout(timer);
  }, [quitArmed]);

  const pushToast = useCallback((message: string, kind: ToastKind = 'info') => {
    setToast((current) => ({ message, kind, seq: (current?.seq ?? 0) + 1 }));
  }, []);

  // Once, at boot: the note also went to stderr, but the alternate screen hides
  // that until the app exits.
  useEffect(() => {
    if (bootNotice) pushToast(bootNotice, 'error');
  }, [bootNotice, pushToast]);

  // ── what is open: names for the splash, the tray and the header ─────────

  // These lists are already in the query cache for the sidebar and the
  // `/sessions` panel; reading them here costs no extra request.
  const sessions = useProjectSessions(projectId ?? '', { enabled: Boolean(projectId) });
  const projects = useProjects(accountId ?? undefined);
  const sessionRow = useMemo(
    () => sessions.sessions.find((entry) => entry.session_id === sessionId) ?? null,
    [sessions.sessions, sessionId],
  );
  const title = sessionRow
    ? sessionTitle(sessionRow)
    : sessionId
      ? sessionId.slice(0, 8)
      : undefined;
  const projectName =
    projects.data?.find((project) => project.project_id === projectId)?.name ??
    (projectId ? projectId.slice(0, 8) : 'no workspace');
  // An env-token host has no name: its address is what tells it apart.
  const hostLabel =
    host.source === 'env' ? hostOrigin(host.backendUrl).replace(/^https?:\/\//, '') : host.name;

  const flags = useCommandFlags(projectId);

  const context = useMemo<CommandContext>(
    () => ({
      hasProject: Boolean(projectId),
      hasSession,
      hasAccount: Boolean(accountId),
      capabilities,
      flags,
    }),
    [projectId, hasSession, accountId, capabilities, flags],
  );

  // The sidebar lists every screen the command table offers here, in table
  // order: the same set `/` lists, minus the ones turned off for the project.
  const unread = useInboxUnread(projectId);
  const sidebarNav = useMemo<SidebarNavItem[]>(
    () =>
      COMMANDS.filter(
        (spec) =>
          spec.group === 'screen' && isScreenRoute(spec.name) && !unavailableReason(spec, context),
      ).map((spec) => ({
        screen: spec.name,
        label: SCREEN_TITLE[spec.name as ScreenRoute],
        count: spec.name === 'inbox' ? unread : null,
      })),
    [context, unread],
  );

  const forwardedPorts = (portsApi?.rows ?? [])
    .filter((row) => row.state === 'forwarding')
    .map((row) => row.sandboxPort);
  const trayLeft = [
    hostLabel,
    projectName,
    forwardedPorts.length ? `⇄ ${forwardedPorts.join(',')}` : '',
  ]
    .filter(Boolean)
    .join(' · ');

  // The empty state is the symbol, one hint and where you are — one quiet
  // line. The host, the user and the ids are `/status`.
  const splashLines = useMemo<SplashLine[]>(
    () => [{ label: '', value: projectId ? projectName : '' }],
    [projectId, projectName],
  );

  // The terminal window's title follows the open session (the `title`
  // module). Cleared on the way out so the shell gets its own title back.
  // `printable`: a title is written by whoever renamed the session, and the window title is
  // an escape sequence of its own; a control character in it would end that sequence.
  const windowTitle = ui.title.on ? printable(title ? `${title} · Kortix` : `${projectName} · Kortix`) : '';
  useEffect(() => {
    if (!ui.title.on) return;
    renderer.setTerminalTitle(windowTitle);
  }, [renderer, ui.title.on, windowTitle]);
  useEffect(() => () => renderer.setTerminalTitle(''), [renderer]);

  // Drag over any text to copy it (OSC 52): the TUI holds the mouse, so
  // the terminal's own selection never sees the drag.
  useCopyOnSelect(
    useCallback(
      (text: string) => pushToast(`Copied ${text.length} character${text.length === 1 ? '' : 's'}.`),
      [pushToast],
    ),
  );

  // ── navigation ──────────────────────────────────────────────────────────

  const openSession = useCallback((id: string) => {
    setOpenTabs((tabs) => (tabs.includes(id) ? tabs : [...tabs, id]));
    setSessionId(id);
    setRoute('session');
    setOverlay(null);
    setPanel(null);
    setFocus('composer');
  }, []);


  // ── agents: peek, then switch (`features/agents/agent-nav.tsx`) ───────────
  const [peeking, setPeeking] = useState<PeekTarget | null>(null);
  // A peek belongs to the session it was opened over.
  // biome-ignore lint/correctness/useExhaustiveDependencies(sessionId): trigger-only dependency.
  useEffect(() => setPeeking(null), [sessionId]);
  const agentNav = useMemo<AgentNav>(
    () => ({
      currentSessionId: sessionId,
      peeking,
      peek: (target) => {
        setPanel(null);
        setPeeking(target);
      },
      closePeek: () => setPeeking(null),
      switchTo: (id) => {
        setPeeking(null);
        openSession(id);
      },
    }),
    [sessionId, peeking, openSession],
  );

  /** The draft: no session yet, the next prompt creates one. */
  const openDraft = useCallback(() => {
    setSessionId(null);
    setTerminalOpen(false);
    setRoute('session');
    setPanel(null);
    setFocus('composer');
  }, []);

  const openScreen = useCallback((screen: ScreenRoute, target: string | null = null) => {
    setPanel(null);
    setScreenTarget(target);
    setRoute(screen);
    setFocus('screen');
  }, []);

  // Showing the sidebar does NOT move the keyboard: the input stays where the
  // user is typing, and Tab reaches the sidebar. Measured: when it took focus,
  // the next `/drive` went into the sidebar's own `/` filter.
  const setUi = useCallback(
    (next: UiPrefs) => {
      setUiState(next);
      saveUi(next);
    },
    [saveUi],
  );

  /** `/sidebar`, `/info`, `/tabs`, `/header`, `/tray`, `/title`, `Alt+B`, `Alt+I`. */
  const toggle = useCallback(
    (id: ModuleId) => {
      setUiState((current) => {
        const next = toggleModule(current, id);
        saveUi(next);
        return next;
      });
    },
    [saveUi],
  );
  const toggleSidebar = useCallback(() => toggle('sidebar'), [toggle]);

  const toggleTerminal = useCallback(() => {
    const decision = terminalToggle(terminalOpen, sessionId);
    if (decision.toast) pushToast(decision.toast, 'error');
    if (decision.open === terminalOpen) return;
    if (decision.open) setRoute('session');
    setTerminalOpen(decision.open);
    setFocus((current) => decision.focus ?? current);
  }, [terminalOpen, sessionId, pushToast]);

  const pickProject = useCallback((nextProject: string, nextAccount: string | null) => {
    setProjectId(nextProject);
    if (nextAccount) setAccountId(nextAccount);
    setSessionId(null);
    setTerminalOpen(false);
    setRoute('session');
    setFocus('composer');
  }, []);

  // ── actions ─────────────────────────────────────────────────────────────

  /** Run one session action: its sentence on success, its error on failure. */
  const act = useCallback(
    async (label: string, run: () => Promise<string>, after?: () => void) => {
      try {
        const message = await run();
        pushToast(message);
        after?.();
        void sessions.refetch();
      } catch (error) {
        pushToast(`${label} failed: ${errorText(error)}`, 'error');
      }
    },
    [pushToast, sessions.refetch],
  );

  /** `/new <prompt>`, the draft's first prompt, `/fork`. Throws so the draft can restore. */
  const start = useCallback(
    async (prompt: string, forkFrom?: string) => {
      if (!projectId) {
        pushToast(PICK_WORKSPACE_TEXT, 'error');
        throw new Error('no workspace');
      }
      try {
        const id = forkFrom
          ? await forkSession(kortix(), projectId, forkFrom, prompt)
          : await startSession(kortix(), projectId, prompt);
        void sessions.refetch();
        openSession(id);
        if (forkFrom) pushToast('Forked into a new session.');
      } catch (error) {
        pushToast(`Could not start a session: ${errorText(error)}`, 'error');
        throw error;
      }
    },
    [projectId, sessions.refetch, openSession, pushToast],
  );

  const confirm = useCallback(
    (action: ConfirmAction) => {
      if (action.kind === 'delete-session' && projectId) {
        const target = action.sessionId;
        void act(
          'Delete',
          () => deleteSession(kortix(), projectId, target),
          () => {
            if (target === sessionId) openDraft();
          },
        );
      }
    },
    [act, projectId, sessionId, openDraft],
  );

  /**
   * Carry out one slash command. The switch is exhaustive over `CommandName`,
   * so a command added to the table without a case here does not compile.
   * Availability (a session, a capability, a flag) was checked by the input
   * before the command got here.
   */
  const runCommand = useCallback(
    (command: CommandName, args: string) => {
      const pid = projectId;
      const sid = sessionId;
      switch (command) {
        case 'new':
          if (args.trim()) return void start(args).catch(() => {});
          return openDraft();
        case 'sessions':
          return setPanel({ kind: 'sessions', query: args });
        case 'parent': {
          const parent = sessionRow ? sessionParentId(sessionRow) : null;
          if (!parent) return pushToast('This session was not started by another agent.');
          return openSession(parent);
        }
        case 'rename':
          if (!pid || !sid) return;
          if (!args.trim()) {
            // Prefill the current title: edit it, Enter saves.
            return setSeed((current) => ({
              text: `/rename ${title ?? ''}`,
              seq: (current?.seq ?? 0) + 1,
            }));
          }
          return void act('Rename', () => renameSession(kortix(), pid, sid, args));
        case 'stop':
          // Runs inside the composer, on the session's own hook.
          return;
        case 'compact':
          if (!pid || !sid) return;
          return void act('Compact', () => compactSession(kortix(), pid, sid));
        case 'restart':
          if (!pid || !sid) return;
          return void act('Restart', () => restartSession(kortix(), pid, sid));
        case 'fork':
          if (!sid) return;
          return void start(args, sid).catch(() => {});
        case 'pin':
          if (!pid || !sid) return;
          return void act('Pin', () =>
            togglePin(kortix(), pid, sid, Boolean(sessionRow?.pinned_at)),
          );
        case 'archive':
          if (!pid || !sid) return;
          return void act('Archive', async () => (await toggleArchive(kortix(), pid, sid)).message);
        case 'share':
          if (!pid || !sid) return;
          return void act('Share', () => shareSession(kortix(), pid, sid, args));
        case 'reload':
          if (!pid || !sid) return;
          return void act('Reload', () => reloadSession(kortix(), pid, sid));
        case 'copy':
        case 'export':
        case 'shown':
          // Run inside the composer: they read the thread on screen.
          return;
        case 'link': {
          if (!pid || !sid) return;
          const url = sessionWebUrl(webDashboardUrl(host.backendUrl), pid, sid);
          return void copyToClipboard(url).then((result) =>
            result.ok
              ? pushToast(`Copied ${url}`)
              : pushToast(`Copy failed: ${result.error ?? 'no clipboard tool'}. ${url}`, 'error'),
          );
        }
        case 'delete':
          if (!sid) return;
          return setPanel({
            kind: 'confirm',
            title: `Delete "${title ?? sid.slice(0, 8)}"?`,
            yes: 'Delete session',
            action: { kind: 'delete-session', sessionId: sid },
          });
        case 'workspaces':
          return setPanel({ kind: 'workspaces', query: args });
        case 'hosts':
          if (onSwitchHost) return onSwitchHost();
          return pushToast('Host switching needs the login screen.', 'error');
        case 'logout':
          if (host.source === 'env') {
            return pushToast(
              'This TUI runs on KORTIX_API_KEY / KORTIX_TOKEN. Unset it to log out.',
              'error',
            );
          }
          // The same call `kortix logout` makes: the host stays, its token goes.
          clearAuth(host.name);
          pushToast(`Logged out of ${host.name}.`);
          if (onSwitchHost) return onSwitchHost();
          return onQuit();
        case 'status':
          return setPanel({
            kind: 'status',
            lines: [
              { label: 'host', value: `${hostLabel}  ${hostOrigin(host.backendUrl)}` },
              { label: 'user', value: host.userEmail || 'unknown' },
              { label: 'workspace', value: projectId ? `${projectName}  ${projectId}` : 'none' },
              { label: 'session', value: sid ? `${title ?? ''}  ${sid}` : 'none (draft)' },
              {
                label: 'runtime',
                value: sid
                  ? capabilities
                    ? capabilities.filter((entry) => entry.startsWith('session.')).join(' ') ||
                      'no session.* capabilities'
                    : 'not read yet'
                  : '—',
              },
              {
                label: 'layout',
                value:
                  (['header', 'tabs', 'sidebar', 'info', 'tray'] as const)
                    .filter((id) => ui[id].on)
                    .map((id) => (ui[id].side ? `${id} ${ui[id].side}` : id))
                    .join(' · ') || 'chat only (/ui)',
              },
              { label: 'version', value: process.env.KORTIX_TUI_VERSION || 'dev' },
            ],
          });
        case 'feedback':
          void openUrl(FEEDBACK_URL).catch(() => {});
          return pushToast(`Opening ${FEEDBACK_URL}`);
        case 'model':
        case 'effort':
        case 'agent':
          // Run inside the composer: its pickers read the session's hook.
          return;
        case 'sidebar':
          return toggleSidebar();
        case 'info':
        case 'tabs':
        case 'header':
        case 'tray':
        case 'title':
          return toggle(command);
        case 'ui':
          return setPanel({ kind: 'ui', welcome: false });
        case 'close': {
          if (!sid) return;
          const index = openTabs.indexOf(sid);
          const rest = openTabs.filter((tab) => tab !== sid);
          setOpenTabs(rest);
          const next = rest[Math.min(Math.max(index, 0), rest.length - 1)];
          if (next) return openSession(next);
          return openDraft();
        }
        case 'terminal':
          return toggleTerminal();
        case 'ports':
          if (!portsApi) return pushToast('Open a session first.', 'error');
          return setOverlay('ports');
        case 'links':
          return setOverlay('links');
        case 'files':
        case 'artifacts':
          // `/artifacts <id>` opens on that artifact, `/files <path>` on that file.
          return openScreen(command, args.trim() || null);
        case 'drive':
        case 'repo':
        case 'inbox':
        case 'approvals':
        case 'goals':
        case 'memory':
        case 'spaces':
        case 'loops':
        case 'audit':
        case 'review':
        case 'apps':
        case 'customize':
          return openScreen(command);
        case 'members':
          return openScreen('account');
        case 'providers':
          return openScreen('providers', args.trim().toLowerCase() || null);
        case 'connectors':
        case 'connect':
          return openScreen(command, args.trim() || null);
        case 'life':
          return setLifeSignal((value) => value + 1);
        case 'help':
          return setOverlay('help');
        case 'quit':
          return onQuit();
        case 'agents':
          return setPanel({ kind: 'agents' });
        case 'workflows':
          return setPanel({ kind: 'workflows' });
        case 'tasks':
          return setPanel({ kind: 'tasks' });
        default: {
          // Every command has a case: a new one fails the typecheck until it gets one.
          const unreachable: never = command;
          return unreachable;
        }
      }
    },
    [
      projectId,
      sessionId,
      title,
      sessionRow,
      host,
      hostLabel,
      accountId,
      projectName,
      capabilities,
      ui,
      toggle,
      openTabs,
      openSession,
      start,
      openDraft,
      act,
      onSwitchHost,
      toggleSidebar,
      toggleTerminal,
      portsApi,
      openScreen,
      onQuit,
      pushToast,
    ],
  );

  const onComposerMetrics = useCallback(
    (metrics: ComposerMetrics) => setMenuOpen(metrics.menuOpen),
    [],
  );

  useKeyboard((key) => {
    // The decision is a pure function (`app-keys.ts`); this handler only
    // performs it. That is what makes the gating rules assertable.
    const action = globalKeyAction(key, { focus, route, overlay, quitArmed, menuOpen, screenHoldsBack });
    if (!action) return;
    if (action.kind !== 'quit' && action.kind !== 'arm-quit') key.preventDefault();
    if (quitArmed && action.kind !== 'quit' && action.kind !== 'arm-quit') setQuitArmed(false);

    switch (action.kind) {
      case 'quit':
        return onQuit();
      case 'arm-quit':
        setQuitArmed(true);
        return pushToast('Press Ctrl+C again to quit.');
      case 'focus':
        return setFocus((current) => nextFocus(current, order, action.step));
      case 'toggle-terminal':
        return toggleTerminal();
      case 'toggle-sidebar':
        return toggleSidebar();
      case 'toggle-info':
        return toggle('info');
      case 'tab': {
        if (openTabs.length === 0) return;
        const index = sessionId ? openTabs.indexOf(sessionId) : -1;
        const next = openTabs[(index + action.step + openTabs.length) % openTabs.length];
        if (next) openSession(next);
        return;
      }
      case 'overlay':
        if (action.overlay === 'ports' && !portsApi) {
          return pushToast('Open a session first.', 'error');
        }
        return setOverlay(action.overlay);
      case 'new-session':
        return openDraft();
      case 'sessions':
        setRoute('session');
        setFocus('composer');
        return setPanel({ kind: 'sessions', query: '' });
      case 'switch-host':
        if (onSwitchHost) return onSwitchHost();
        return pushToast('Host switching needs the login screen.', 'error');
      case 'route':
        return openScreen(action.route as ScreenRoute);
      case 'back':
        setRoute('session');
        return setFocus('composer');
      case 'focus-composer':
        return setFocus('composer');
    }
  });

  const tabsShown = ui.tabs.on;
  const contentHeight =
    (route === 'session' ? dimensions.height : Math.max(dimensions.height - 1, 3)) -
    (tabsShown ? 1 : 0);
  const tabs: Tab[] = openTabs.map((id) => {
    const row = sessions.sessions.find((entry) => entry.session_id === id);
    return { sessionId: id, title: row ? sessionTitle(row) : id.slice(0, 8) };
  });
  // The draft is a tab too: the session it is about to start (a "New session"
  // tab), so the bar never prints an empty-state sentence.
  if (!sessionId && route === 'session') tabs.push({ sessionId: DRAFT_TAB, title: 'New session' });
  const tabsNode = tabsShown ? (
    <TabsBar
      tabs={tabs}
      activeId={sessionId ?? DRAFT_TAB}
      width={dimensions.width}
      onPick={(id) => (id === DRAFT_TAB ? openDraft() : openSession(id))}
    />
  ) : null;
  const mainWidth = Math.max(dimensions.width - (showSidebar ? SIDEBAR_WIDTH : 0), 20);
  const borderless = !showSidebar;

  const panelWidth = Math.max(Math.min(mainWidth - (borderless ? 2 : 4), 96), 24);
  const closePanel = () => {
    if (panel?.kind === 'ui' && panel.welcome) saveOnboarded();
    setPanel(null);
    setFocus('composer');
  };
  const panelNode =
    panel?.kind === 'ui' ? (
      <UiPanel
        ui={ui}
        width={panelWidth}
        welcome={panel.welcome}
        onChange={setUi}
        onClose={closePanel}
      />
    ) : panel ? (
      <CommandPanelView
        panel={panel}
        width={panelWidth}
        projectId={projectId}
        accountId={accountId}
        sessionId={sessionId}
        onClose={closePanel}
        onOpenSession={openSession}
        onPickWorkspace={pickProject}
        onConfirm={confirm}
      />
    ) : null;

  const sidebarNode = (
    <Panel
      title={hostLabel === 'env' ? 'kortix' : hostLabel}
      focused={focus === 'sidebar'}
      width={SIDEBAR_WIDTH}
      flexShrink={0}
    >
      <Sidebar
        host={host}
        accountId={accountId}
        projectId={projectId}
        selectedSessionId={sessionId}
        focused={focus === 'sidebar'}
        width={SIDEBAR_WIDTH - 2}
        height={contentHeight - 2}
        onOpenSession={openSession}
        onNewSession={openSession}
        onStartDraft={openDraft}
        nav={sidebarNav}
        onNavigate={(screen) => {
          if (isScreenRoute(screen)) openScreen(screen);
        }}
        onProjectChange={pickProject}
        // Only fills a blank (an env host with no KORTIX_ACCOUNT_ID);
        // it keeps the open project and session, unlike a real pick.
        onAccountResolved={(resolved) => {
          setAccountId((current) => current ?? resolved);
        }}
        onToast={pushToast}
      />
    </Panel>
  );

  return (
    <AgentNavProvider value={agentNav}>
    <box
      flexDirection="column"
      width={dimensions.width}
      height={dimensions.height}
      backgroundColor={theme.bg}
    >
      {ui.tabs.side !== 'bottom' ? tabsNode : null}
      <box flexDirection="row" flexGrow={1} overflow="hidden">
        {showSidebar && ui.sidebar.side !== 'right' ? sidebarNode : null}

        {route === 'session' && projectId && sessionId ? (
          <SessionView
            host={host}
            projectId={projectId}
            sessionId={sessionId}
            title={title}
            focus={
              focus === 'transcript' || focus === 'composer' || focus === 'terminal' ? focus : null
            }
            width={mainWidth}
            height={contentHeight}
            terminalOpen={terminalOpen}
            wide={wide}
            onFocus={setFocus}
            onCloseTerminal={() => {
              setTerminalOpen(false);
              setFocus('composer');
            }}
            context={context}
            onCommand={runCommand}
            onToast={pushToast}
            onCapabilities={setCapabilities}
            onComposerMetrics={onComposerMetrics}
            panel={panelNode}
            seed={seed}
            borderless={borderless}
            overlay={
              peeking && projectId ? (
                <PeekView
                  projectId={projectId}
                  target={peeking}
                  width={Math.max(mainWidth - (borderless ? 2 : 4), 20)}
                  height={Math.max(contentHeight - (borderless ? 0 : 2), 6)}
                  onClose={() => setPeeking(null)}
                  onOpen={agentNav.switchTo}
                  onToast={pushToast}
                />
              ) : null
            }
            trayLeft={trayLeft}
            splashLines={splashLines}
            info={ui.info.on ? (ui.info.side === 'left' ? 'left' : 'right') : null}
            showHeader={ui.header.on}
            showTray={ui.tray.on}
            forwardedPorts={forwardedPorts}
            lifeSignal={lifeSignal}
            onPortsApi={onPortsApi}
            onLinks={setLinks}
          />
        ) : null}

        {route === 'session' && !(projectId && sessionId) ? (
          <DraftView
            width={mainWidth}
            height={contentHeight}
            focused={focus === 'composer'}
            borderless={borderless}
            context={context}
            splashLines={splashLines}
            trayLeft={trayLeft}
            showTray={ui.tray.on}
            lifeSignal={lifeSignal}
            onStart={(prompt) => start(prompt)}
            onCommand={runCommand}
            onToast={pushToast}
            onMetrics={onComposerMetrics}
            panel={panelNode}
            seed={seed}
          />
        ) : null}

        {route !== 'session' ? (
          <Panel
            title={SCREEN_TITLE[route]}
            footer="Esc back"
            focused={focus === 'screen'}
            flexGrow={1}
            minWidth={20}
          >
            <Screen
              // A new target remounts the screen: it opens on what was asked for.
              key={`${route}:${screenTarget ?? ''}`}
              route={route}
              projectId={projectId}
              accountId={accountId}
              sessionId={sessionId}
              focused={focus === 'screen'}
              width={mainWidth - 2}
              height={contentHeight - 2}
              webBaseUrl={webDashboardUrl(host.backendUrl)}
              target={screenTarget}
              onBack={() => {
                setRoute('session');
                setFocus('composer');
              }}
              onOpenSession={openSession}
              onToast={pushToast}
              onHoldsBack={setScreenHoldsBack}
              onOpenScreen={openScreen}
            />
          </Panel>
        ) : null}
        {showSidebar && ui.sidebar.side === 'right' ? sidebarNode : null}
      </box>
      {ui.tabs.side === 'bottom' ? tabsNode : null}

      {route !== 'session' ? (
        <StatusBar
          left={
            <text fg={theme.dim} wrapMode="none">
              {trayLeft}
            </text>
          }
          right={quitArmed ? 'Press Ctrl+C again to quit' : `${focusHints(focus)}`}
        />
      ) : null}

      {toast ? (
        <Toast
          key={`toast:${toast.seq}`}
          message={toast.message}
          kind={toast.kind}
          placement={route === 'session' ? 'top' : 'bottom'}
          onDismiss={() => setToast(null)}
        />
      ) : null}

      {overlay === 'help' ? <HelpOverlay onClose={() => setOverlay(null)} /> : null}

      {overlay === 'links' ? (
        <LinksOverlay rows={links} onClose={() => setOverlay(null)} onToast={pushToast} />
      ) : null}

      {overlay === 'ports' && portsApi ? (
        <PortsOverlay
          rows={portsApi.rows}
          onToggle={portsApi.toggle}
          onAdd={portsApi.addManual}
          onClose={() => setOverlay(null)}
          onToast={pushToast}
        />
      ) : null}
    </box>
    </AgentNavProvider>
  );
}
