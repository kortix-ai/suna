import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { Hono, type Context } from 'hono';
import { stream } from 'hono/streaming';
import {
  RPC_STREAM_CONTENT_TYPE,
  type RpcProgress,
} from '../../../../packages/shared/src/env-rpc-stream';

import type { Config } from '../config';
import { KORTIX_USER_CONTEXT_HEADER, verifyKortixUserContext } from '../kortix-user-context';
import { logger } from '../logger';
import { workspaceAccess } from '../workspace-access';
import { WorkspaceHistory, WorkspaceHistoryError } from '../workspace-history';

/**
 * `/kortix/env-rpc` — the environment half of the harness/worker split (P1.7).
 *
 * The pi worker's six workspace tools run against an ExecutionEnv. File tools
 * call their matching operations here. Glob and grep execute remote `rg`
 * through this route's exec operation. The box exists for one session and
 * holds that session's workspace credential.
 *
 * Wire contract (mirrors apps/kortix-worker/src/kortix-env.ts):
 *   POST { op, args, cwd }  →  { ok: true, value } | { ok: false, error: { code, message, path? } }
 * The route never throws wire-level errors for filesystem failures — a missing
 * file is a Result, not a 500. HTTP errors are reserved for auth and malformed
 * requests.
 *
 * Auth: `/kortix/*` is exempt from the daemon's global gate. Every request
 * verifies X-Kortix-User-Context with KORTIX_ENV_RPC_SECRET. The secret is
 * purpose-bound to this environment and cannot call the control-plane API.
 * KORTIX_TOKEN remains the environment's independent API principal.
 */

const EXEC_TIMEOUT_DEFAULT_MS = 120_000;
const EXEC_TIMEOUT_MAX_MS = 10 * 60_000;
/** Per-stream cap so one `cat big.bin` cannot balloon the worker's context. */
const EXEC_OUTPUT_CAP_BYTES = 2 * 1024 * 1024;
const CANCEL_TOMBSTONE_MS = 2 * 60_000;

interface EnvRpcError {
  code: string;
  message: string;
  path?: string;
}

const ok = (value: unknown) => ({ ok: true as const, value });
const err = (error: EnvRpcError) => ({ ok: false as const, error });

type FileStat = Awaited<ReturnType<typeof fs.lstat>>;

function fileInfoValue(addressedPath: string, stat: FileStat) {
  const kind = stat.isFile()
    ? 'file'
    : stat.isDirectory()
      ? 'directory'
      : stat.isSymbolicLink()
        ? 'symlink'
        : undefined;
  if (!kind) {
    return err({ code: 'EINVAL', message: 'Unsupported file type', path: addressedPath });
  }
  return ok({
    name: path.basename(addressedPath),
    path: addressedPath,
    kind,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
  });
}

export function environmentRpcSecret(
  cfg: Pick<Config, 'envRpcSecret' | 'sandboxToken'>,
): string | undefined {
  return cfg.envRpcSecret ?? cfg.sandboxToken;
}

function fsError(e: unknown, fallbackPath?: string) {
  const errno = e as NodeJS.ErrnoException;
  const errorCode = (errno as { code?: unknown })?.code;
  const aborted = errno?.name === 'AbortError' || errorCode === 'ABORT_ERR' || errorCode === 20;
  return err({
    code: aborted ? 'ABORT_ERR' : (errno?.code ?? 'unknown'),
    message: aborted ? 'aborted' : (errno?.message ?? String(e)),
    path: (errno as { path?: string })?.path ?? fallbackPath,
  });
}

function resolveIn(cwd: string, p: string): string {
  return path.isAbsolute(p) ? p : path.resolve(cwd, p);
}

interface ActiveExecution {
  controller: AbortController;
  done: Promise<void>;
  finish(): void;
}

