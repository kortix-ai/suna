/**
 * LazyKortixEnv — P1.7's "zero sandboxes until a compute tool call".
 *
 * The worker boots with NO environment. The first ExecutionEnv operation calls
 * `POST {api}/projects/{pid}/sessions/{sid}/environment/ensure` with the
 * worker's own session token; the API provisions (or resumes) the full daemon
 * box and answers with a PROVIDER-EDGE origin + token. Every operation then
 * flows through the ordinary KortixExecutionEnv against
 * `{edge}/kortix/env-rpc` — the control plane is not in the data path.
 *
 * The daemon's env-rpc route authenticates X-Kortix-User-Context with a
 * purpose-bound RPC secret returned by ensure. Worker and environment PATs
 * remain separate control-plane principals.
 *
 * Same contract as the inner env: operations never throw — a failed ensure is
 * a Result the tool renders, not a crash.
 */
import { createHmac } from 'node:crypto';
import type { ShellExecOptions } from '@earendil-works/pi-agent-core';
import { KortixExecutionEnv } from './kortix-env.ts';
import {
  isEnvironmentAuthenticationRejected,
  isEnvironmentUnreachable,
} from './env-reattach.ts';

type Ok<T> = { ok: true; value: T };
type Err<E> = { ok: false; error: E };
type Result<T, E> = Ok<T> | Err<E>;
const err = <E>(error: E): Err<E> => ({ ok: false, error });

/**
 * The environment went away mid-operation and has been re-attached, but the
 * operation was NOT repeated because repeating it could act twice.
 */
class EnvironmentRecoveredError extends Error {
  code = 'environment_recovered';
  constructor(message: string) {
    super(message);
    this.name = 'EnvironmentRecoveredError';
  }
}

class EnvUnavailableError extends Error {
  code = 'environment_unavailable';
  constructor(message: string) {
    super(message);
    this.name = 'EnvUnavailableError';
  }
}

class OperationAbortedError extends Error {
  code = 'aborted';
  constructor() {
    super('aborted');
    this.name = 'OperationAbortedError';
  }
}

export interface LazyEnvOptions {
  /** Kortix API base incl. /v1 (KORTIX_API_URL). */
  apiUrl: string;
  /** The worker's session credential (KORTIX_TOKEN). */
  token: string;
  projectId: string;
  sessionId: string;
  cwd: string;
  /** Overall budget for ensure + daemon readiness. Cold provision ≈ 15–30 s. */
  ensureTimeoutMs?: number;
}

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Mirror of the daemon's verifyKortixUserContext, signing side. */
export function mintUserContext(secret: string, sandboxId: string): string {
  const payload = base64url(
    Buffer.from(
      JSON.stringify({
        userId: 'pi-worker',
        sandboxId,
        sandboxRole: 'owner',
        scopes: [],
        iat: Math.floor(Date.now() / 1000),
        // Long enough to avoid per-call signing. A 401 rejects the call before
        // execution, so op() discards this client and remints through attach().
        exp: Math.floor(Date.now() / 1000) + 24 * 3600,
      }),
    ),
  );
  return `${payload}.${base64url(createHmac('sha256', secret).update(payload).digest())}`;
}

interface EnsureResponse {
  status?: string;
  external_id?: string | null;
  preview_url?: string | null;
  preview_token?: string | null;
  rpc_secret?: string | null;
  error?: string;
}

export class LazyKortixEnv {
  readonly cwd: string;
  private readonly opts: Required<Pick<LazyEnvOptions, 'ensureTimeoutMs'>> & LazyEnvOptions;
  private inner: KortixExecutionEnv | null = null;
  private attaching: Promise<KortixExecutionEnv> | null = null;
  /** Set once attached; surfaced in /kortix/health. */
  externalId: string | null = null;

  constructor(opts: LazyEnvOptions) {
    this.opts = { ensureTimeoutMs: 180_000, ...opts };
    this.cwd = opts.cwd;
  }

