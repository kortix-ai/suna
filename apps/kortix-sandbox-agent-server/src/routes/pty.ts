import { randomUUID } from 'node:crypto'
import { Hono } from 'hono'

import type { Config } from '../config'
import {
  KORTIX_USER_CONTEXT_HEADER,
  verifyKortixUserContext,
} from '../kortix-user-context'
import { logger } from '../logger'

// Scrollback replayed to a newly (re)attached viewer, so reattaching after a
// disconnect shows recent context instead of a blank prompt — same UX the
// OpenCode-backed terminal already gives today.
const SCROLLBACK_MAX_BYTES = 64 * 1024

// Matches OpenCode's own `Pty` entity shape (id/title/command/args/cwd/
// status/pid/exitCode) so web/CLI clients built against that contract don't
// need to change their types when they swap to this endpoint.
export interface KortixPtyMeta {
  id: string
  title: string
  command: string
  args: string[]
  cwd: string
  status: 'running' | 'exited'
  pid: number
  exitCode?: number
}

interface Viewer {
  onData: (chunk: string) => void
  onExit: (exitCode: number | null) => void
}

interface PtyEntry {
  meta: KortixPtyMeta
  proc: ReturnType<typeof Bun.spawn>
  scrollback: string[]
  scrollbackBytes: number
  viewers: Set<Viewer>
}

export interface PtyAttachHandle {
  /** Buffered recent output to flush to the viewer immediately on attach. */
  replay: string
  write: (data: string) => void
  resize: (cols: number, rows: number) => void
  detach: () => void
}

export interface PtyRegistry {
  list(): KortixPtyMeta[]
  create(opts: { command?: string; args?: string[]; cwd?: string; title?: string; env?: Record<string, string> }): KortixPtyMeta
  update(id: string, opts: { title?: string; size?: { rows: number; cols: number } }): KortixPtyMeta | null
  remove(id: string): boolean
  /** Attach a live viewer to a running pty — used by the WS bridge in proxy.ts. */
  attach(id: string, viewer: Viewer): PtyAttachHandle | null
}

/**
 * In-memory PTY registry, owned for the life of the daemon process (a
 * sandbox restart naturally kills every pty in it anyway, matching how the
 * OpenCode-backed terminal already behaves). Entries persist across
 * `server.reload()` config hot-swaps — the registry is constructed once in
 * `startProxy` and threaded through, never rebuilt on reload.
 */
export function createPtyRegistry(cfg: Config): PtyRegistry {
  const entries = new Map<string, PtyEntry>()

  function broadcast(entry: PtyEntry, chunk: string): void {
    entry.scrollback.push(chunk)
    entry.scrollbackBytes += Buffer.byteLength(chunk)
    while (entry.scrollbackBytes > SCROLLBACK_MAX_BYTES && entry.scrollback.length > 1) {
      const dropped = entry.scrollback.shift()
      if (dropped) entry.scrollbackBytes -= Buffer.byteLength(dropped)
    }
    for (const viewer of entry.viewers) {
      try { viewer.onData(chunk) } catch {}
    }
  }

  function finish(entry: PtyEntry, exitCode: number | null): void {
    entry.meta.status = 'exited'
    if (exitCode !== null) entry.meta.exitCode = exitCode
    for (const viewer of entry.viewers) {
      try { viewer.onExit(exitCode) } catch {}
    }
    entry.viewers.clear()
  }

  return {
    list() {
      return [...entries.values()].map((e) => ({ ...e.meta }))
    },

    create(opts) {
      const command = opts.command?.trim() || process.env.SHELL || '/bin/bash'
      const args = opts.args ?? (opts.command ? [] : ['-l'])
      const cwd = opts.cwd || cfg.workspace
      const id = `kpty_${randomUUID().replace(/-/g, '')}`
      const env = {
        ...process.env,
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
        ...(opts.env ?? {}),
      }

      const entry: PtyEntry = {
        meta: {
          id,
          title: opts.title?.trim() || command,
          command,
          args,
          cwd,
          status: 'running',
          pid: 0,
        },
        proc: undefined as unknown as ReturnType<typeof Bun.spawn>,
        scrollback: [],
        scrollbackBytes: 0,
        viewers: new Set(),
      }

      const proc = Bun.spawn([command, ...args], {
        cwd,
        env,
        onExit: (_subprocess, exitCode) => {
          finish(entry, exitCode)
        },
        terminal: {
          cols: 80,
          rows: 24,
          name: 'xterm-256color',
          data: (_terminal, data) => {
            broadcast(entry, Buffer.from(data).toString())
          },
        },
      })

      entry.proc = proc
      entry.meta.pid = proc.pid
      entries.set(id, entry)
      logger.info('[pty] created', { id, command, args, cwd, pid: proc.pid })
      return { ...entry.meta }
    },

    update(id, opts) {
      const entry = entries.get(id)
      if (!entry || entry.meta.status !== 'running') return null
      if (opts.title !== undefined) entry.meta.title = opts.title
      if (opts.size) entry.proc.terminal?.resize(opts.size.cols, opts.size.rows)
      return { ...entry.meta }
    },

    remove(id) {
      const entry = entries.get(id)
      if (!entry) return false
      try { entry.proc.terminal?.close() } catch {}
      try { entry.proc.kill() } catch {}
      entries.delete(id)
      logger.info('[pty] removed', { id })
      return true
    },

    attach(id, viewer) {
      const entry = entries.get(id)
      if (!entry || entry.meta.status !== 'running') return null
      entry.viewers.add(viewer)
      return {
        replay: entry.scrollback.join(''),
        write: (data) => {
          try { entry.proc.terminal?.write(data) } catch {}
        },
        resize: (cols, rows) => {
          try { entry.proc.terminal?.resize(cols, rows) } catch {}
        },
        detach: () => {
          entry.viewers.delete(viewer)
        },
      }
    },
  }
}

