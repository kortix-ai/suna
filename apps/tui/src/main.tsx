/**
 * Boot.
 *
 *   register elements → host config → Kortix client → QueryClient
 *   → CLI renderer → <Root/>
 *
 * The order matters.
 *
 *  1. `registerEmbeddedTerminal()` runs before the first render.
 *     `<embedded-terminal>` is not a built-in JSX tag; `extend()` has to have
 *     run before the element is ever created (`features/terminal/register.ts`).
 *  2. `createKortix` installs the process-global platform config that every
 *     `@kortix/sdk/react` hook reads, so it runs before the first hook renders.
 *     When no host is configured yet the login screen runs FIRST and calls
 *     `initKortix` itself once a host is picked.
 *  3. The renderer is created with `exitOnCtrlC: false`: the app owns Ctrl+C
 *     (press twice), and every exit path goes through `shutdown()` so the
 *     terminal is restored — an alternate-screen renderer that dies without
 *     `destroy()` leaves the user with a broken shell.
 *
 * This module is the app as a FUNCTION. `runTui()` resolves the exit code
 * instead of calling `process.exit`, because it has two callers and only one of
 * them owns the process:
 *
 *   - `src/index.tsx` — `pnpm --filter @kortix/tui dev`, which exits on it.
 *   - `kortix tui` (`apps/cli/src/commands/tui.ts`), which makes it the
 *     command's exit code.
 *
 * The CLI reaches this module through a DYNAMIC import, so the OpenTUI native
 * library and React load for `kortix tui` and for no other subcommand.
 */

import { createCliRenderer } from '@opentui/core';
import { createRoot } from '@opentui/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useCallback, useState } from 'react';

import { App } from './app.tsx';
import { type ResolvedHost, listHostEntries, tokenRejectionNotice } from './auth/hosts.ts';
import { LoginScreen } from './features/login/index.ts';
import { registerEmbeddedTerminal } from './features/terminal/register.ts';
import { initKortix, kortix } from './kortix.ts';

registerEmbeddedTerminal();

export interface RunTuiOptions {
  /** The host to run against, or null to open the login screen. */
  host: ResolvedHost | null;
  /** The project whose sessions the sidebar lists. Falls back to the host's
   *  default project, then to the first project the host can see. */
  projectId?: string | null;
  /** Open this session at boot. */
  sessionId?: string | null;
  /** Create a session in the project at boot and open it (`kortixt --new`). */
  newSession?: { agentName?: string } | null;
  /** Open the sandbox terminal panel at boot, focused (`--terminal`). */
  openTerminal?: boolean;
  /** Start with the sidebar hidden (`--no-sidebar`). `Alt+B` shows it. */
  hideSidebar?: boolean;
  /**
   * Take the mouse (`--mouse`). Off by default: with mouse reporting on, the
   * host terminal hands every click and drag to the app, so its own text
   * selection, copy-on-select and Cmd+click on a URL stop working — and the
   * app has no mouse features to give back for that.
   */
  mouse?: boolean;
}

export interface BootSessionDeps {
  createSession: (projectId: string, agentName?: string) => Promise<{ session_id: string }>;
}

const DEFAULT_BOOT_SESSION_DEPS: BootSessionDeps = {
  createSession: (projectId, agentName) =>
    kortix().projects.createSession(projectId, agentName ? { agent_name: agentName } : {}),
};

/**
 * `--new`: the session `kortixt` opens. Created BEFORE the renderer exists so
 * the app boots straight into it; a failure is a note, not a dead TUI — the
 * sidebar still works and Ctrl+N is one key away.
 */
export async function bootSession(
  projectId: string | null,
  request: RunTuiOptions['newSession'],
  note: (text: string) => void,
  deps: BootSessionDeps = DEFAULT_BOOT_SESSION_DEPS,
): Promise<string | null> {
  if (!request) return null;
  if (!projectId) {
    note('--new needs a project: none is configured on this host.');
    return null;
  }
  try {
    const created = await deps.createSession(projectId, request.agentName);
    return created.session_id;
  } catch (error) {
    const reason = error instanceof Error && error.message ? error.message : String(error);
    note(
      `Could not create a session${request.agentName ? ` for agent ${request.agentName}` : ''}: ${reason}`,
    );
    return null;
  }
}

export interface ResolveProjectDeps {
  /** Resolves when the project exists and this host may read it; rejects otherwise. */
  getProject: (projectId: string) => Promise<unknown>;
  /**
   * The host ACCOUNT's projects. A PAT can see every account its user belongs
   * to, and the unscoped list answers across all of them — on the first
   * machine this was measured the first row was a project in another account,
   * so the sidebar showed a raw id and the wrong sessions.
   */
  listProjects: (
    accountId: string | null,
  ) => Promise<Array<{ project_id: string }> | null | undefined>;
  /** Where a skipped candidate is reported. */
  note: (text: string) => void;
}

