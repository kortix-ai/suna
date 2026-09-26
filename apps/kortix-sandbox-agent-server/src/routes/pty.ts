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

/**
 * DEF-D 2026-09-26 — how long a running pty with no attached viewer may sit
 * silent before it stops counting as "live work" the agent swap must protect.
 *
 * A Platinum box is suspended and resumed rather than rebooted, so this
 * daemon process can run for weeks (measured: 30.8 days). Over that lifetime
 * a terminal someone opened once and then navigated away from — never typed
 * `exit`, just closed the tab — sits `status: 'running'` forever, and
 * treating that as live work blocked EVERY later swap on the box: the pty
 * blocker fired on every single reconcile, for hours, and the box never
 * gained a daemon update again.
 *
 * 30 minutes is generous against a real interactive session (nobody
 * genuinely watching a shell goes half an hour without a keystroke or a
 * scrollback glance — and glancing at it is an attach, which resets the
 * clock to zero regardless of this bound) and small against "the box lives
 * for weeks" — so a fleet that used to wait forever now waits at most this
 * long per abandoned terminal. A pty that keeps producing output (a tailed
 * log, a running build) is never silent long enough to reach it: every
 * broadcast resets `lastActivityAt`, so it stays protected for as long as it
 * is genuinely doing something. Visible on `GET /kortix/pty` as `idleMs`
 * against this bound, and in the swap-deferred log line's `detail`.
 */
export const PTY_ABANDONED_AFTER_MS = 30 * 60_000

/**
 * Is this pty NOT live work the swap must protect?
 *
 * An exited pty is definitely not — there is nothing left to protect. Among
 * running ones, an attached viewer always wins, regardless of the clock:
 * somebody is looking at it right now. Absent one, a pty younger than the
 * bound is given the benefit of the doubt — a terminal opened 10 s ago with
 * nobody attached yet is a race with the client's own WS handshake, not an
 * abandoned shell.
 */
export function ptyIsAbandoned(
  entry: Pick<KortixPtyMeta, 'status' | 'attachedViewers' | 'idleMs'>,
  thresholdMs: number = PTY_ABANDONED_AFTER_MS,
): boolean {
  if (entry.status !== 'running') return true
  if (entry.attachedViewers > 0) return false
  return entry.idleMs >= thresholdMs
}

/** What `registerAgentSwapBlocker('pty', ...)` actually asks: is ANY pty live work? */
export function ptyHasLiveWork(
  entries: readonly KortixPtyMeta[],
  thresholdMs: number = PTY_ABANDONED_AFTER_MS,
): boolean {
  return entries.some((e) => !ptyIsAbandoned(e, thresholdMs))
}

// Matches OpenCode's own `Pty` entity shape (id/title/command/args/cwd/
// status/pid/exitCode) so web/CLI clients built against that contract don't
// need to change their types when they swap to this endpoint.
//
// `attachedViewers` and `idleMs` are additive to that contract — DEF-D
// 2026-09-26 — so the swap blocker (and anyone inspecting `GET /kortix/pty`)
// can see the same bound the daemon decides a swap by, instead of a bare
// `status: 'running'` that never expires on its own.
export interface KortixPtyMeta {
  id: string
  title: string
  command: string
  args: string[]
  cwd: string
  status: 'running' | 'exited'
  pid: number
  exitCode?: number
  /** Live WS viewers attached right now (see `PtyRegistry.attach`). */
  attachedViewers: number
  /** Milliseconds since the last input, output, or attach on this pty. */
  idleMs: number
}

interface Viewer {
  onData: (chunk: string) => void
  onExit: (exitCode: number | null) => void
}

interface PtyEntry {
  meta: Omit<KortixPtyMeta, 'attachedViewers' | 'idleMs'>
  proc: ReturnType<typeof Bun.spawn>
  scrollback: string[]
  scrollbackBytes: number
  viewers: Set<Viewer>
  /** Last input, output, or attach. DEF-D's idle clock. */
  lastActivityAt: number
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
  /**
   * Lookup-or-create: the WS bridge's single entry point for "open a
   * terminal". A requested id that names a *running* entry reattaches (a
   * genuine reconnect resumes the same shell + scrollback). A requested id
   * that names an *exited* entry reports that explicitly so the caller can
   * tell the client the session really ended (never silently reincarnated —
   * the user may have typed `exit` on purpose). Every other case — id
   * missing from the registry entirely (daemon restarted and forgot it, a
   * stale id from a reload, a create/attach race) or no id supplied at all —
   * mints a fresh pty and attaches to it instead of failing. When a
   * requested id is supplied but unknown, the new entry reuses that exact
   * id so the caller's existing bookkeeping (tab/URL/list-cache key) keeps
   * working with zero protocol changes.
   */
  attachOrCreate(id: string | undefined, viewer: Viewer): AttachOrCreateResult
}

