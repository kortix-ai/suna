import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Hono, type Context } from 'hono'

import type { Config } from '../config'
import {
  KORTIX_USER_CONTEXT_HEADER,
  verifyKortixUserContext,
} from '../kortix-user-context'
import { logger } from '../logger'

/**
 * `/kortix/env-rpc` — the environment half of the harness/worker split (P1.7).
 *
 * The pi worker's built-in tools (bash, read, write, edit) run against an
 * ExecutionEnv whose every operation is one POST here. This route is that
 * environment: direct filesystem + shell access on THIS box, executed as the
 * session (the box exists for exactly one session and holds its credential).
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

const EXEC_TIMEOUT_DEFAULT_MS = 120_000
const EXEC_TIMEOUT_MAX_MS = 10 * 60_000
/** Per-stream cap so one `cat big.bin` cannot balloon the worker's context. */
const EXEC_OUTPUT_CAP_BYTES = 2 * 1024 * 1024

interface EnvRpcError {
  code: string
  message: string
  path?: string
}

const ok = (value: unknown) => ({ ok: true as const, value })
const err = (error: EnvRpcError) => ({ ok: false as const, error })

export function environmentRpcSecret(
  cfg: Pick<Config, 'envRpcSecret' | 'sandboxToken'>,
): string | undefined {
  return cfg.envRpcSecret ?? cfg.sandboxToken
}

function fsError(e: unknown, fallbackPath?: string) {
  const errno = e as NodeJS.ErrnoException
  return err({
    code: errno?.code ?? 'unknown',
    message: errno?.message ?? String(e),
    path: (errno as { path?: string })?.path ?? fallbackPath,
  })
}

function resolveIn(cwd: string, p: string): string {
  return path.isAbsolute(p) ? p : path.resolve(cwd, p)
}

async function runExec(input: {
  command: string
  cwd: string
  env?: Record<string, string>
  timeoutMs: number
}): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    const child = spawn('bash', ['-lc', input.command], {
      cwd: input.cwd,
      env: { ...process.env, ...(input.env ?? {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout: Buffer = Buffer.alloc(0)
    let stderr: Buffer = Buffer.alloc(0)
    let truncatedOut = false
    let truncatedErr = false
    const cap = (buf: Buffer, chunk: Buffer, markTruncated: () => void): Buffer => {
      if (buf.length >= EXEC_OUTPUT_CAP_BYTES) {
        markTruncated()
        return buf
      }
      const room = EXEC_OUTPUT_CAP_BYTES - buf.length
      if (chunk.length > room) markTruncated()
      return Buffer.concat([buf, chunk.subarray(0, room)])
    }
    child.stdout.on('data', (c: Buffer) => {
      stdout = cap(stdout, c, () => {
        truncatedOut = true
      })
    })
    child.stderr.on('data', (c: Buffer) => {
      stderr = cap(stderr, c, () => {
        truncatedErr = true
      })
    })
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
    }, input.timeoutMs)
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      const suffix = (t: boolean) => (t ? '\n[output truncated at 2MiB]' : '')
      resolve({
        stdout: stdout.toString('utf8') + suffix(truncatedOut),
        stderr:
          stderr.toString('utf8') +
          suffix(truncatedErr) +
          (signal === 'SIGKILL' ? `\n[killed: exceeded ${input.timeoutMs}ms]` : ''),
        exitCode: code ?? (signal ? 124 : 1),
      })
    })
    child.on('error', (e) => {
      clearTimeout(timer)
      resolve({ stdout: '', stderr: String(e?.message ?? e), exitCode: 127 })
    })
  })
}