const DEFAULT_RESOLVE_PROJECT_DEPS: ResolveProjectDeps = {
  getProject: (projectId) => kortix().projects.get(projectId),
  listProjects: (accountId) =>
    accountId ? kortix().projects.listForAccount(accountId) : kortix().projects.list(),
  note: (text) => process.stderr.write(`${text}\n`),
};

/**
 * The project whose sessions the sidebar lists.
 *
 * Every candidate is PROVED before it is used. The CLI config's
 * `default_project` is written at login and never revalidated, so a project
 * that was deleted or moved since then boots the TUI onto a dead id: a raw
 * id where the name should be, an empty session list, and Files saying "Open
 * a session" with nothing to open. A candidate that does not answer is
 * skipped with one stderr line, and the first project the host can see wins.
 */
export async function resolveProjectId(
  candidates: (string | null | undefined)[],
  accountId: string | null = null,
  deps: ResolveProjectDeps = DEFAULT_RESOLVE_PROJECT_DEPS,
): Promise<string | null> {
  for (const candidate of candidates) {
    const trimmed = candidate?.trim();
    if (!trimmed) continue;
    try {
      await deps.getProject(trimmed);
      return trimmed;
    } catch (error) {
      const reason = error instanceof Error && error.message ? error.message : String(error);
      deps.note(
        `Project ${trimmed.slice(0, 8)} is not available on this host (${reason}); using the first project in your account.`,
      );
    }
  }
  try {
    const projects = await deps.listProjects(accountId);
    return projects?.[0]?.project_id ?? null;
  } catch {
    return null;
  }
}

interface RootProps {
  /** The account the boot project belongs to (may differ from the host's active account). */
  initialAccountId: string | null;
  /** `--terminal`: open the sandbox terminal panel at boot. */
  initialTerminalOpen: boolean;
  /** `--no-sidebar`: start with the sidebar hidden. */
  initialSidebarHidden: boolean;
  /** What boot had to work around (a dead default project), shown once as a toast. */
  bootNotice: string | null;
  initialHost: ResolvedHost | null;
  /** Why boot fell through to the login screen, when it did. */
  initialNotice: string | null;
  initialProjectId: string | null;
  initialSessionId: string | null;
  onQuit: () => void;
}

/**
 * Login or app.
 *
 * The host is state, so `Ctrl+H` is a state change and not a process restart:
 * the login screen comes back, the user picks another host, `initKortix`
 * rebuilds the one client, and the app remounts with a fresh `key` so every
 * query and every SSE stream is torn down with the old host.
 */
function Root({
  initialHost,
  initialNotice,
  bootNotice,
  initialProjectId,
  initialSessionId,
  initialAccountId,
  initialTerminalOpen,
  initialSidebarHidden,
  onQuit,
}: RootProps) {
  const [host, setHost] = useState<ResolvedHost | null>(initialHost);
  const [notice, setNotice] = useState<string | null>(initialNotice);
  /** The host `Alt+H` left behind, so Esc can put it back. Null at boot. */
  const [previousHost, setPreviousHost] = useState<ResolvedHost | null>(null);
  const [projectId, setProjectId] = useState<string | null>(initialProjectId);
  const [generation, setGeneration] = useState(0);

  const onLoggedIn = useCallback((resolved: ResolvedHost) => {
    setNotice(null);
    initKortix(resolved);
    setHost(resolved);
    setPreviousHost(null);
    setProjectId(resolved.defaultProjectId ?? null);
    setGeneration((value) => value + 1);
  }, []);

  // Esc on the host list. With a host behind it this is "never mind" and the
  // app comes back on the SAME host — `initKortix` again because the login
  // screen's own validation may have re-pointed the process-global config.
  // At boot there is nothing behind it, so it quits.
  const onCancel = useCallback(() => {
    if (!previousHost) return onQuit();
    initKortix(previousHost);
    setHost(previousHost);
    setPreviousHost(null);
  }, [previousHost, onQuit]);

  if (!host) {
    return (
      <LoginScreen
        hosts={listHostEntries()}
        width={process.stdout.columns ?? 80}
        height={process.stdout.rows ?? 24}
        onLoggedIn={onLoggedIn}
        onQuit={onCancel}
        cancelLabel={previousHost ? 'Esc back' : 'Esc quit'}
        notice={notice}
      />
    );
  }

  return (
    <App
      bootNotice={bootNotice}
      key={`${host.name}:${host.backendUrl}:${generation}`}
      host={host}
      projectId={projectId}
      accountId={initialAccountId ?? (host.accountId || null)}
      initialSessionId={initialSessionId}
      initialTerminalOpen={initialTerminalOpen}
      initialSidebarHidden={initialSidebarHidden}
      onQuit={onQuit}
      onSwitchHost={() => {
        setPreviousHost(host);
        setHost(null);
      }}
    />
  );
}