/**
 * `/kortix/pty` — Kortix's own PTY implementation, independent of whatever
 * agent runtime (OpenCode today) happens to be running. `/kortix/*` is
 * exempted from the global auth middleware in proxy.ts, so — like every
 * sibling user-facing router here (`refresh.ts`, `abort.ts`) — every route
 * verifies `X-Kortix-User-Context` itself.
 */
export function createPtyRouter(cfg: Config, registry: PtyRegistry): Hono {
  const app = new Hono()

  app.use('*', async (c, next) => {
    if (!cfg.sandboxToken) {
      return c.json({ error: 'daemon not configured', detail: 'KORTIX_TOKEN unset' }, 503)
    }
    const auth = verifyKortixUserContext(c.req.header(KORTIX_USER_CONTEXT_HEADER), cfg.sandboxToken)
    if (!auth.ok) {
      logger.warn('[pty] reject', { reason: auth.reason })
      return c.json({ error: 'unauthorized', reason: auth.reason }, 401)
    }
    return next()
  })

  app.get('/', (c) => c.json(registry.list()))

  app.post('/', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      command?: unknown
      args?: unknown
      cwd?: unknown
      title?: unknown
      env?: unknown
    }
    if (body.command !== undefined && typeof body.command !== 'string') {
      return c.json({ error: 'command must be a string' }, 400)
    }
    if (body.args !== undefined && (!Array.isArray(body.args) || body.args.some((a) => typeof a !== 'string'))) {
      return c.json({ error: 'args must be a string[]' }, 400)
    }
    try {
      const created = registry.create({
        command: body.command as string | undefined,
        args: body.args as string[] | undefined,
        cwd: typeof body.cwd === 'string' ? body.cwd : undefined,
        title: typeof body.title === 'string' ? body.title : undefined,
        env:
          body.env && typeof body.env === 'object' && !Array.isArray(body.env)
            ? (body.env as Record<string, string>)
            : undefined,
      })
      return c.json(created)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logger.error('[pty] create failed', err)
      return c.json({ error: 'pty create failed', message }, 500)
    }
  })

  app.patch('/:id', async (c) => {
    const id = c.req.param('id')
    const body = (await c.req.json().catch(() => ({}))) as {
      title?: unknown
      size?: unknown
    }
    const size =
      body.size && typeof body.size === 'object'
        ? (body.size as { rows?: unknown; cols?: unknown })
        : undefined
    if (size && (typeof size.rows !== 'number' || typeof size.cols !== 'number')) {
      return c.json({ error: 'size must be { rows: number, cols: number }' }, 400)
    }
    const updated = registry.update(id, {
      title: typeof body.title === 'string' ? body.title : undefined,
      size: size as { rows: number; cols: number } | undefined,
    })
    if (!updated) return c.json({ error: 'not found' }, 404)
    return c.json(updated)
  })

  app.delete('/:id', (c) => {
    const removed = registry.remove(c.req.param('id'))
    if (!removed) return c.json({ error: 'not found' }, 404)
    return c.json({ ok: true })
  })

  return app
}
