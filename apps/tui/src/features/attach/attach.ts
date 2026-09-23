/**
 * Attach mode (SPEC §5.11) — hand the session to the stock opencode TUI.
 *
 * Two terminal programs cannot own one terminal at the same time, so the flow
 * is: stop the OpenTUI renderer, run `opencode attach` on the bare terminal,
 * then start the renderer again on the same session.
 *
 * **Why `renderer.suspend()`/`resume()` and not `destroy()` + re-create.**
 * `CliRenderer.suspend()` (`@opentui/core/renderer.d.ts:590`) does exactly the
 * teardown attach needs and nothing more: it pauses the render loop, disables
 * mouse reporting, detaches the stdin listener, drops raw mode, pauses stdin,
 * and — measured, not assumed — emits `ESC[?25h` then `ESC[?1049l`, leaving
 * the alternate screen with the cursor restored BEFORE the child starts.
 * `resume()` re-enters with `ESC[?1049h` and forces a full repaint. The React
 * tree, the QueryClient, the live SSE stream and the session's runtime all
 * survive, so returning from opencode is a repaint, not a reboot. `destroy()`
 * would restore the terminal just as well but throws the whole app away.
 *
 * Verified byte stream under a pty (`scripts/dev-attach.tsx`):
 *   ESC[?1049h … suspend → ESC[?25h ESC[?1049l … opencode … resume → ESC[?1049h
 *
 * The renderer is suspended inside a `try`/`finally` whose `finally` always
 * resumes. There is no path — success, `AttachOpenCodeError`, or a throw from
 * inside the child spawn — that leaves the terminal in the alternate screen.
 */

import type { ChildProcess } from 'node:child_process';

import type { Auth } from '@kortix/cli/src/api/auth.ts';
import {
  AttachOpenCodeError,
  type AttachOpenCodeOptions,
  type AttachOpenCodeResult,
  type AttachStage,
  attachOpenCodeSession,
} from '@kortix/cli/src/attach-opencode.ts';

import { type ResolvedHost, hostOrigin } from '../../auth/hosts.ts';

export type { AttachStage };

export interface AttachStatus {
  stage: AttachStage;
  /** Plain text, no ANSI, no trailing newline. */
  detail: string;
}

export interface AttachFailure {
  stage: AttachStage;
  message: string;
}

export type RunAttachResult = { exitCode: number } | { error: AttachFailure };

/** The two renderer methods attach mode needs. `CliRenderer` satisfies it. */
export interface AttachRendererControl {
  suspend(): void;
  resume(): void;
}

/** Signal plumbing, injectable so a test does not touch the real process. */
export interface AttachSignals {
  on(signal: NodeJS.Signals, handler: () => void): void;
  off(signal: NodeJS.Signals, handler: () => void): void;
}

export interface RunAttachDeps {
  attach?: (options: AttachOpenCodeOptions) => Promise<AttachOpenCodeResult>;
  /** Where the status lines go while the renderer is suspended. */
  write?: (text: string) => void;
  signals?: AttachSignals;
}

export interface RunAttachOptions {
  renderer: AttachRendererControl;
  host: ResolvedHost;
  projectId: string;
  sessionId: string;
  /** Extra args after `attach <url> --session <id>`. */
  extraArgs?: string[];
  onStatus?: (status: AttachStatus) => void;
  deps?: RunAttachDeps;
}

/**
 * Forwarded to the child while it owns the terminal.
 *
 * `SIGINT` and `SIGTERM`: registering a listener overrides the runtime's
 * terminate-on-signal default, which is the point — Ctrl+C inside opencode
 * must reach opencode, not kill the TUI that is waiting for it.
 * `SIGWINCH`: the renderer is suspended, so nothing else is watching the
 * window; the child needs the resize to re-lay-out.
 */
export const FORWARDED_SIGNALS: readonly NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGWINCH'];

const NODE_SIGNALS: AttachSignals = {
  on: (signal, handler) => {
    process.on(signal, handler);
  },
  off: (signal, handler) => {
    process.off(signal, handler);
  },
};

/**
 * The CLI's `Auth` record for this host.
 *
 * `api_base` is the ORIGIN, the same value `kortix login` writes to
 * `host.url`; `sdkBackendUrl` re-adds the `/v1` mount. The TUI's
 * `ResolvedHost.backendUrl` already carries `/v1`, so it is stripped here
 * rather than double-mounted.
 */
export function authFromHost(host: ResolvedHost): Auth {
  return {
    api_base: hostOrigin(host.backendUrl),
    token: host.token,
    user_id: '',
    user_email: host.userEmail,
    account_id: host.accountId,
    logged_in_at: new Date(0).toISOString(),
  };
}

export function attachFailureFrom(error: unknown): AttachFailure {
  if (error instanceof AttachOpenCodeError) {
    return { stage: error.stage, message: error.message };
  }
  return { stage: 'attached', message: error instanceof Error ? error.message : String(error) };
}

export async function runAttach(options: RunAttachOptions): Promise<RunAttachResult> {
  const deps = options.deps ?? {};
  const attach = deps.attach ?? attachOpenCodeSession;
  const write = deps.write ?? ((text: string) => void process.stdout.write(text));
  const signals = deps.signals ?? NODE_SIGNALS;

  const childRef: { current: ChildProcess | null } = { current: null };
  const handlers = FORWARDED_SIGNALS.map((signal) => ({
    signal,
    handler: () => {
      const child = childRef.current;
      if (!child || child.killed) return;
      try {
        child.kill(signal);
      } catch {
        // The child is already gone; its exit resolves the attach.
      }
    },
  }));

  // Outside the try on purpose: if suspend() itself fails the renderer is
  // still live and there is nothing to resume.
  options.renderer.suspend();
  try {
    for (const { signal, handler } of handlers) signals.on(signal, handler);
    write(`\nAttaching ${options.sessionId} to opencode…\n`);

    const result = await attach({
      auth: authFromHost(options.host),
      projectId: options.projectId,
      sessionId: options.sessionId,
      restartDormant: true,
      extraArgs: options.extraArgs,
      onStatus: (stage, detail) => {
        options.onStatus?.({ stage, detail });
        // One line per stage. The renderer is suspended, so this is the only
        // thing on screen while a binary downloads or a sandbox wakes.
        write(`  ${detail}\n`);
      },
      onChild: (child) => {
        childRef.current = child;
      },
    });
    return { exitCode: result.exitCode };
  } catch (error) {
    const failure = attachFailureFrom(error);
    write(`\n  attach failed at ${failure.stage}: ${failure.message}\n`);
    return { error: failure };
  } finally {
    for (const { signal, handler } of handlers) signals.off(signal, handler);
    childRef.current = null;
    // Every path re-enters the alternate screen. Nothing below this line may
    // throw before it runs.
    options.renderer.resume();
  }
}
