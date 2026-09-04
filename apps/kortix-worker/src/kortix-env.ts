/**
 * KortixExecutionEnv — the whole harness/environment split, in one object.
 *
 * pi-agent-core's built-in tools (bash, read, write, edit) do not touch the
 * filesystem directly. They take an `ExecutionEnv` out of their tool context
 * (`ExecutionToolContext { env }`) and go through it for every operation. So
 * the worker does not need to reimplement or override a single tool: it
 * supplies THIS object instead of `NodeExecutionEnv`, and every file read,
 * every write, and every shell command lands in the Kortix environment
 * instead of on the worker's own disk.
 *
 * Contract from pi-agent-core's own docs, and it matters:
 *   "Operation methods must never throw or reject. All filesystem failures,
 *    including unexpected backend failures, must be encoded in the returned
 *    Result."
 * Every method below honours that — `rpc()` converts transport failures into
 * `Result.err` rather than letting them escape.
 */

import { makeTransport, type RpcTransport } from './rpc-transport.ts';

type Ok<T> = { ok: true; value: T };
type Err<E> = { ok: false; error: E };
type Result<T, E> = Ok<T> | Err<E>;

const ok = <T,>(value: T): Ok<T> => ({ ok: true, value });
const err = <E,>(error: E): Err<E> => ({ ok: false, error });

const REPLAY_SAFE_RPC_OPERATIONS: ReadonlySet<string> = new Set([
  'absolutePath',
  'joinPath',
  'readTextFile',
  'readTextLines',
  'readBinaryFile',
  'fileInfo',
  'listDir',
  'canonicalPath',
  'exists',
]);

/** Mirrors pi's FileError shape without importing it, so this file stays dependency-light. */
class FileErrorLike extends Error {
  code: string;
  path?: string;
  constructor(code: string, message: string, path?: string) {
    super(message);
    this.name = 'FileError';
    this.code = code;
    this.path = path;
  }
}

/**
 * OS errno -> pi's FileError code.
 *
 * The daemon's env-rpc is a thin fs proxy: it reports the real errno
 * (`ENOENT`), and this client is the adapter that has to speak pi's
 * vocabulary. Passing the errno through unmapped BROKE EVERY FILE CREATION.
 * `withFileMutationQueue` canonicalises the target before any mutation and
 * tolerates a path that does not exist yet — but only for code `not_found`;
 * anything else it rethrows. So `write` on a new file died on its own
 * pre-flight with "ENOENT: no such file or directory, lstat '/workspace/x'",
 * and the agent fell back to `bash` heredocs, ten times in one turn, on
 * pi.kortix.com.
 *
 * Mirrors pi's own mapping in `harness/env/nodejs.js` exactly — including its
 * spellings `not_directory` / `is_directory` — because pi's tools compare
 * against those strings.
 */
const FILE_ERROR_CODES: Record<string, string> = {
  ABORT_ERR: 'aborted',
  ENOENT: 'not_found',
  EACCES: 'permission_denied',
  EPERM: 'permission_denied',
  ENOTDIR: 'not_directory',
  EISDIR: 'is_directory',
  EINVAL: 'invalid',
};

/** Codes pi already understands pass through; unknown errnos become 'unknown'. */
export function toFileErrorCode(code: unknown): string {
  if (typeof code !== 'string' || !code) return 'unknown';
  const mapped = FILE_ERROR_CODES[code];
  if (mapped) return mapped;
  // Anything still shaped like an errno is one we have not mapped; do not hand
  // pi a string it cannot match.
  return /^E[A-Z]+$/.test(code) ? 'unknown' : code;
}

class ExecutionErrorLike extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'ExecutionError';
    this.code = code;
  }
}

export type TransportKind = 'fetch' | 'keepalive' | 'ws' | 'auto';