function cancellationRegistry() {
  const active = new Map<string, ActiveExecution>();
  const cancelledBeforeStart = new Map<string, ReturnType<typeof setTimeout>>();

  const rememberCancellation = (requestId: string) => {
    const existing = cancelledBeforeStart.get(requestId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => cancelledBeforeStart.delete(requestId), CANCEL_TOMBSTONE_MS);
    timer.unref?.();
    cancelledBeforeStart.set(requestId, timer);
  };

  return {
    begin(requestId: string | undefined, disconnectSignal: AbortSignal): ActiveExecution {
      const controller = new AbortController();
      let resolveDone!: () => void;
      const done = new Promise<void>((resolve) => {
        resolveDone = resolve;
      });
      let finished = false;
      const onDisconnect = () => controller.abort();
      disconnectSignal.addEventListener('abort', onDisconnect, { once: true });
      if (disconnectSignal.aborted) onDisconnect();
      const execution: ActiveExecution = {
        controller,
        done,
        finish() {
          if (finished) return;
          finished = true;
          disconnectSignal.removeEventListener('abort', onDisconnect);
          if (requestId && active.get(requestId) === execution) active.delete(requestId);
          resolveDone();
        },
      };
      if (requestId) {
        const pending = cancelledBeforeStart.get(requestId);
        if (pending) {
          clearTimeout(pending);
          cancelledBeforeStart.delete(requestId);
          controller.abort();
        }
        active.set(requestId, execution);
      }
      return execution;
    },

    async cancel(requestId: string): Promise<boolean> {
      const execution = active.get(requestId);
      if (!execution) {
        rememberCancellation(requestId);
        return false;
      }
      execution.controller.abort();
      await execution.done;
      return true;
    },
  };
}