  get attached(): boolean {
    return this.inner !== null;
  }

  /** Every boundary crossing, for /say's rpcCalls tap. Empty until attached. */
  get calls(): Array<{ op: string; args: unknown }> {
    return this.inner?.calls ?? [];
  }

  private async ensureOnce(): Promise<EnsureResponse> {
    const res = await fetch(
      `${this.opts.apiUrl.replace(/\/+$/, '')}/projects/${this.opts.projectId}/sessions/${this.opts.sessionId}/environment/ensure`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.opts.token}`,
          'content-type': 'application/json',
        },
        signal: AbortSignal.timeout(150_000),
      },
    );
    const body = (await res.json().catch(() => ({}))) as EnsureResponse;
    if (!res.ok) {
      throw new EnvUnavailableError(
        `environment ensure failed: HTTP ${res.status}${body?.error ? ` — ${body.error}` : ''}`,
      );
    }
    return body;
  }

  /**
   * Start provisioning now, without waiting for it.
   *
   * Called when a model turn starts only if the worker explicitly selects
   * prewarm mode. Lazy mode never calls this method for a text-only prompt.
   * Prewarm overlaps environment startup with the model request, trading
   * compute use on text-only turns for lower first-tool latency.
   *
   * Fire-and-forget by contract: a failed prewarm is swallowed here, because
   * the tool call that actually needs the environment will attach again and
   * report the failure as its own Result. Surfacing it twice would turn one
   * provider hiccup into an error the user sees before they asked for
   * anything.
   */
  prewarm(): void {
    if (this.inner || this.attaching) return;
    void this.attach().catch(() => {
      // Deliberately ignored — see above.
    });
  }

  private async attach(): Promise<KortixExecutionEnv> {
    if (this.inner) return this.inner;
    if (this.attaching) return this.attaching;
    this.attaching = (async () => {
      const deadline = Date.now() + this.opts.ensureTimeoutMs;
      let ensured: EnsureResponse | null = null;
      let lastError = 'unknown';
      while (Date.now() < deadline) {
        try {
          const r = await this.ensureOnce();
          if (r.status === 'active' && r.preview_url) {
            ensured = r;
            break;
          }
          lastError = `environment status: ${r.status ?? 'unknown'}`;
        } catch (e) {
          lastError = String((e as Error)?.message ?? e);
        }
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
      if (!ensured?.preview_url) {
        throw new EnvUnavailableError(`could not attach environment: ${lastError}`);
      }
      if (!ensured.rpc_secret) {
        throw new EnvUnavailableError('environment ensure returned no RPC secret');
      }
      const edge = ensured.preview_url.replace(/\/+$/, '');
      const headers: Record<string, string> = {
        'x-kortix-user-context': mintUserContext(ensured.rpc_secret, ensured.external_id ?? 'env'),
        ...(ensured.preview_token ? { 'x-daytona-preview-token': ensured.preview_token } : {}),
      };
      // Wait for the daemon (repo materialization included) before first use.
      let ready = false;
      while (Date.now() < deadline) {
        try {
          const res = await fetch(`${edge}/kortix/health`, {
            headers,
            signal: AbortSignal.timeout(5000),
          });
          if (res.ok) {
            const health = (await res.json()) as { workload?: string; opencode?: string; runtimeReady?: boolean };
            if (health.workload === 'environment' && health.opencode === 'disabled' && health.runtimeReady === true) {
              ready = true;
              break;
            }
          }
        } catch {
          // edge or daemon still coming up
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      if (!ready) throw new EnvUnavailableError('environment daemon never became ready');
      this.externalId = ensured.external_id ?? null;
      this.inner = new KortixExecutionEnv({
        baseUrl: `${edge}/kortix/env-rpc`,
        cwd: this.cwd,
        headers,
        // Negotiated, not pinned: prefer the socket, fall back on an
        // image-baked daemon that predates `/rpc-ws`.
        transport: 'auto',
      });
      return this.inner;
    })();
    try {
      return await this.attaching;
    } finally {
      // A failed attach must not poison later tool calls — retry from scratch.
      if (!this.inner) this.attaching = null;
    }
  }

  /**
   * Forget the environment we are attached to.
   *
   * Nothing else ever cleared `inner`, which made the client minted on the
   * first tool call the client used for the worker's whole life — pinned to one
   * provider-edge URL and one external_id. That was survivable while nothing
   * stopped an environment out from under a live worker; the sweeps on this
   * branch now do exactly that (idle-stop at 24h, worker-stopped, and a removed
   * box reprovisioned under a NEW id).
   */
  private discardEnvironment(expected?: KortixExecutionEnv): void {
    if (expected && this.inner !== expected) return;
    this.inner = null;
    this.attaching = null;
    this.externalId = null;
  }

  /**
   * Delegate an operation, converting attach failures into Results.
   *
   * P2.5: *"A live worker with a reaped environment must be a DEFINED state,
   * not a DISCOVERED one — including what the next tool call does when it finds
   * one."* This is that definition. When an operation comes back saying nothing
   * on the far side answered, the environment is discarded and re-attached
   * ONCE, and the operation is retried against the new one. `ensure` resumes a
   * stopped box or rebuilds a removed one, so the recovery is the control
   * plane's ordinary path — the worker's only job is to ask again.
   *
   * Exactly one retry. `attach()` already retries to its own deadline, so
   * looping here would multiply that deadline by every tool call in the turn
   * and tell the model nothing it did not already know.
   */
  private async op<T>(
    run: (env: KortixExecutionEnv) => Promise<Result<T, unknown>>,
    /**
     * Does this operation CHANGE the environment? Reads may be replayed after
     * an ambiguous transport failure. Mutations may only be replayed after the
     * daemon definitively rejects authentication before execution.
     */
    mutating: boolean,
    signal?: AbortSignal,
  ): Promise<Result<T, unknown>> {
    if (signal?.aborted) return err(new OperationAbortedError());
    try {
      const attached = this.attach();
      const env = signal
        ? await new Promise<KortixExecutionEnv>((resolve, reject) => {
            const onAbort = () => reject(new OperationAbortedError());
            if (signal.aborted) {
              onAbort();
              return;
            }
            signal.addEventListener('abort', onAbort, { once: true });
            void attached.then(
              (value) => {
                signal.removeEventListener('abort', onAbort);
                resolve(value);
              },
              (error) => {
                signal.removeEventListener('abort', onAbort);
                reject(error);
              },
            );
          })
        : await attached;
      const first = await run(env);
      if (signal?.aborted) return err(new OperationAbortedError());
      if (first.ok) return first;

      if (isEnvironmentAuthenticationRejected(first.error)) {
        this.discardEnvironment(env);
        const refreshed = await this.attach();
        const retried = await run(refreshed);
        if (!retried.ok && isEnvironmentAuthenticationRejected(retried.error)) {
          this.discardEnvironment(refreshed);
        }
        return retried;
      }

      if (!isEnvironmentUnreachable(first.error)) return first;

      // Nothing answered. The box may have been stopped, deleted, or rebuilt
      // under a new id since we attached — all three are states the control
      // plane creates deliberately and can serve us out of. Re-attaching is
      // what unwedges the session, and it happens either way.
      this.discardEnvironment(env);
      await this.attach();

      if (!mutating) return await run(await this.attach());

      // A mutating operation is never replayed after an ambiguous failure.
      //
      // The inner RPC layer also restricts its socket-error retry to read-only
      // operations. Keep both boundaries fail-closed: `rpc timeout` and
      // `fetch failed` are exactly what a connection dropping AFTER the daemon
      // started the command looks like — it ran, we just never heard the
      // answer. Replaying `echo hi` is free; replaying `rm -rf`, `git push` or
      // a migration is not.
      //
      // So the model is told the truth instead: the environment is healthy
      // again, and this command's outcome is unknown. That is a different
      // situation from "it failed", and it calls for a different next move.
      return err(
        new EnvironmentRecoveredError(
          'The environment became unreachable during this operation and has ' +
            'been recovered; it is ready to use now. This operation was NOT ' +
            'retried automatically because it may already have run, and ' +
            'repeating it could act twice. Retry it yourself if it is safe to ' +
            'repeat (a read, a list, an idempotent command); otherwise check ' +
            'whether it took effect before deciding.',
        ),
      );
    } catch (e) {
      return err(e instanceof Error ? e : new EnvUnavailableError(String(e)));
    }
  }

  // ---- FileSystem (same surface as KortixExecutionEnv) --------------------
  absolutePath(path: string, abortSignal?: AbortSignal) {
    return this.op((env) => env.absolutePath(path, abortSignal), false, abortSignal);
  }
  joinPath(parts: string[], abortSignal?: AbortSignal) {
    return this.op((env) => env.joinPath(parts, abortSignal), false, abortSignal);
  }
  readTextFile(path: string, abortSignal?: AbortSignal) {
    return this.op((env) => env.readTextFile(path, abortSignal), false, abortSignal);
  }
  readTextLines(path: string, options?: { maxLines?: number; abortSignal?: AbortSignal }) {
    return this.op((env) => env.readTextLines(path, options), false, options?.abortSignal);
  }
  readBinaryFile(path: string, abortSignal?: AbortSignal) {
    return this.op((env) => env.readBinaryFile(path, abortSignal), false, abortSignal);
  }
  writeFile(path: string, content: string | Uint8Array, abortSignal?: AbortSignal) {
    return this.op((env) => env.writeFile(path, content, abortSignal), true, abortSignal);
  }
  appendFile(path: string, content: string | Uint8Array, abortSignal?: AbortSignal) {
    return this.op((env) => env.appendFile(path, content, abortSignal), true, abortSignal);
  }
  renameFile(sourcePath: string, destinationPath: string, abortSignal?: AbortSignal) {
    return this.op(
      (env) => env.renameFile(sourcePath, destinationPath, abortSignal),
      true,
      abortSignal,
    );
  }
  fileInfo(path: string, abortSignal?: AbortSignal) {
    return this.op((env) => env.fileInfo(path, abortSignal), false, abortSignal);
  }
  listDir(path: string, abortSignal?: AbortSignal) {
    return this.op((env) => env.listDir(path, abortSignal), false, abortSignal);
  }
  canonicalPath(path: string, abortSignal?: AbortSignal) {
    return this.op((env) => env.canonicalPath(path, abortSignal), false, abortSignal);
  }
  exists(path: string, abortSignal?: AbortSignal) {
    return this.op((env) => env.exists(path, abortSignal), false, abortSignal);
  }
  createDir(path: string, options?: { recursive?: boolean; abortSignal?: AbortSignal }) {
    return this.op((env) => env.createDir(path, options), true, options?.abortSignal);
  }
  remove(
    path: string,
    options?: { recursive?: boolean; force?: boolean; abortSignal?: AbortSignal },
  ) {
    return this.op((env) => env.remove(path, options), true, options?.abortSignal);
  }
  createTempDir(prefix?: string, abortSignal?: AbortSignal) {
    return this.op((env) => env.createTempDir(prefix, abortSignal), true, abortSignal);
  }
  createTempFile(options?: { prefix?: string; suffix?: string; abortSignal?: AbortSignal }) {
    return this.op((env) => env.createTempFile(options), true, options?.abortSignal);
  }

  // ---- Shell --------------------------------------------------------------
  exec(command: string, options?: ShellExecOptions) {
    return this.op((env) => env.exec(command, options), true, options?.abortSignal);
  }

  async waitForAbortSettled(): Promise<void> {
    await this.inner?.waitForAbortSettled();
  }

  async cleanup(): Promise<void> {
    await this.inner?.cleanup();
  }
}