export function createEnvRpcRouter(cfg: Config): Hono {
  const app = new Hono()
  const rpcSecret = environmentRpcSecret(cfg)

  app.use('*', async (c, next) => {
    if (!rpcSecret) {
      return c.json(
        { error: 'daemon not configured', detail: 'KORTIX_ENV_RPC_SECRET unset' },
        503,
      )
    }
    const auth = verifyKortixUserContext(c.req.header(KORTIX_USER_CONTEXT_HEADER), rpcSecret)
    if (!auth.ok) {
      logger.warn('[env-rpc] reject', { reason: auth.reason })
      return c.json({ error: 'unauthorized', reason: auth.reason }, 401)
    }
    return next()
  })

  const handler = async (c: Context) => {
    let body: { op?: unknown; args?: unknown; cwd?: unknown }
    try {
      body = (await c.req.json()) as typeof body
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400)
    }
    const op = typeof body.op === 'string' ? body.op : ''
    const args = (body.args && typeof body.args === 'object' ? body.args : {}) as Record<
      string,
      unknown
    >
    const cwd = typeof body.cwd === 'string' && body.cwd ? body.cwd : cfg.workspace

    const p = (key = 'path') => resolveIn(cwd, String(args[key] ?? ''))

    try {
      switch (op) {
        case 'absolutePath':
          return c.json(ok(p()))
        case 'canonicalPath': {
          try {
            return c.json(ok(await fs.realpath(p())))
          } catch (e) {
            return c.json(fsError(e, p()))
          }
        }
        case 'joinPath':
          return c.json(ok(path.join(...((args.parts as string[]) ?? []))))
        case 'exists': {
          try {
            await fs.access(p())
            return c.json(ok(true))
          } catch {
            return c.json(ok(false))
          }
        }
        case 'readTextFile': {
          try {
            return c.json(ok(await fs.readFile(p(), 'utf8')))
          } catch (e) {
            return c.json(fsError(e, p()))
          }
        }
        case 'readTextLines': {
          try {
            const text = await fs.readFile(p(), 'utf8')
            const lines = text.split('\n')
            const max = typeof args.maxLines === 'number' ? args.maxLines : undefined
            return c.json(ok(max ? lines.slice(0, max) : lines))
          } catch (e) {
            return c.json(fsError(e, p()))
          }
        }
        case 'readBinaryFile': {
          try {
            const buf = await fs.readFile(p())
            return c.json(ok(buf.toString('base64')))
          } catch (e) {
            return c.json(fsError(e, p()))
          }
        }
        case 'writeFile':
        case 'appendFile': {
          try {
            const raw = String(args.content ?? '')
            const data =
              args.encoding === 'base64' ? Buffer.from(raw, 'base64') : Buffer.from(raw, 'utf8')
            await fs.mkdir(path.dirname(p()), { recursive: true })
            if (op === 'appendFile') await fs.appendFile(p(), data)
            else await fs.writeFile(p(), data)
            return c.json(ok(undefined))
          } catch (e) {
            return c.json(fsError(e, p()))
          }
        }
        case 'renameFile': {
          const src = resolveIn(cwd, String(args.sourcePath ?? ''))
          const dst = resolveIn(cwd, String(args.destinationPath ?? ''))
          try {
            await fs.mkdir(path.dirname(dst), { recursive: true })
            await fs.rename(src, dst)
            return c.json(ok(undefined))
          } catch (e) {
            return c.json(fsError(e, src))
          }
        }
        case 'fileInfo': {
          try {
            const st = await fs.stat(p())
            return c.json(
              ok({
                size: st.size,
                isFile: st.isFile(),
                isDirectory: st.isDirectory(),
                modifiedAt: st.mtime.toISOString(),
              }),
            )
          } catch (e) {
            return c.json(fsError(e, p()))
          }
        }
        case 'listDir': {
          try {
            const entries = await fs.readdir(p(), { withFileTypes: true })
            return c.json(
              ok(
                entries.map((entry) => ({
                  name: entry.name,
                  isDirectory: entry.isDirectory(),
                  isFile: entry.isFile(),
                })),
              ),
            )
          } catch (e) {
            return c.json(fsError(e, p()))
          }
        }
        case 'createDir': {
          try {
            await fs.mkdir(p(), { recursive: args.recursive !== false })
            return c.json(ok(undefined))
          } catch (e) {
            return c.json(fsError(e, p()))
          }
        }
        case 'remove': {
          try {
            await fs.rm(p(), { recursive: !!args.recursive, force: !!args.force })
            return c.json(ok(undefined))
          } catch (e) {
            return c.json(fsError(e, p()))
          }
        }
        case 'createTempDir': {
          try {
            return c.json(ok(await fs.mkdtemp(path.join(os.tmpdir(), String(args.prefix ?? 'tmp-')))))
          } catch (e) {
            return c.json(fsError(e))
          }
        }
        case 'createTempFile': {
          try {
            const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'envrpc-'))
            const file = path.join(dir, `${String(args.prefix ?? '')}file${String(args.suffix ?? '')}`)
            await fs.writeFile(file, '')
            return c.json(ok(file))
          } catch (e) {
            return c.json(fsError(e))
          }
        }
        case 'exec': {
          const command = String(args.command ?? '')
          if (!command) return c.json(err({ code: 'invalid', message: 'command required' }))
          const timeoutMs = Math.min(
            typeof args.timeout === 'number' && args.timeout > 0
              ? args.timeout
              : EXEC_TIMEOUT_DEFAULT_MS,
            EXEC_TIMEOUT_MAX_MS,
          )
          const result = await runExec({
            command,
            cwd: typeof args.cwd === 'string' && args.cwd ? resolveIn(cwd, args.cwd) : cwd,
            env: (args.env as Record<string, string>) ?? undefined,
            timeoutMs,
          })
          return c.json(ok(result))
        }
        default:
          return c.json(err({ code: 'unknown_op', message: `unsupported op: ${op || '(missing)'}` }))
      }
    } catch (e) {
      // Belt and braces: nothing above should reach here, but a Result beats a 500.
      logger.error('[env-rpc] unexpected failure', e)
      return c.json(fsError(e))
    }
  }

  app.post('/', handler)
  // The worker's RpcTransport appends `/rpc` to its base URL; serve both so
  // the base can be `<edge>/kortix/env-rpc` verbatim.
  app.post('/rpc', handler)

  return app
}
