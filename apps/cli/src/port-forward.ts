import { createServer } from 'node:net';

import { type Auth, currentTokenFor } from './api/auth.ts';
import { clientFromAuth } from './api/client.ts';
import { type RunningSandboxPortProxy, startSandboxPortProxy, withKortixScope } from './api/sdk.ts';
import type { ProjectSession } from './api/types.ts';
import {
  type SessionRuntime,
  fetchProjectSession,
  resolveSessionRuntime,
} from './session-runtime.ts';

/**
 * VS Code-style local port forwarding for a Kortix session sandbox, as a
 * library. This is the whole of what `kortix sessions forward` does once a
 * session id and its ports are known, and it is what the TUI Ports panel
 * (`apps/tui/src/features/ports`) reuses for auto-forwarding — one engine,
 * two front ends, exactly like `attach-opencode.ts` is to `sessions connect`
 * and `apps/tui`'s attach flow.
 *
 * It PRINTS NOTHING. Progress is an `onStatus` callback; failure is a thrown
 * `PortForwardError`.
 *
 * Contract: deep import `@kortix/cli/src/port-forward.ts`. The CLI has no
 * public entry point — `src/index.ts` is the `kortix` executable.
 *
 * Restarting a stopped session is deliberately NOT this module's job: it
 * resolves the runtime with `onNotRunning: 'fail'`, so a stopped/completed/
 * failed session surfaces as `PortForwardError` wrapping
 * `SessionRuntimeError('not-running', …)` instead of being silently restarted
 * out from under the caller. `kortix sessions restart <id>` is the remedy.
 */

export type PortForwardStage = 'resolving' | 'forwarding';

export interface PortForwardStatusContext {
  session?: ProjectSession;
}

/** One port to forward: a sandbox port, and optionally the local port to bind it to. */
export interface ForwardRequest {
  /** The port a service listens on inside the sandbox (e.g. 3000). */
  sandboxPort: number;
  /**
   * Local port to bind. Omit to use the same number as `sandboxPort` (or the
   * next free one if that's taken). `0` requests an OS-assigned ephemeral
   * port — never probed for availability, since the OS already guarantees one.
   */
  localPort?: number;
}

/** One forward actually opened, with the port the OS actually bound. */
export interface ActiveForward {
  sandboxPort: number;
  localPort: number;
  /** `http://127.0.0.1:<localPort>` */
  url: string;
  close(): void;
}

export interface PortForwardResolveRequest {
  auth: Auth;
  projectId: string;
  sessionId: string;
  /** Already-fetched Kortix row; omit and the resolver fetches it. */
  session?: ProjectSession;
}

/** Test seams. Every default talks to the real API / SDK / OS network stack. */
export interface PortForwardDeps {
  resolveRuntime?: (request: PortForwardResolveRequest) => Promise<SessionRuntime>;
  startProxy?: (options: {
    runtimeUrl: string;
    token: string;
    port?: number;
  }) => RunningSandboxPortProxy;
  /** Whether a local port is free to bind. Only consulted when `localPort` is omitted. */
  isPortFree?: (port: number) => Promise<boolean>;
}

export interface StartPortForwardOptions {
  auth: Auth;
  projectId: string;
  sessionId: string;
  /** Already-fetched Kortix row; omit and it is fetched. */
  session?: ProjectSession;
  forwards: ForwardRequest[];
  /** Progress callback. `detail` is plain text: no ANSI, no trailing newline. */
  onStatus?: (stage: PortForwardStage, detail: string, context: PortForwardStatusContext) => void;
  deps?: PortForwardDeps;
}

export interface PortForwardResult {
  session: ProjectSession;
  forwards: ActiveForward[];
  /** Close every open forward. Idempotent. */
  close(): void;
}

export class PortForwardError extends Error {
  /** Where the flow stopped. */
  readonly stage: PortForwardStage;
  /** The underlying error — a `SessionRuntimeError` for a resolve failure. */
  override readonly cause?: unknown;

  constructor(stage: PortForwardStage, message: string, cause?: unknown) {
    super(message);
    this.name = 'PortForwardError';
    this.stage = stage;
    this.cause = cause;
  }
}

export async function startPortForward(
  options: StartPortForwardOptions,
): Promise<PortForwardResult> {
  if (options.forwards.length === 0) {
    throw new PortForwardError('resolving', 'Pass at least one --port.');
  }

  const deps = options.deps ?? {};
  const resolveRuntime = deps.resolveRuntime ?? resolveRuntimeViaApi;
  const startProxy = deps.startProxy ?? startSandboxPortProxy;
  const isPortFree = deps.isPortFree ?? defaultIsPortFree;

  const emit = (
    stage: PortForwardStage,
    detail: string,
    context: PortForwardStatusContext = {},
  ): void => {
    options.onStatus?.(stage, detail, context);
  };

  emit('resolving', `Resolving session ${options.sessionId}…`);
  let runtime: SessionRuntime;
  try {
    runtime = await resolveRuntime({
      auth: options.auth,
      projectId: options.projectId,
      sessionId: options.sessionId,
      session: options.session,
    });
  } catch (err) {
    throw new PortForwardError('resolving', (err as Error).message, err);
  }

  const active: ActiveForward[] = [];
  for (const request of options.forwards) {
    try {
      const localPort = await resolveLocalPort(request, isPortFree);
      const sandboxUrl = await withKortixScope(options.auth, async () =>
        runtime.handle.sandboxPortUrl(request.sandboxPort),
      );
      const proxy = startProxy({
        runtimeUrl: sandboxUrl,
        token: runtime.auth.token,
        getToken: () => currentTokenFor(runtime.auth),
        port: localPort,
      });
      const boundPort = Number(new URL(proxy.url).port);
      const forward: ActiveForward = {
        sandboxPort: request.sandboxPort,
        localPort: boundPort,
        url: proxy.url,
        close: proxy.close,
      };
      active.push(forward);
      emit('forwarding', `localhost:${boundPort} → sandbox:${request.sandboxPort}`, {
        session: runtime.session,
      });
    } catch (err) {
      for (const opened of active) opened.close();
      if (err instanceof PortForwardError) throw err;
      throw new PortForwardError('forwarding', (err as Error).message, err);
    }
  }

  return {
    session: runtime.session,
    forwards: active,
    close: () => {
      for (const forward of active) forward.close();
    },
  };
}

/**
 * Resolve the local port for one forward request:
 *  - `0` → OS-assigned ephemeral, never probed (the OS already guarantees one).
 *  - an explicit port → used as-is, never probed (an explicit choice is final).
 *  - omitted → the same number as the sandbox port, else the next free one.
 */
async function resolveLocalPort(
  request: ForwardRequest,
  isPortFree: (port: number) => Promise<boolean>,
): Promise<number> {
  if (request.localPort !== undefined) return request.localPort;
  let candidate = request.sandboxPort;
  while (!(await isPortFree(candidate))) candidate += 1;
  return candidate;
}

function defaultIsPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close(() => resolve(true));
    });
    server.listen(port, '127.0.0.1');
  });
}

async function resolveRuntimeViaApi(request: PortForwardResolveRequest): Promise<SessionRuntime> {
  const client = clientFromAuth(request.auth);
  const session =
    request.session ?? (await fetchProjectSession(client, request.projectId, request.sessionId));
  return resolveSessionRuntime({
    auth: request.auth,
    client,
    projectId: request.projectId,
    session,
    // Never restart here — see the module doc comment.
    onNotRunning: 'fail',
  });
}