export interface KortixEnvOptions {
  /** Base URL of the environment's RPC endpoint. In production this is the Kortix sandbox proxy. */
  baseUrl: string;
  /** Working directory inside the environment. */
  cwd: string;
  /** Bearer token for the environment. Optional for the local stub. */
  token?: string;
  /** Extra headers sent with every RPC (provider preview tokens, tracing). */
  headers?: Record<string, string>;
  /** Per-call timeout. */
  timeoutMs?: number;
  /** Which transport carries the RPC. See src/rpc-transport.ts and the gate. */
  transport?: TransportKind;
}

/**
 * pi hands `exec` a timeout in SECONDS; the daemon expects milliseconds.
 *
 * Anything that is not a positive finite number becomes `undefined` so the
 * daemon falls back to its own default — passing 0 or NaN through would be
 * read as "kill immediately".
 */
export function toExecTimeoutMs(timeoutSeconds: unknown): number | undefined {
  if (typeof timeoutSeconds !== 'number') return undefined;
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) return undefined;
  return Math.round(timeoutSeconds * 1000);
}

export class KortixExecutionEnv {
  readonly cwd: string;
  private readonly baseUrl: string;
  private readonly token?: string;
  private readonly headers: Record<string, string>;
  private readonly transport: RpcTransport;
  private readonly timeoutMs: number;

  /** Every RPC that crossed the boundary. The proof harness reads this. */
  readonly calls: Array<{ op: string; args: unknown }> = [];

