import { type ChildProcess, spawn } from 'node:child_process';

import type { Auth } from './api/auth.ts';
import { clientFromAuth } from './api/client.ts';
import {
  type RunningOpenCodeProxy,
  startOpenCodeProxy,
  unwrapRuntime,
  withKortixScope,
} from './api/sdk.ts';
import type { ProjectSession } from './api/types.ts';
import { ensureOpencodeBin, isValidOpencodeVersion } from './opencode-bin.ts';
import {
  fetchProjectSession,
  resolveSessionRuntime,
  SessionRuntimeError,
  type SessionRuntime,
} from './session-runtime.ts';

/**
 * `opencode attach` against a Kortix session, as a library.
 *
 * This is the whole of what `kortix sessions connect` does once a session id
 * and its project are known: resolve the session's live runtime, download the
 * version-matched `opencode` binary, open a token-injecting localhost proxy,
 * run `opencode attach` on inherited stdio, and close the proxy afterwards.
 *
 * It PRINTS NOTHING. Every line `sessions connect` writes today is either an
 * `onStatus` callback or the message on the thrown `AttachOpenCodeError`, so an
 * embedder (`apps/tui`) can call it with its own renderer suspended.
 *
 * Contract: deep import `@kortix/cli/src/attach-opencode.ts`. The CLI has no
 * public entry point — `src/index.ts` is the `kortix` executable.
 */

export type AttachStage =
  | 'resolving'
  | 'restarting'
  | 'downloading-binary'
  | 'proxy-ready'
  | 'attached';

/**
 * Structured companions to the human `detail` line, filled in as they become
 * known. `sessions connect` uses them to rebuild its coloured output verbatim;
 * an embedder can ignore them and print `detail`.
 */
export interface AttachStatusContext {
  session?: ProjectSession;
  opencodeSessionId?: string;
  proxyUrl?: string;
}

/** Resolution request handed to the (injectable) session resolver. */
export interface AttachResolveRequest {
  auth: Auth;
  projectId: string;
  sessionId: string;
  /** Already-fetched Kortix row; omit and the resolver fetches it. */
  session?: ProjectSession;
  /** Restart + `/start`-poll a session that is not running. */
  restartDormant: boolean;
  /** Called when the restart + wait is about to run. */
  onStarting: (session: ProjectSession) => void;
}

/** Test seams. Every default talks to the real API / filesystem / process. */
export interface AttachOpenCodeDeps {
  resolveRuntime?: (request: AttachResolveRequest) => Promise<SessionRuntime>;
  probeRuntimeVersion?: (runtime: SessionRuntime) => Promise<string | undefined>;
  ensureBin?: (options: { version?: string }) => Promise<{ bin: string }>;
  startProxy?: (options: {
    runtimeUrl: string;
    token: string;
    port?: number;
  }) => RunningOpenCodeProxy;
  spawnAttach?: (
    bin: string,
    args: string[],
    onChild?: (child: ChildProcess) => void,
  ) => Promise<number>;
}

export interface AttachOpenCodeOptions {
  auth: Auth;
  projectId: string;
  sessionId: string;
  /** Already-fetched Kortix row; omit and it is fetched. */
  session?: ProjectSession;
  /** Extra args after `attach <url> --session <id>`; same semantics as `--` in the CLI. */
  extraArgs?: string[];
  /** Local loopback proxy port. Default 0 (ephemeral). */
  proxyPort?: number;
  /**
   * Restart a stopped/completed/failed session and wait for it instead of
   * failing. Default true. `sessions connect` passes false: its picker already
   * restarts, and a bare stopped id must keep its "run `sessions restart`" error.
   */
  restartDormant?: boolean;
  /** Progress callback. `detail` is plain text: no ANSI, no trailing newline. */
  onStatus?: (stage: AttachStage, detail: string, context: AttachStatusContext) => void;
  /** Receives the spawned child so the caller can forward signals. */
  onChild?: (child: ChildProcess) => void;
  deps?: AttachOpenCodeDeps;
}

export interface AttachOpenCodeResult {
  exitCode: number;
  opencodeSessionId: string;
  proxyUrl: string;
}

export class AttachOpenCodeError extends Error {
  /** Where the flow stopped. */
  readonly stage: AttachStage;
  /** The underlying error — a `SessionRuntimeError` for resolve/restart failures. */
  override readonly cause?: unknown;

  constructor(stage: AttachStage, message: string, cause?: unknown) {
    super(message);
    this.name = 'AttachOpenCodeError';
    this.stage = stage;
    this.cause = cause;
  }
}

/** Display name for a session row — the custom/auto name, else its short id. */
export function attachSessionLabel(session: ProjectSession): string {
  return session.name ?? session.session_id.split('-')[0];
}

