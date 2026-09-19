/**
 * The layout frame, the route state, and the global keymap.
 *
 * Everything visible is a child: the sidebar, the session column (which brings
 * the terminal panel with it), the secondary screens, the status bar, and the
 * one overlay slot. Route state lives here and nowhere else (SPEC §3).
 *
 * ── Why the overlays are here and not in the features ──
 * `ui/Panel` sets `overflow: 'hidden'`, and an absolutely positioned child is
 * scissored to its containing panel's rectangle. A `<Modal>`/`<Picker>` mounted
 * from inside a panel therefore renders as a sliver (wave 1 measured a
 * 10-column `┌─Switch a` where a 60-column dialog belonged). So the app owns
 * ONE overlay slot at the root of the tree and features ask for it through a
 * callback. The two in-flow pickers that stay inside their column on purpose —
 * `sidebar/column-picker.tsx` and `session/pickers/inline-picker.tsx` — are not
 * modals and are unaffected.
 *
 * ── Why the global handler gates on focus ──
 * `useKeyboard` subscribes at the GLOBAL level, which OpenTUI dispatches BEFORE
 * the focused renderable (`docs/opentui-api-reference.md` §2.4). A bare-letter
 * global binding is therefore a keystroke stolen from whatever text field has
 * focus. `?` is global only when no text input and no terminal has focus, and
 * while the terminal is focused only `TERMINAL_RESERVED_CHORDS` are the app's —
 * `Ctrl+C` belongs to the shell, so quitting there is `Ctrl+Q`.
 */

import { useProjectSessions } from '@kortix/sdk/react';
import { useKeyboard, useRenderer, useTerminalDimensions } from '@opentui/react';
import { useCallback, useEffect, useMemo, useState } from 'react';

import {
  type AppKeyState,
  type Focus,
  type Overlay,
  type Route,
  globalKeyAction,
} from './app-keys.ts';
import { type ResolvedHost, hostOrigin } from './auth/hosts.ts';
import { AccountScreen } from './features/account/index.ts';
import { AppsScreen } from './features/apps/index.ts';
import { attachResultToast } from './features/attach/attach-status.tsx';
import { type AttachStatus, type RunAttachResult, runAttach } from './features/attach/attach.ts';
import { CustomizeScreen } from './features/customize/index.ts';
import { FilesScreen } from './features/files/index.ts';
import { HelpOverlay } from './features/help/index.ts';
import { ReviewScreen } from './features/review/index.ts';
import { SessionView } from './features/session/index.ts';
import { focusHints } from './features/session/session-view.tsx';
import { Sidebar } from './features/sidebar/index.ts';
import { Switcher } from './features/switcher/index.ts';
import { kortix } from './kortix.ts';
import { copyToClipboard } from './lib/clipboard.ts';
import { sessionTitle } from './lib/session-groups.ts';
import { theme } from './theme.ts';
import { Panel, StatusBar, Toast, type ToastKind } from './ui/index.ts';

const SIDEBAR_WIDTH = 28;
/** Below this width the terminal panel takes the whole main area. */
export const SPLIT_MIN_COLUMNS = 100;
/** Below this width the sidebar is a picker (Ctrl+P), not a column. */
export const SIDEBAR_MIN_COLUMNS = 60;
/** Ctrl+C arms the quit; a second press inside this window leaves. */
const QUIT_ARM_MS = 2000;

/**
 * The Tab ring for a route.
 *
 * SPEC §6 order: sidebar → transcript → composer → terminal. The terminal
 * joins only while its panel is open, and only the session route has one.
 */
export function focusOrder(route: Route, showSidebar: boolean, terminalOpen: boolean): Focus[] {
  const order: Focus[] = showSidebar ? ['sidebar'] : [];
  if (route === 'session') {
    order.push('transcript', 'composer');
    if (terminalOpen) order.push('terminal');
  } else {
    order.push('screen');
  }
  return order;
}

export function nextFocus(current: Focus, order: Focus[], step: 1 | -1): Focus {
  const index = order.indexOf(current);
  if (index < 0) return order[0] as Focus;
  const next = (index + step + order.length) % order.length;
  return order[next] as Focus;
}

export interface AppProps {
  host: ResolvedHost;
  /** The project the session list reads. Resolved at boot. */
  projectId: string | null;
  /** The account that project belongs to. */
  accountId?: string | null;
  /** Pre-selected session, from `KORTIX_SESSION_ID`. */
  initialSessionId?: string | null;
  /** Tear the renderer down and leave. `src/main.tsx` owns the real exit. */
  onQuit: () => void;
  /** `Ctrl+H`. `src/main.tsx` remounts the app on the new host. */
  onSwitchHost?: () => void;
  /** Test seam for attach mode. Production uses the real `runAttach`. */
  attachImpl?: typeof runAttach;
}