async function runExec(input: {
  command: string;
  cwd: string;
  env?: Record<string, string>;
  timeoutMs: number;
  signal: AbortSignal;
  onProgress?: (progress: RpcProgress) => void;
}): Promise<{ stdout: string; stderr: string; exitCode: number; aborted: boolean }> {
  if (input.signal.aborted) {
    return { stdout: '', stderr: 'aborted', exitCode: 130, aborted: true };
  }
  return new Promise((resolve) => {
    const child = spawn('bash', ['-lc', input.command], {
      cwd: input.cwd,
      env: { ...process.env, ...(input.env ?? {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
      // A tool command can fork grandchildren. Give the command its own
      // process group so a timeout stops the complete tree, including children
      // that still hold stdout/stderr open after the shell exits.
      detached: process.platform !== 'win32',
    });
    let stdout: Buffer = Buffer.alloc(0);
    let stderr: Buffer = Buffer.alloc(0);
    let truncatedOut = false;
    let truncatedErr = false;
    let aborted = false;
    let settled = false;
    const outDecoder = new StringDecoder('utf8');
    const errDecoder = new StringDecoder('utf8');
    const progress = (stream: RpcProgress['stream'], chunk: string) => {
      if (chunk && !settled && !input.signal.aborted) input.onProgress?.({ stream, chunk });
    };
    const cap = (buf: Buffer, chunk: Buffer, markTruncated: () => void): Buffer => {
      if (buf.length >= EXEC_OUTPUT_CAP_BYTES) {
        markTruncated();
        return buf;
      }
      const room = EXEC_OUTPUT_CAP_BYTES - buf.length;
      if (chunk.length > room) markTruncated();
      return Buffer.concat([buf, chunk.subarray(0, room)]);
    };
    child.stdout.on('data', (c: Buffer) => {
      const previous = stdout.length;
      stdout = cap(stdout, c, () => {
        truncatedOut = true;
      });
      progress('stdout', outDecoder.write(stdout.subarray(previous)));
    });
    child.stderr.on('data', (c: Buffer) => {
      const previous = stderr.length;
      stderr = cap(stderr, c, () => {
        truncatedErr = true;
      });
      progress('stderr', errDecoder.write(stderr.subarray(previous)));
    });
    const killGroup = () => {
      if (process.platform !== 'win32' && child.pid) {
        try {
          process.kill(-child.pid, 'SIGKILL');
          return;
        } catch {
          // The group may have exited between the timer and the signal.
        }
      }
      child.kill('SIGKILL');
    };
    const onAbort = () => {
      aborted = true;
      killGroup();
    };
    input.signal.addEventListener('abort', onAbort, { once: true });
    if (input.signal.aborted) onAbort();
    const timer = setTimeout(killGroup, input.timeoutMs);
    const finish = (result: {
      stdout: string;
      stderr: string;
      exitCode: number;
      aborted: boolean;
    }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      input.signal.removeEventListener('abort', onAbort);
      resolve(result);
    };
    child.on('close', (code, signal) => {
      progress('stdout', outDecoder.end());
      progress('stderr', errDecoder.end());
      const suffix = (t: boolean) => (t ? '\n[output truncated at 2MiB]' : '');
      finish({
        stdout: stdout.toString('utf8') + suffix(truncatedOut),
        stderr:
          stderr.toString('utf8') +
          suffix(truncatedErr) +
          (signal === 'SIGKILL'
            ? aborted
              ? '\n[killed: aborted]'
              : `\n[killed: exceeded ${input.timeoutMs}ms]`
            : ''),
        exitCode: aborted ? 130 : (code ?? (signal ? 124 : 1)),
        aborted,
      });
    });
    child.on('error', (e) => {
      finish({ stdout: '', stderr: String(e?.message ?? e), exitCode: 127, aborted });
    });
  });
}

export function createEnvRpcRouter(cfg: Config): Hono {
  const app = new Hono();
  const rpcSecret = environmentRpcSecret(cfg);
  const cancellations = cancellationRegistry();
  const history = cfg.environmentHistory && cfg.workload === 'environment' && cfg.projectId && cfg.sessionId
    ? new WorkspaceHistory({ workspace: cfg.workspace, state: path.join(cfg.agentStateDir || '/opt/kortix/environment-runtime', 'workspace-history'), scope: JSON.stringify([cfg.projectId, cfg.sessionId]) })
    : null;
  const access = workspaceAccess(cfg);

  app.use('*', async (c, next) => {
    if (!rpcSecret) {
      return c.json({ error: 'daemon not configured', detail: 'KORTIX_ENV_RPC_SECRET unset' }, 503);
    }
    const auth = verifyKortixUserContext(c.req.header(KORTIX_USER_CONTEXT_HEADER), rpcSecret);
    if (!auth.ok) {
      logger.warn('[env-rpc] reject', { reason: auth.reason });
      return c.json({ error: 'unauthorized', reason: auth.reason }, 401);
    }
    return next();
  });

  app.post('/cancel', async (c) => {
    let body: { requestId?: unknown };
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }
    if (
      typeof body.requestId !== 'string' ||
      body.requestId.length === 0 ||
      body.requestId.length > 200
    ) {
      return c.json({ error: 'requestId required' }, 400);
    }
    const cancelled = await cancellations.cancel(body.requestId);
    return c.json(ok({ cancelled }));
  });

  const handler = async (c: Context) => {
    let body: {
      op?: unknown;
      args?: unknown;
      cwd?: unknown;
      requestId?: unknown;
      stream?: unknown;
    };
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }
    const op = typeof body.op === 'string' ? body.op : '';
    const args = (body.args && typeof body.args === 'object' ? body.args : {}) as Record<
      string,
      unknown
    >;
    const cwd = typeof body.cwd === 'string' && body.cwd ? body.cwd : cfg.workspace;
    if (
      body.requestId !== undefined &&
      (typeof body.requestId !== 'string' ||
        body.requestId.length === 0 ||
        body.requestId.length > 200)
    ) {
      return c.json({ error: 'invalid requestId' }, 400);
    }
    const requestId =
      typeof body.requestId === 'string' &&
      body.requestId.length > 0 &&
      body.requestId.length <= 200
        ? body.requestId
        : undefined;

    const historyOperation = ['historyCapture', 'historyApply', 'historyPending', 'historyPlan', 'historyAbort'].includes(op);
    const tracking = !!history && typeof args.__kortixHistoryOperation === 'string' && ['writeFile', 'appendFile', 'renameFile', 'createDir', 'remove', 'exec'].includes(op);
    const exclusive = historyOperation || tracking;
    if (historyOperation && !history) return c.json(err({ code: 'not_supported', message: 'environment workspace history is disabled' }));
    const release = access?.enter(exclusive);
    if (access && !release) return c.json(err({ code: 'busy', message: 'environment operations are active' }));
    let admitted = true;
    const p = (key = 'path') => resolveIn(cwd, String(args[key] ?? ''));
    const execution = cancellations.begin(requestId, c.req.raw.signal);
    const signal = execution.controller.signal;
    let streamingExecution = false;
    const finish = () => {
      execution.finish();
      if (!admitted) return;
      admitted = false;
      release?.();
    };

    let before: string | null = null;
    let workspace: { from: string; to: string } | null = null;
    let checkpointFinished = false;
    const finishCheckpoint = async () => {
      if (checkpointFinished) return workspace;
      checkpointFinished = true;
      if (before && !access?.terminalActive()) {
        try { workspace = { from: before, to: (await history!.capture(crypto.randomUUID())).snapshotId }; }
        catch { workspace = null; }
      }
      return workspace;
    };
    const reply = async (body: any) => c.json(tracking ? { ...body, workspace: await finishCheckpoint() } : body);
    try {
      if (tracking && !access?.terminalActive()) {
        try { before = (await history!.capture(crypto.randomUUID())).snapshotId; }
        catch { before = null; }
      }
      if (signal.aborted) return await reply(err({ code: 'ABORT_ERR', message: 'aborted' }));
      if (history && !historyOperation && await history.pending()) return await reply(err({ code: 'pending', message: 'workspace history recovery is pending' }));
      if (historyOperation && !['historyAbort', 'historyPending'].includes(op) && access?.terminalActive()) return await reply(err({ code: 'busy', message: 'Close running terminals before rewinding workspace files.' }));
      switch (op) {
        case 'historyCapture':
          return await reply(ok(await history!.capture(args.captureId as string)));
        case 'historyApply':
          return await reply(ok(await history!.apply({ operationId: args.operationId as string, from: args.from as string, to: args.to as string })));
        case 'historyPlan':
          return await reply(ok(await history!.plan(args.moves as Array<{ from: string; to: string }>)));
        case 'historyAbort':
          return await reply(ok(await history!.abort({ operationId: args.operationId as string, from: args.from as string, to: args.to as string })));
        case 'historyPending':
          return await reply(ok(await history!.pending()));
        case 'absolutePath':
          return await reply(ok(p()));
        case 'canonicalPath': {
          try {
            return await reply(ok(await fs.realpath(p())));
          } catch (e) {
            return await reply(fsError(e, p()));
          }
        }
        case 'joinPath':
          return await reply(ok(path.join(...((args.parts as string[]) ?? []))));
        case 'exists': {
          try {
            await fs.lstat(p());
            return await reply(ok(true));
          } catch (e) {
            if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') return await reply(ok(false));
            return await reply(fsError(e, p()));
          }
        }
        case 'readTextFile': {
          try {
            return await reply(ok(await fs.readFile(p(), { encoding: 'utf8', signal })));
          } catch (e) {
            return await reply(fsError(e, p()));
          }
        }
        case 'readTextLines': {
          try {
            const text = await fs.readFile(p(), { encoding: 'utf8', signal });
            const lines = text.split(/\r\n|\n|\r/);
            if (lines.at(-1) === '') lines.pop();
            const max = typeof args.maxLines === 'number' ? args.maxLines : undefined;
            return await reply(ok(max === undefined ? lines : lines.slice(0, Math.max(0, max))));
          } catch (e) {
            return await reply(fsError(e, p()));
          }
        }
        case 'readBinaryFile': {
          try {
            const buf = await fs.readFile(p(), { signal });
            return await reply(ok(buf.toString('base64')));
          } catch (e) {
            return await reply(fsError(e, p()));
          }
        }
        case 'writeFile':
        case 'appendFile': {
          try {
            const raw = String(args.content ?? '');
            const data =
              args.encoding === 'base64' ? Buffer.from(raw, 'base64') : Buffer.from(raw, 'utf8');
            await fs.mkdir(path.dirname(p()), { recursive: true });
            if (signal.aborted) return await reply(err({ code: 'ABORT_ERR', message: 'aborted' }));
            if (op === 'appendFile') await fs.appendFile(p(), data);
            else await fs.writeFile(p(), data, { signal });
            return await reply(ok(undefined));
          } catch (e) {
            return await reply(fsError(e, p()));
          }
        }
        case 'renameFile': {
          const src = resolveIn(cwd, String(args.sourcePath ?? ''));
          const dst = resolveIn(cwd, String(args.destinationPath ?? ''));
          try {
            await fs.mkdir(path.dirname(dst), { recursive: true });
            if (signal.aborted) return await reply(err({ code: 'ABORT_ERR', message: 'aborted' }));
            await fs.rename(src, dst);
            return await reply(ok(undefined));
          } catch (e) {
            return await reply(fsError(e, src));
          }
        }
        case 'fileInfo': {
          try {
            const addressedPath = p();
            return await reply(fileInfoValue(addressedPath, await fs.lstat(addressedPath)));
          } catch (e) {
            return await reply(fsError(e, p()));
          }
        }
        case 'listDir': {
          try {
            const directoryPath = p();
            const entries = await fs.readdir(directoryPath, { withFileTypes: true });
            const infos: unknown[] = [];
            for (const entry of entries) {
              const entryPath = path.join(directoryPath, entry.name);
              const info = fileInfoValue(entryPath, await fs.lstat(entryPath));
              if (!info.ok) return await reply(info);
              infos.push(info.value);
            }
            return await reply(ok(infos));
          } catch (e) {
            return await reply(fsError(e, p()));
          }
        }
        case 'createDir': {
          try {
            await fs.mkdir(p(), { recursive: args.recursive !== false });
            return await reply(ok(undefined));
          } catch (e) {
            return await reply(fsError(e, p()));
          }
        }
        case 'remove': {
          try {
            await fs.rm(p(), { recursive: !!args.recursive, force: !!args.force });
            return await reply(ok(undefined));
          } catch (e) {
            return await reply(fsError(e, p()));
          }
        }
        case 'createTempDir': {
          try {
            return await reply(
              ok(await fs.mkdtemp(path.join(os.tmpdir(), String(args.prefix ?? 'tmp-')))),
            );
          } catch (e) {
            return await reply(fsError(e));
          }
        }
        case 'createTempFile': {
          try {
            const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'envrpc-'));
            const file = path.join(
              dir,
              `${String(args.prefix ?? '')}file${String(args.suffix ?? '')}`,
            );
            if (signal.aborted) return await reply(err({ code: 'ABORT_ERR', message: 'aborted' }));
            await fs.writeFile(file, '', { signal });
            return await reply(ok(file));
          } catch (e) {
            return await reply(fsError(e));
          }
        }
        case 'exec': {
          const command = String(args.command ?? '');
          if (!command) return await reply(err({ code: 'invalid', message: 'command required' }));
          const timeoutMs = Math.min(
            typeof args.timeout === 'number' && args.timeout > 0
              ? args.timeout
              : EXEC_TIMEOUT_DEFAULT_MS,
            EXEC_TIMEOUT_MAX_MS,
          );
          const input = {
            command,
            cwd: typeof args.cwd === 'string' && args.cwd ? resolveIn(cwd, args.cwd) : cwd,
            env: (args.env as Record<string, string>) ?? undefined,
            timeoutMs,
            signal,
          };
          if (body.stream === true) {
            streamingExecution = true;
            c.header('Content-Type', RPC_STREAM_CONTENT_TYPE);
            c.header('Cache-Control', 'no-store');
            c.header('X-Accel-Buffering', 'no');
            return stream(c, async (output) => {
              output.onAbort(() => execution.controller.abort());
              let writes = Promise.resolve();
              try {
                const result = await runExec({
                  ...input,
                  onProgress: (progress) => {
                    writes = writes.then(async () => {
                      await output.write(JSON.stringify({ type: 'progress', progress }) + '\n');
                    });
                    void writes.catch(() => execution.controller.abort());
                  },
                });
                await writes;
                const { aborted, ...value } = result;
                const body = aborted ? err({ code: 'ABORT_ERR', message: 'aborted' }) : ok(value);
                await output.write(JSON.stringify({ type: 'result', body: tracking ? { ...body, workspace: await finishCheckpoint() } : body }) + '\n');
              } finally {
                execution.controller.abort();
                finish();
              }
            });
          }
          const result = await runExec(input);
          if (result.aborted) {
            return await reply(err({ code: 'ABORT_ERR', message: 'aborted' }));
          }
          const { aborted: _aborted, ...value } = result;
          return await reply(ok(value));
        }
        default:
          return await reply(
            err({ code: 'unknown_op', message: `unsupported op: ${op || '(missing)'}` }),
          );
      }
    } catch (e) {
      if (signal.aborted) return await reply(err({ code: 'ABORT_ERR', message: 'aborted' }));
      if (e instanceof WorkspaceHistoryError) return await reply(fsError(e));
      // Belt and braces: nothing above should reach here, but a Result beats a 500.
      logger.error('[env-rpc] unexpected failure', e);
      return await reply(fsError(e));
    } finally {
      if (!streamingExecution) finish();
    }
  };

  app.post('/', handler);
  // The worker's RpcTransport appends `/rpc` to its base URL; serve both so
  // the base can be `<edge>/kortix/env-rpc` verbatim.
  app.post('/rpc', handler);

  return app;
}