export async function attachOpenCodeSession(
  options: AttachOpenCodeOptions,
): Promise<AttachOpenCodeResult> {
  const deps = options.deps ?? {};
  const resolveRuntime = deps.resolveRuntime ?? resolveRuntimeViaApi;
  const probeRuntimeVersion = deps.probeRuntimeVersion ?? runtimeOpencodeVersion;
  const ensureBin = deps.ensureBin ?? ensureOpencodeBin;
  const startProxy = deps.startProxy ?? startOpenCodeProxy;
  const spawnAttach = deps.spawnAttach ?? spawnOpenCodeAttach;

  const emit = (stage: AttachStage, detail: string, context: AttachStatusContext = {}): void => {
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
      restartDormant: options.restartDormant ?? true,
      onStarting: (session) =>
        emit('restarting', `Session is ${session.status} — starting its sandbox…`, { session }),
    });
  } catch (err) {
    throw new AttachOpenCodeError(resolveFailureStage(err), (err as Error).message, err);
  }
  if (!runtime.opencodeSessionId) {
    throw new AttachOpenCodeError(
      'resolving',
      `Session ${options.sessionId} has no OpenCode session to attach to.`,
    );
  }
  const attachContext: AttachStatusContext = {
    session: runtime.session,
    opencodeSessionId: runtime.opencodeSessionId,
  };

  // Resolve (and, first time, download) the version-matched binary BEFORE the
  // proxy exists — a multi-minute download must not sit on an open proxy.
  let bin: string;
  try {
    bin = (await ensureBin({ version: await probeRuntimeVersion(runtime) })).bin;
  } catch (err) {
    throw new AttachOpenCodeError('downloading-binary', (err as Error).message, err);
  }
  emit('downloading-binary', `OpenCode binary ready (${bin}).`, attachContext);

  let proxy: RunningOpenCodeProxy;
  try {
    proxy = startProxy({
      runtimeUrl: runtime.runtimeUrl,
      token: runtime.auth.token,
      port: options.proxyPort ?? 0,
    });
  } catch (err) {
    throw new AttachOpenCodeError('proxy-ready', (err as Error).message, err);
  }

  try {
    attachContext.proxyUrl = proxy.url;
    emit('proxy-ready', `Local OpenCode proxy listening on ${proxy.url}.`, attachContext);
    const args = buildAttachArgs(proxy.url, runtime.opencodeSessionId, options.extraArgs ?? []);
    emit(
      'attached',
      `Connecting to ${attachSessionLabel(runtime.session)} ` +
        `(OpenCode ${runtime.opencodeSessionId}, local ${proxy.url})`,
      attachContext,
    );
    let exitCode: number;
    try {
      exitCode = await spawnAttach(bin, args, options.onChild);
    } catch (err) {
      throw new AttachOpenCodeError('attached', (err as Error).message, err);
    }
    return { exitCode, opencodeSessionId: runtime.opencodeSessionId, proxyUrl: proxy.url };
  } finally {
    proxy.close();
  }
}

/** `/start` failures happened while bringing the sandbox up, not while locating it. */
function resolveFailureStage(err: unknown): AttachStage {
  if (err instanceof SessionRuntimeError && (err.kind === 'start-failed' || err.kind === 'timeout')) {
    return 'restarting';
  }
  return 'resolving';
}

async function resolveRuntimeViaApi(request: AttachResolveRequest): Promise<SessionRuntime> {
  const client = clientFromAuth(request.auth);
  const session =
    request.session ?? (await fetchProjectSession(client, request.projectId, request.sessionId));
  return resolveSessionRuntime({
    auth: request.auth,
    client,
    projectId: request.projectId,
    session,
    onNotRunning: request.restartDormant ? 'start' : 'fail',
    onStarting: request.onStarting,
  });
}

/**
 * The version the session's OpenCode server actually runs, from its own
 * `/global/health` — the sandbox image may be newer or older than this CLI's
 * baked pin, and the TUI must match the server, not the pin. Falls back to
 * undefined (→ the runtime-versions pin) when the probe fails.
 *
 * The value crosses a trust boundary: it comes from inside the sandbox and
 * ends up in a download URL and an executable path, so anything that is not
 * strictly `X.Y.Z(-tag)` is discarded, not truncated.
 */
async function runtimeOpencodeVersion(runtime: SessionRuntime): Promise<string | undefined> {
  try {
    const health = unwrapRuntime(
      await withKortixScope(runtime.auth, () => runtime.runtime.global.health()),
    );
    const version = (health as { version?: unknown }).version;
    return typeof version === 'string' && isValidOpencodeVersion(version) ? version : undefined;
  } catch {
    return undefined;
  }
}

export function buildAttachArgs(
  url: string,
  opencodeSessionId: string,
  extraArgs: string[],
): string[] {
  const hasContinuation = extraArgs.some(
    (arg) =>
      arg === '--session' ||
      arg === '-s' ||
      arg.startsWith('--session=') ||
      arg === '--continue' ||
      arg === '-c',
  );
  return [
    'attach',
    url,
    ...(hasContinuation ? [] : ['--session', opencodeSessionId]),
    ...extraArgs,
  ];
}

/**
 * Run `opencode attach` on inherited stdio. Resolves with the child's exit code
 * (130 for a signal); rejects when the binary could not be executed at all.
 */
function spawnOpenCodeAttach(
  bin: string,
  args: string[],
  onChild?: (child: ChildProcess) => void,
): Promise<number> {
  const child = spawn(bin, args, { stdio: 'inherit' });
  onChild?.(child);
  return new Promise((resolve, reject) => {
    child.on('error', (err) => {
      reject(new Error(`Could not run ${bin}: ${err.message}`));
    });
    child.on('exit', (code, signal) => {
      if (typeof code === 'number') resolve(code);
      else resolve(signal ? 130 : 1);
    });
  });
}