export function App({
  host,
  projectId: initialProjectId,
  accountId: initialAccountId = null,
  initialSessionId = null,
  onQuit,
  onSwitchHost,
  attachImpl = runAttach,
}: AppProps) {
  // A SIGWINCH re-renders through this hook, and the re-render is what
  // repaints: every region's width/height is derived from it.
  const dimensions = useTerminalDimensions();
  const renderer = useRenderer();

  const [route, setRoute] = useState<Route>('session');
  const [overlay, setOverlay] = useState<Overlay>(null);
  const [focus, setFocus] = useState<Focus>(initialSessionId ? 'composer' : 'sidebar');
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [quitArmed, setQuitArmed] = useState(false);
  const [projectId, setProjectId] = useState<string | null>(initialProjectId);
  const [accountId, setAccountId] = useState<string | null>(
    initialAccountId || host.accountId || null,
  );
  const [sessionId, setSessionId] = useState<string | null>(initialSessionId);
  const [toast, setToast] = useState<{ message: string; kind: ToastKind; seq: number } | null>(
    null,
  );
  const [attachStatus, setAttachStatus] = useState<AttachStatus | null>(null);
  const [attaching, setAttaching] = useState(false);

  const wide = dimensions.width >= SPLIT_MIN_COLUMNS;
  const showSidebar = dimensions.width >= SIDEBAR_MIN_COLUMNS;
  const order = useMemo(
    () => focusOrder(route, showSidebar, terminalOpen),
    [route, showSidebar, terminalOpen],
  );

  useEffect(() => {
    if (!order.includes(focus)) setFocus(order[0] as Focus);
  }, [order, focus]);

  useEffect(() => {
    if (!quitArmed) return;
    const timer = setTimeout(() => setQuitArmed(false), QUIT_ARM_MS);
    return () => clearTimeout(timer);
  }, [quitArmed]);

  const pushToast = useCallback((message: string, kind: ToastKind = 'info') => {
    setToast((current) => ({ message, kind, seq: (current?.seq ?? 0) + 1 }));
  }, []);

  // The session list is already in the query cache for the sidebar; reading it
  // here for the header title and the switcher costs no extra request.
  const sessions = useProjectSessions(projectId ?? '', { enabled: Boolean(projectId) });
  const title = useMemo(() => {
    const row = sessions.sessions.find((entry) => entry.session_id === sessionId);
    return row ? sessionTitle(row) : sessionId ? sessionId.slice(0, 8) : undefined;
  }, [sessions.sessions, sessionId]);

  const openSession = useCallback((id: string) => {
    setSessionId(id);
    setRoute('session');
    setOverlay(null);
    setFocus('composer');
  }, []);

  const toggleTerminal = useCallback(() => {
    setTerminalOpen((open) => {
      if (open) {
        setFocus((current) => (current === 'terminal' ? 'composer' : current));
        return false;
      }
      setRoute('session');
      setFocus('terminal');
      return true;
    });
  }, []);

  const createSession = useCallback(async () => {
    if (!projectId) {
      pushToast('No project selected.', 'error');
      return;
    }
    try {
      // No title: session titles are server-owned (memory
      // `session-titles-kortix-owned`), so the create body stays empty.
      const created = await kortix().projects.createSession(projectId);
      await sessions.refetch();
      openSession(created.session_id);
      pushToast('Session created.');
    } catch (error) {
      pushToast(`Create failed: ${errorText(error)}`, 'error');
    }
  }, [projectId, sessions.refetch, openSession, pushToast]);

  /**
   * Hand the terminal to the stock opencode TUI and take it back on exit.
   *
   * `renderer.suspend()`/`resume()` are the two methods `runAttach` needs
   * (`@opentui/core/renderer.d.ts:588-589`); `suspend()` leaves the alternate
   * screen before the child starts and `resume()` re-enters and repaints.
   * Nothing else renders while it is suspended, which is why `attaching` gates
   * the key handler too.
   */
  const attach = useCallback(
    async (targetSessionId: string) => {
      if (!projectId) {
        pushToast('No project selected.', 'error');
        return;
      }
      if (attaching) return;
      setAttaching(true);
      setOverlay(null);
      try {
        const result: RunAttachResult = await attachImpl({
          renderer: {
            suspend: () => renderer.suspend(),
            resume: () => renderer.resume(),
          },
          host,
          projectId,
          sessionId: targetSessionId,
          onStatus: setAttachStatus,
        });
        const { message, kind } = attachResultToast(result);
        pushToast(message, kind);
      } catch (error) {
        pushToast(`Attach failed: ${errorText(error)}`, 'error');
      } finally {
        setAttachStatus(null);
        setAttaching(false);
      }
    },
    [projectId, attaching, attachImpl, renderer, host, pushToast],
  );

  const runCommand = useCallback(
    (command: 'new' | 'terminal' | 'files' | 'help' | 'quit' | 'attach' | 'stop') => {
      if (command === 'new') return void createSession();
      if (command === 'terminal') return toggleTerminal();
      if (command === 'files') return setRoute('files');
      if (command === 'help') return setOverlay('help');
      if (command === 'quit') return onQuit();
      if (command === 'attach') {
        if (sessionId) void attach(sessionId);
        else pushToast('Open a session first.', 'error');
        return;
      }
      // `stop` is handled inside the composer, which already called `cancel`.
      pushToast('Stopping the current turn…');
    },
    [createSession, toggleTerminal, onQuit, sessionId, attach, pushToast],
  );

  useKeyboard((key) => {
    // The decision is a pure function (`app-keys.ts`); this handler only
    // performs it. That is what makes the gating rules assertable.
    const action = globalKeyAction(key, { focus, route, overlay, quitArmed, attaching });
    if (!action) return;
    if (action.kind !== 'quit' && action.kind !== 'arm-quit') key.preventDefault();
    if (quitArmed && action.kind !== 'quit' && action.kind !== 'arm-quit') setQuitArmed(false);

    switch (action.kind) {
      case 'quit':
        return onQuit();
      case 'arm-quit':
        return setQuitArmed(true);
      case 'focus':
        return setFocus((current) => nextFocus(current, order, action.step));
      case 'toggle-terminal':
        return toggleTerminal();
      case 'overlay':
        return setOverlay(action.overlay);
      case 'new-session':
        return void createSession();
      case 'attach':
        if (sessionId) return void attach(sessionId);
        return pushToast('Open a session first.', 'error');
      case 'switch-host':
        if (onSwitchHost) return onSwitchHost();
        return pushToast('Host switching needs the login screen.', 'error');
      case 'route':
        setRoute(action.route);
        return setFocus('screen');
      case 'back':
        setRoute('session');
        return setFocus('composer');
      case 'focus-composer':
        return setFocus('composer');
    }
  });

  const sidebarHeight = Math.max(dimensions.height - 1, 3);
  const mainWidth = Math.max(dimensions.width - (showSidebar ? SIDEBAR_WIDTH : 0), 20);
  const hints = attaching
    ? 'opencode has the terminal…'
    : quitArmed
      ? 'Press Ctrl+C again to quit'
      : `${focusHints(focus)} · ? help`;

  return (
    <box
      flexDirection="column"
      width={dimensions.width}
      height={dimensions.height}
      backgroundColor={theme.bg}
    >
      <box flexDirection="row" flexGrow={1} overflow="hidden">
        {showSidebar ? (
          <Panel
            title={host.source === 'env' ? 'kortix' : host.name}
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
              height={sidebarHeight - 2}
              onOpenSession={openSession}
              onNewSession={openSession}
              onNavigate={(screen) => {
                setRoute(screen);
                setFocus('screen');
              }}
              onProjectChange={(nextProject, nextAccount) => {
                setProjectId(nextProject);
                if (nextAccount) setAccountId(nextAccount);
                setSessionId(null);
                setRoute('session');
              }}
              // Only fills a blank (an env host with no KORTIX_ACCOUNT_ID);
              // it keeps the open project and session, unlike a real pick.
              onAccountResolved={(resolved) => {
                setAccountId((current) => current ?? resolved);
              }}
              onAccountChange={(nextAccount) => {
                setAccountId(nextAccount);
                setProjectId(null);
                setSessionId(null);
                setRoute('session');
              }}
              onAttach={(id) => void attach(id)}
              onToast={pushToast}
            />
          </Panel>
        ) : null}

        {route === 'session' && projectId && sessionId ? (
          <SessionView
            projectId={projectId}
            sessionId={sessionId}
            title={title}
            focus={
              focus === 'transcript' || focus === 'composer' || focus === 'terminal' ? focus : null
            }
            width={mainWidth}
            height={sidebarHeight}
            terminalOpen={terminalOpen}
            wide={wide}
            onFocus={setFocus}
            onCloseTerminal={() => {
              setTerminalOpen(false);
              setFocus('composer');
            }}
            onCommand={runCommand}
            onToast={pushToast}
          />
        ) : null}

        {route === 'session' && !(projectId && sessionId) ? (
          <Panel focused={focus !== 'sidebar'} flexGrow={1} minWidth={20} padding={1}>
            <text fg={theme.faint}>
              {projectId
                ? 'Pick a session on the left, or press Ctrl+N for a new one.'
                : 'No project on this host. Press Ctrl+P to pick one.'}
            </text>
          </Panel>
        ) : null}

        {route !== 'session' ? (
          <Panel
            title={route}
            footer="Esc back"
            focused={focus === 'screen'}
            flexGrow={1}
            minWidth={20}
          >
            <Screen
              route={route}
              projectId={projectId}
              accountId={accountId}
              sessionId={sessionId}
              focused={focus === 'screen'}
              width={mainWidth - 2}
              height={sidebarHeight - 2}
              webBaseUrl={hostOrigin(host.backendUrl)}
              onBack={() => {
                setRoute('session');
                setFocus('composer');
              }}
              onOpenSession={openSession}
              onToast={pushToast}
            />
          </Panel>
        ) : null}
      </box>

      <StatusBar
        left={
          <text fg={theme.dim} wrapMode="none">
            {statusLeft(host, sessions.sessions.length, projectId)}
          </text>
        }
        right={hints}
      />

      {attachStatus ? (
        <Toast
          key={`attach:${attachStatus.stage}`}
          message={`${attachStatus.stage} — ${attachStatus.detail}`}
          timeoutMs={0}
        />
      ) : null}

      {toast ? (
        <Toast
          key={`toast:${toast.seq}`}
          message={toast.message}
          kind={toast.kind}
          onDismiss={() => setToast(null)}
        />
      ) : null}

      {overlay === 'help' ? <HelpOverlay onClose={() => setOverlay(null)} /> : null}

      {overlay === 'switcher' ? (
        <Switcher
          projectId={projectId}
          accountId={accountId}
          onPick={(pick) => {
            setOverlay(null);
            if (pick.kind === 'session') openSession(pick.sessionId);
            else {
              setProjectId(pick.projectId);
              setSessionId(null);
              setRoute('session');
              setFocus('sidebar');
            }
          }}
          onClose={() => setOverlay(null)}
        />
      ) : null}
    </box>
  );
}

