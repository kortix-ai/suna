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
 * The daemon's env-rpc route authenticates X-Kortix-User-Context signed with
 * the box's KORTIX_TOKEN. The worker holds the SAME session credential (the
 * environment boots with it, by design), so it mints that header itself.
 *
 * Same contract as the inner env: operations never throw — a failed ensure is
 * a Result the tool renders, not a crash.
 */
import { createHmac } from 'node:crypto';
import { KortixExecutionEnv } from './kortix-env.ts';
import { isEnvironmentUnreachable } from './env-reattach.ts';

type Ok<T> = { ok: true; value: T };
type Err<E> = { ok: false; error: E };
type Result<T, E> = Ok<T> | Err<E>;
const err = <E,>(error: E): Err<E> => ({ ok: false, error });

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
        // Long-lived on purpose: the env object holds static headers for the
        // session's whole life, and the real secret is the session token the
        // signature already depends on.
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
   * Called when a PROMPT arrives, not when the session is created and not when
   * the first tool runs. Measured on pi.kortix.com: first token 4.25s, first
   * `bash` on that same cold session 37.5s — the split moved the environment's
   * cold start out of session setup and into the middle of the first answer.
   * A prompt means a turn is happening, so provisioning overlaps the model's
   * own thinking instead of queueing behind it, while a session nobody ever
   * prompts still provisions nothing.
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
      const edge = ensured.preview_url.replace(/\/+$/, '');
      const headers: Record<string, string> = {
        'x-kortix-user-context': mintUserContext(this.opts.token, ensured.external_id ?? 'env'),
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
            const health = (await res.json()) as { repo_ready?: boolean };
            if (health.repo_ready !== false) {
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
  private discardEnvironment(): void {
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
     * Does this operation CHANGE the environment? Reads may be replayed for
     * free; nothing else may be replayed at all. See the note in `op` below.
     */
    mutating: boolean,
  ): Promise<Result<T, unknown>> {
    try {
      const first = await run(await this.attach());
      if (first.ok || !isEnvironmentUnreachable(first.error)) return first;

      // Nothing answered. The box may have been stopped, deleted, or rebuilt
      // under a new id since we attached — all three are states the control
      // plane creates deliberately and can serve us out of. Re-attaching is
      // what unwedges the session, and it happens either way.
      this.discardEnvironment();
      await this.attach();

      if (!mutating) return await run(await this.attach());

      // A mutating operation is NEVER replayed.
      //
      // `rpc()` already retries once on a socket-shaped error
      // (kortix-env.ts:153-157), so a retry here nests inside that one and a
      // single `bash` could execute up to four times. And the triggers make it
      // likely rather than theoretical: `rpc timeout` and `fetch failed` are
      // exactly what a connection dropping AFTER the daemon started the command
      // looks like — it ran, we just never heard the answer. Replaying
      // `echo hi` is free; replaying `rm -rf`, `git push` or a migration is not.
      //
      // So the model is told the truth instead: the environment is healthy
      // again, and this command's outcome is unknown. That is a different
      // situation from "it failed", and it calls for a different next move.
      return err(
        new EnvironmentRecoveredError(
          'the environment became unreachable during this operation and has been ' +
            'recovered. Whether the operation ran is unknown, so it was not ' +
            'repeated — repeating it could act twice.',
        ),
      );
    } catch (e) {
      return err(e instanceof Error ? e : new EnvUnavailableError(String(e)));
    }
  }

  // ---- FileSystem (same surface as KortixExecutionEnv) --------------------
  absolutePath(path: string) { return this.op((env) => env.absolutePath(path), false); }
  joinPath(parts: string[]) { return this.op((env) => env.joinPath(parts), false); }
  readTextFile(path: string) { return this.op((env) => env.readTextFile(path), false); }
  readTextLines(path: string, options?: { maxLines?: number }) {
    return this.op((env) => env.readTextLines(path, options), false);
  }
  readBinaryFile(path: string) { return this.op((env) => env.readBinaryFile(path), false); }
  writeFile(path: string, content: string | Uint8Array) {
    return this.op((env) => env.writeFile(path, content), true);
  }
  appendFile(path: string, content: string | Uint8Array) {
    return this.op((env) => env.appendFile(path, content), true);
  }
  renameFile(sourcePath: string, destinationPath: string) {
    return this.op((env) => env.renameFile(sourcePath, destinationPath), true);
  }
  fileInfo(path: string) { return this.op((env) => env.fileInfo(path), false); }
  listDir(path: string) { return this.op((env) => env.listDir(path), false); }
  canonicalPath(path: string) { return this.op((env) => env.canonicalPath(path), false); }
  exists(path: string) { return this.op((env) => env.exists(path), false); }
  createDir(path: string, options?: { recursive?: boolean }) {
    return this.op((env) => env.createDir(path, options), true);
  }
  remove(path: string, options?: { recursive?: boolean; force?: boolean }) {
    return this.op((env) => env.remove(path, options), true);
  }
  createTempDir(prefix?: string) { return this.op((env) => env.createTempDir(prefix), true); }
  createTempFile(options?: { prefix?: string; suffix?: string }) {
    return this.op((env) => env.createTempFile(options), true);
  }

  // ---- Shell --------------------------------------------------------------
  exec(command: string, options?: unknown) {
    return this.op((env) => env.exec(command, options), true);
  }

  async cleanup(): Promise<void> {
    await this.inner?.cleanup();
  }
}