/**
 * Boot preflight: prove the resolved token before the first hook renders.
 *
 * Without this a rejected token — most often a stale `KORTIX_TOKEN` a sandbox
 * session left exported in the shell, which outranks `kortix login` for the
 * CLI and the TUI alike — boots an app whose every list is empty and whose
 * account picker has nothing to pick. The login screen with the reason is the
 * honest state. `validateToken` never throws.
 */
export async function preflight(host: ResolvedHost): Promise<string | null> {
  const result = await kortix().validateToken();
  if (result.valid) return null;
  return tokenRejectionNotice(
    host,
    result.error?.status ?? 0,
    result.error?.message ?? 'token rejected',
  );
}

/**
 * Run the whole app and resolve its exit code.
 *
 * Resolves only once the renderer has been destroyed, so the caller writing to
 * stdout afterwards writes to a restored terminal, not into the alternate
 * screen. Every process-level handler this installs is removed on the way out:
 * the CLI keeps running in this process after `kortix tui` returns.
 */
export async function runTui(options: RunTuiOptions): Promise<number> {
  let host = options.host;
  let notice: string | null = null;
  if (host) {
    initKortix(host);
    notice = await preflight(host);
    if (notice) host = null;
  }
  const bootNotes: string[] = [];
  const projectId = host
    ? await resolveProjectId([options.projectId, host.defaultProjectId], host.accountId || null, {
        ...DEFAULT_RESOLVE_PROJECT_DEPS,
        note: (text) => {
          bootNotes.push(text);
          process.stderr.write(`${text}\n`);
        },
      })
    : null;

  // `--project` may name a project outside the host's active account; the
  // sidebar and every account-scoped read follow the PROJECT's account.
  let bootAccountId: string | null = null;
  if (host && projectId) {
    try {
      const project = (await kortix().projects.get(projectId)) as { account_id?: string | null };
      bootAccountId = project.account_id ?? null;
    } catch {
      bootAccountId = null;
    }
  }
  const createdSessionId = host
    ? await bootSession(projectId, options.newSession ?? null, (text) => {
        bootNotes.push(text);
        process.stderr.write(`${text}\n`);
      })
    : null;
  const initialSessionId = createdSessionId ?? options.sessionId?.trim() ?? null;

  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        // There is no window to focus in a terminal, and a TUI that refetches
        // on every keystroke burns the API. The SDK's own query contracts set
        // per-query staleness; these are only the process-wide floors.
        refetchOnWindowFocus: false,
        retry: 2,
      },
    },
  });

  const renderer = await createCliRenderer({
    exitOnCtrlC: false,
    useMouse: Boolean(options.mouse),
  });
  const root = createRoot(renderer);

  return await new Promise<number>((resolve) => {
    let stopped = false;
    const shutdown = (code = 0, error?: unknown): void => {
      if (stopped) return;
      stopped = true;
      process.off('uncaughtException', onUncaught);
      process.off('unhandledRejection', onRejection);
      process.off('SIGTERM', onSigterm);
      process.off('SIGHUP', onSighup);
      try {
        root.unmount();
      } catch {
        // A reconciler already torn down by the error we are handling.
      }
      renderer.destroy();
      if (error) {
        process.stderr.write(
          `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
        );
      }
      resolve(code);
    };

    const onUncaught = (error: unknown) => shutdown(1, error);
    const onRejection = (error: unknown) => shutdown(1, error);
    const onSigterm = () => shutdown(0);
    const onSighup = () => shutdown(0);

    process.on('uncaughtException', onUncaught);
    process.on('unhandledRejection', onRejection);
    process.on('SIGTERM', onSigterm);
    process.on('SIGHUP', onSighup);

    root.render(
      <QueryClientProvider client={queryClient}>
        <Root
          initialHost={host}
          initialNotice={notice}
          bootNotice={bootNotes.length ? bootNotes.join(' ') : null}
          initialProjectId={projectId}
          initialSessionId={initialSessionId}
          initialAccountId={bootAccountId}
          initialTerminalOpen={Boolean(options.openTerminal) && Boolean(initialSessionId)}
          initialSidebarHidden={Boolean(options.hideSidebar)}
          onQuit={() => shutdown(0)}
        />
      </QueryClientProvider>,
    );
  });
}
