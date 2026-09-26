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
}

/** The project whose sessions the sidebar lists. */
export async function resolveProjectId(
  ...candidates: (string | null | undefined)[]
): Promise<string | null> {
  for (const candidate of candidates) {
    const trimmed = candidate?.trim();
    if (trimmed) return trimmed;
  }
  try {
    const projects = await kortix().projects.list();
    return projects?.[0]?.project_id ?? null;
  } catch {
    return null;
  }
}

interface RootProps {
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
  initialProjectId,
  initialSessionId,
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
      key={`${host.name}:${host.backendUrl}:${generation}`}
      host={host}
      projectId={projectId}
      accountId={host.accountId || null}
      initialSessionId={initialSessionId}
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
  const projectId = host ? await resolveProjectId(options.projectId, host.defaultProjectId) : null;

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

  const renderer = await createCliRenderer({ exitOnCtrlC: false });
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
          initialProjectId={projectId}
          initialSessionId={options.sessionId?.trim() || null}
          onQuit={() => shutdown(0)}
        />
      </QueryClientProvider>,
    );
  });
}