  constructor(opts: KortixEnvOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, '');
    this.cwd = opts.cwd;
    this.token = opts.token;
    this.headers = opts.headers ?? {};
    // Default: NEGOTIATE. Prefer the multiplexed socket (G0: 16.0ms p50 vs
    // 19.2ms pooled keep-alive), fall back to keep-alive when the daemon has no
    // `/rpc-ws` — which every sandbox baked before that endpoint existed does
    // not, permanently. See NegotiatingTransport.
    this.transport = makeTransport(opts.transport ?? 'auto', this.baseUrl, this.headers);
    this.timeoutMs = opts.timeoutMs ?? 120_000;
  }

  /**
   * The single boundary crossing. One persistent-friendly POST per operation.
   *
   * NOTE for the real implementation: this is where the per-turn RPC tax lives.
   * A 200-tool-call turn makes 200 of these. It must become one multiplexed
   * connection before this ships — see the latency budget in the plan.
   */
  private async rpc<T>(op: string, args: Record<string, unknown>): Promise<Result<T, any>> {
    this.calls.push({ op, args });
    // One retry for reads: a pooled keep-alive socket retired by the peer
    // between calls is a transport artifact, not a tool failure. Mutations
    // cannot be replayed because the daemon may commit the side effect before
    // the response disappears.
    const first = await this.rpcOnce<T>(op, args);
    if (first.ok) return first;
    const msg = String((first.error as any)?.message ?? '');
    if (
      REPLAY_SAFE_RPC_OPERATIONS.has(op) &&
      /socket|ECONNRESET|closed|EPIPE/i.test(msg)
    ) {
      return this.rpcOnce<T>(op, args);
    }
    return first;
  }

  private async rpcOnce<T>(op: string, args: Record<string, unknown>): Promise<Result<T, any>> {
    const timer = new Promise<never>((_, rej) =>
      setTimeout(() => rej(new Error('rpc timeout')), this.timeoutMs).unref?.(),
    );
    try {
      const body: any = await Promise.race([this.transport.call(op, args, this.cwd), timer]);
      if (body?.ok) return ok(body.value as T);
      return err(
        new FileErrorLike(
          toFileErrorCode(body?.error?.code),
          body?.error?.message ?? 'environment error',
          body?.error?.path,
        ),
      );
    } catch (e: any) {
      // Never throw. A dead environment is a Result, not an exception.
      return err(new FileErrorLike('unknown', String(e?.message ?? e)));
    }
  }

  // ---- FileSystem ---------------------------------------------------------
  absolutePath(path: string) { return this.rpc<string>('absolutePath', { path }); }
  joinPath(parts: string[]) { return this.rpc<string>('joinPath', { parts }); }
  readTextFile(path: string) { return this.rpc<string>('readTextFile', { path }); }
  readTextLines(path: string, options?: { maxLines?: number }) {
    return this.rpc<string[]>('readTextLines', { path, maxLines: options?.maxLines });
  }
  async readBinaryFile(path: string): Promise<Result<Uint8Array, any>> {
    const r = await this.rpc<string>('readBinaryFile', { path });
    if (!r.ok) return r;
    return ok(Uint8Array.from(Buffer.from(r.value, 'base64')));
  }
  writeFile(path: string, content: string | Uint8Array) {
    const isBin = typeof content !== 'string';
    return this.rpc<void>('writeFile', {
      path,
      content: isBin ? Buffer.from(content as Uint8Array).toString('base64') : content,
      encoding: isBin ? 'base64' : 'utf8',
    });
  }
  appendFile(path: string, content: string | Uint8Array) {
    const isBin = typeof content !== 'string';
    return this.rpc<void>('appendFile', {
      path,
      content: isBin ? Buffer.from(content as Uint8Array).toString('base64') : content,
      encoding: isBin ? 'base64' : 'utf8',
    });
  }
  renameFile(sourcePath: string, destinationPath: string) {
    return this.rpc<void>('renameFile', { sourcePath, destinationPath });
  }
  fileInfo(path: string) { return this.rpc<any>('fileInfo', { path }); }
  listDir(path: string) { return this.rpc<any[]>('listDir', { path }); }
  canonicalPath(path: string) { return this.rpc<string>('canonicalPath', { path }); }
  exists(path: string) { return this.rpc<boolean>('exists', { path }); }
  createDir(path: string, options?: { recursive?: boolean }) {
    return this.rpc<void>('createDir', { path, recursive: options?.recursive ?? true });
  }
  remove(path: string, options?: { recursive?: boolean; force?: boolean }) {
    return this.rpc<void>('remove', { path, recursive: !!options?.recursive, force: !!options?.force });
  }
  createTempDir(prefix?: string) { return this.rpc<string>('createTempDir', { prefix: prefix ?? 'tmp-' }); }
  createTempFile(options?: { prefix?: string; suffix?: string }) {
    return this.rpc<string>('createTempFile', { prefix: options?.prefix ?? '', suffix: options?.suffix ?? '' });
  }

  // ---- Shell --------------------------------------------------------------
  async exec(command: string, options?: any): Promise<Result<{ stdout: string; stderr: string; exitCode: number }, any>> {
    const r = await this.rpc<{ stdout: string; stderr: string; exitCode: number }>('exec', {
      command,
      cwd: options?.cwd,
      env: options?.env,
      // SECONDS -> MILLISECONDS. The two sides of this call disagreed on the
      // unit: pi's ExecutionEnvironment contract is "Timeout in seconds"
      // (@earendil-works/pi-agent-core harness/types.d.ts:205) and the Kortix
      // daemon reads the field as `timeoutMs` and SIGKILLs on it
      // (kortix-sandbox-agent-server routes/env-rpc.ts `case 'exec'`).
      // Forwarding it unconverted killed every model-supplied timeout ~1000x
      // early: `bash({ command: 'pnpm install', timeout: 600 })` — ten minutes
      // — died after 600ms with exit code 124, and the model was told the
      // command had timed out. Undefined stays undefined so the daemon applies
      // its own default rather than 0.
      timeout: toExecTimeoutMs(options?.timeout),
    });
    if (!r.ok) return err(new ExecutionErrorLike((r.error as any)?.code ?? 'unknown', String((r.error as any)?.message)));
    // Streaming callbacks are honoured after the fact for the spike; the real
    // implementation streams these over the multiplexed connection.
    if (options?.onStdout && r.value.stdout) options.onStdout(r.value.stdout);
    if (options?.onStderr && r.value.stderr) options.onStderr(r.value.stderr);
    return r;
  }

  async cleanup(): Promise<void> {
    await this.transport.close();
  }
}