function statusLeft(host: ResolvedHost, sessionCount: number, projectId: string | null): string {
  const parts = [host.source === 'env' ? 'env' : host.name];
  if (host.userEmail) parts.push(host.userEmail);
  if (projectId) parts.push(sessionCount === 1 ? '1 session' : `${sessionCount} sessions`);
  return parts.join(' · ');
}

function errorText(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error) return error;
  return 'Unknown error';
}

interface ScreenProps {
  route: Route;
  projectId: string | null;
  accountId: string | null;
  sessionId: string | null;
  focused: boolean;
  width: number;
  height: number;
  /** The Kortix web origin, for screens that print a link the TUI cannot open. */
  webBaseUrl: string;
  onBack(): void;
  onOpenSession(sessionId: string): void;
  onToast(message: string, kind?: ToastKind): void;
}

/** The secondary screens. Each one owns its own keys while it has focus. */
function Screen({
  route,
  projectId,
  accountId,
  sessionId,
  focused,
  width,
  height,
  webBaseUrl,
  onBack,
  onOpenSession,
  onToast,
}: ScreenProps) {
  if (route === 'files') {
    if (!projectId || !sessionId) return <Missing text="Open a session to browse its files." />;
    return (
      <FilesScreen
        projectId={projectId}
        sessionId={sessionId}
        focused={focused}
        width={width}
        height={height}
        onBack={onBack}
        onToast={onToast}
      />
    );
  }
  if (route === 'review') {
    if (!projectId) return <Missing text="No project selected." />;
    return (
      <ReviewScreen
        projectId={projectId}
        focused={focused}
        width={width}
        height={height}
        onBack={onBack}
        onOpenSession={onOpenSession}
        onToast={onToast}
      />
    );
  }
  if (route === 'apps') {
    return (
      <AppsScreen
        projectId={projectId}
        accountId={accountId}
        focused={focused}
        width={width}
        height={height}
        onBack={onBack}
        onToast={onToast}
        // `y` on an App row. The screen spawns no process itself; the host
        // injects the copy. `copyToClipboard` answers instead of throwing, so
        // the failure is re-thrown here — that is the screen's "Copy failed"
        // path, and a silent success toast on a box with no clipboard tool
        // would be a lie.
        onCopy={async (text: string) => {
          const result = await copyToClipboard(text);
          if (!result.ok) throw new Error(result.error ?? 'no clipboard tool');
        }}
      />
    );
  }
  if (route === 'customize') {
    return (
      <CustomizeScreen
        projectId={projectId}
        accountId={accountId}
        focused={focused}
        width={width}
        height={height}
        webBaseUrl={webBaseUrl}
        onBack={onBack}
        onToast={onToast}
      />
    );
  }
  if (!accountId) return <Missing text="No account on this host." />;
  return (
    <AccountScreen
      accountId={accountId}
      focused={focused}
      width={width}
      height={height}
      onBack={onBack}
      onToast={onToast}
    />
  );
}

function Missing({ text }: { text: string }) {
  return <text fg={theme.faint}>{text}</text>;
}