export type AttachOrCreateResult =
  | { kind: 'attached'; meta: KortixPtyMeta; handle: PtyAttachHandle }
  | { kind: 'created'; meta: KortixPtyMeta; handle: PtyAttachHandle }
  | { kind: 'exited'; meta: KortixPtyMeta }

/**
 * In-memory PTY registry, owned for the life of the daemon process (a
 * sandbox restart naturally kills every pty in it anyway, matching how the
 * OpenCode-backed terminal already behaves). Entries persist across
 * `server.reload()` config hot-swaps — the registry is constructed once in
 * `startProxy` and threaded through, never rebuilt on reload.
 */
export function createPtyRegistry(cfg: Config): PtyRegistry {
  const entries = new Map<string, PtyEntry>()

  /** The one place a `KortixPtyMeta` is built from a live entry. */
  function snapshot(entry: PtyEntry): KortixPtyMeta {
    return {
      ...entry.meta,
      attachedViewers: entry.viewers.size,
      idleMs: Date.now() - entry.lastActivityAt,
    }
  }

  function broadcast(entry: PtyEntry, chunk: string): void {
    entry.scrollback.push(chunk)
    entry.scrollbackBytes += Buffer.byteLength(chunk)
    while (entry.scrollbackBytes > SCROLLBACK_MAX_BYTES && entry.scrollback.length > 1) {
      const dropped = entry.scrollback.shift()
      if (dropped) entry.scrollbackBytes -= Buffer.byteLength(dropped)
    }
    entry.lastActivityAt = Date.now()
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

  // Shared by `create()` (HTTP — always mints a fresh id) and
  // `attachOrCreate()` (WS lookup-or-create — reuses the requested id when
  // one was supplied, so a caller reconnecting after a registry loss keeps
  // its existing tab/URL/list-cache key working unmodified).
  function spawnEntry(
    id: string,
    opts: { command?: string; args?: string[]; cwd?: string; title?: string; env?: Record<string, string> },
  ): PtyEntry {
    const command = opts.command?.trim() || process.env.SHELL || '/bin/bash'
    const args = opts.args ?? (opts.command ? [] : ['-l'])
    const cwd = opts.cwd || cfg.workspace
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
      lastActivityAt: Date.now(),
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
    return entry
  }

  function buildHandle(entry: PtyEntry, viewer: Viewer): PtyAttachHandle {
    entry.viewers.add(viewer)
    // Attaching is itself evidence someone is here, even before they type —
    // otherwise a viewer that opens a long-idle pty and just looks at it
    // would find it still counted "abandoned" until the first keystroke.
    entry.lastActivityAt = Date.now()
    return {
      replay: entry.scrollback.join(''),
      write: (data) => {
        entry.lastActivityAt = Date.now()
        try { entry.proc.terminal?.write(data) } catch {}
      },
      resize: (cols, rows) => {
        try { entry.proc.terminal?.resize(cols, rows) } catch {}
      },
      detach: () => {
        entry.viewers.delete(viewer)
      },
    }
  }

  return {
    list() {
      return [...entries.values()].map(snapshot)
    },

    create(opts) {
      const id = `kpty_${randomUUID().replace(/-/g, '')}`
      const entry = spawnEntry(id, opts)
      logger.info('[pty] created', { id, command: entry.meta.command, args: entry.meta.args, cwd: entry.meta.cwd, pid: entry.meta.pid })
      return snapshot(entry)
    },

    update(id, opts) {
      const entry = entries.get(id)
      if (!entry || entry.meta.status !== 'running') return null
      if (opts.title !== undefined) entry.meta.title = opts.title
      if (opts.size) entry.proc.terminal?.resize(opts.size.cols, opts.size.rows)
      return snapshot(entry)
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
      return buildHandle(entry, viewer)
    },

    attachOrCreate(id, viewer) {
      const entry = id ? entries.get(id) : undefined
      if (entry) {
        if (entry.meta.status === 'running') {
          return { kind: 'attached', meta: snapshot(entry), handle: buildHandle(entry, viewer) }
        }
        // Present but exited: the shell really ended (e.g. the user typed
        // `exit`). Report it plainly instead of silently reincarnating a
        // session the user may have deliberately closed.
        return { kind: 'exited', meta: snapshot(entry) }
      }

      // Id missing entirely (never existed, a stale id surviving a registry
      // loss, a create/attach race) or no id supplied at all — a normal
      // "open a terminal" always succeeds with a working shell. Reuse the
      // requested id when present so the caller's existing bookkeeping
      // (tab/URL/list-cache key) keeps working with zero protocol changes.
      const newId = id || `kpty_${randomUUID().replace(/-/g, '')}`
      const created = spawnEntry(newId, {})
      logger.info('[pty] lookup-or-create minted a new pty', {
        requestedId: id ?? null,
        id: newId,
        pid: created.meta.pid,
      })
      return { kind: 'created', meta: snapshot(created), handle: buildHandle(created, viewer) }
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
