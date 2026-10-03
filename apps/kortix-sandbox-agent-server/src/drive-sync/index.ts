import { accessSync, constants, mkdirSync } from 'node:fs'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Hono } from 'hono'
import type { Config } from '../config'
import { KORTIX_USER_CONTEXT_HEADER, verifyKortixUserContext } from '../kortix-user-context'
import { logger } from '../logger'
import { resolveKortixRuntimeStateDirectory } from '../runtime-state-dir'
import { MountSync } from './engine'
import { type DriveSyncApi, type SyncMountInfo, createHttpDriveSyncApi } from './remote'

/**
 * Kortix Drive in a box that is not on Platinum: the daemon copies each drive
 * the session was given to its usual path under /drives and keeps it in sync
 * (see engine.ts). The API turns it on with KORTIX_DRIVE_SYNC=1 and answers
 * which drives, where and with which access; the box calls only the Kortix
 * API with its own session credential, never storage directly.
 */

export const DRIVE_SYNC_ENV = 'KORTIX_DRIVE_SYNC'
const DRIVES_PREFIX = '/drives'

export interface DriveSyncServiceOptions {
  api: DriveSyncApi
  /** Where /drives lives in this box (tests point it at a temp dir). */
  root?: string
  stateDir: string
  intervalMs?: number
  settleMs?: number
}

export class DriveSyncService {
  private readonly root: string
  private readonly intervalMs: number
  private readonly mounts = new Map<string, { info: SyncMountInfo; sync: MountSync }>()
  private timer: ReturnType<typeof setTimeout> | null = null
  private stopped = false
  private notes: string | null = null
  private written: string | null = null
  private readonly notices: string[] = []
  private tick: Promise<void> | null = null

  constructor(private readonly opts: DriveSyncServiceOptions) {
    this.root = opts.root ?? DRIVES_PREFIX
    this.intervalMs = opts.intervalMs ?? 5_000
  }

  private localDir(mountPath: string): string {
    const rel = mountPath.startsWith(`${DRIVES_PREFIX}/`) ? mountPath.slice(DRIVES_PREFIX.length + 1) : mountPath.replace(/^\/+/, '')
    return join(this.root, ...rel.split('/'))
  }

  private key(m: SyncMountInfo): string {
    return `${m.driveId}:${m.mountPath}`
  }

  /** Bring the set of synced mounts in line with what the API says. False until the boot recorded them. */
  async refreshMounts(): Promise<boolean> {
    const answer = await this.opts.api.mounts()
    if (!answer.ready) return false
    const want = new Map(answer.mounts.map((m) => [this.key(m), m]))
    for (const [key, entry] of this.mounts) {
      if (want.has(key)) continue
      // The drive left the session (detached, access removed, drive deleted).
      // The API already pushed it on a detach; anything still not on the
      // drive is kept aside, never deleted.
      this.mounts.delete(key)
      await this.release(entry, true)
    }
    for (const [key, info] of want) {
      const have = this.mounts.get(key)
      if (have) {
        // Turning read-only reverts local edits: keep a copy of any the drive lacks first.
        if (info.readOnly && !have.info.readOnly) await this.release(have, false)
        have.sync.setReadOnly(info.readOnly)
        have.info = info
        continue
      }
      this.mounts.set(key, {
        info,
        sync: new MountSync({
          remote: this.opts.api.drive(info.driveId),
          localDir: this.localDir(info.mountPath),
          remoteDir: info.subdir ?? '/',
          readOnly: info.readOnly,
          statePath: join(this.opts.stateDir, `${info.driveId}${info.mountPath.replace(/[^A-Za-z0-9_-]+/g, '_')}.json`),
          ...(this.opts.settleMs !== undefined ? { settleMs: this.opts.settleMs } : {}),
        }),
      })
      logger.info('[drive-sync] syncing drive', { mountPath: info.mountPath, readOnly: info.readOnly })
    }
    if (answer.notes !== null) this.notes = answer.notes
    await this.writeNotes()
    return true
  }

  /**
   * A mount loses write (`gone`: leaves the box). Push what is left; what
   * still is not on the drive goes to /drives/.detached/<name>-<time> and the
   * notes say so. Only a copy with nothing unsent is deleted.
   */
  private async release(entry: { info: SyncMountInfo; sync: MountSync }, gone: boolean): Promise<void> {
    const { info, sync } = entry
    let pending = await sync.pendingLocalChanges().catch(() => 1)
    if (pending > 0) {
      await sync.cycle({ flush: true }).catch(() => {})
      pending = await sync.pendingLocalChanges().catch(() => 1)
    }
    if (pending === 0) {
      if (gone) await sync.discard()
      logger.info('[drive-sync] drive released, nothing unsent', { mountPath: info.mountPath, gone })
      return
    }
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-')
    const dest = join(this.root, '.detached', `${info.mountPath.split('/').pop()}-${stamp}`)
    await sync.setAside(dest, gone)
    const shown = dest.startsWith(this.root) ? `${DRIVES_PREFIX}${dest.slice(this.root.length)}` : dest
    this.notices.push(
      `${info.mountPath} (${info.name}) ${gone ? 'left this session' : 'became read-only'} with ${pending} change(s) the drive does not have. They are kept at ${shown}.`,
    )
    logger.warn('[drive-sync] unsent changes kept aside', { mountPath: info.mountPath, keptAt: dest, pending, gone })
  }

  private async writeNotes(): Promise<void> {
    if (this.notes === null) return
    const text = this.notices.length
      ? `${this.notes}\n## Kept aside\n\n${this.notices.map((n) => `- ${n}`).join('\n')}\n`
      : this.notes
    if (text === this.written) return
    await mkdir(this.root, { recursive: true })
    const tmp = join(this.root, '.kortix-sync-readme')
    await writeFile(tmp, text, { mode: 0o644 })
    await rename(tmp, join(this.root, 'README.md'))
    this.written = text
  }

  /** One pass over every mount. A failing mount does not stop the others. */
  async syncOnce(opts: { flush?: boolean } = {}): Promise<void> {
    await Promise.all(
      [...this.mounts.values()].map((m) =>
        m.sync.cycle(opts).catch((err) => {
          logger.warn('[drive-sync] cycle failed', { mountPath: m.info.mountPath, error: err instanceof Error ? err.message : String(err) })
        }),
      ),
    )
  }

  start(): void {
    const loop = async () => {
      if (this.stopped) return
      this.tick = (async () => {
        try {
          if (await this.refreshMounts()) await this.syncOnce()
        } catch (err) {
          logger.warn('[drive-sync] pass failed', { error: err instanceof Error ? err.message : String(err) })
        }
      })()
      await this.tick
      this.tick = null
      if (!this.stopped) this.timer = setTimeout(loop, this.intervalMs)
    }
    void loop()
  }

  /**
   * Push everything not yet on the drives (or on one drive), now: the box is
   * about to stop or the drive is leaving. `ok` only when nothing is left unsent.
   */
  async flush(timeoutMs = 25_000, driveId?: string): Promise<{ ok: boolean }> {
    const targets = [...this.mounts.values()].filter((m) => !driveId || m.info.driveId === driveId)
    const work = (async () => {
      await this.tick?.catch(() => {})
      await Promise.all(targets.map((m) => m.sync.cycle({ flush: true }).catch(() => {})))
      let left = 0
      for (const m of targets) left += await m.sync.pendingLocalChanges().catch(() => 1)
      return left
    })()
    const timedOut = new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), timeoutMs).unref?.())
    const result = await Promise.race([work, timedOut])
    if (result === 'timeout') logger.warn('[drive-sync] final push did not finish in time', { timeoutMs })
    else if (result > 0) logger.warn('[drive-sync] final push left changes unsent', { left: result })
    return { ok: result === 0 }
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
  }
}

let service: DriveSyncService | null = null

/**
 * The folder the drives sync into: `preferred` (/drives) when the runtime
 * user can write it. The entrypoint hands /drives over with sudo; an image
 * without passwordless sudo leaves it root-owned, and the drives then sync
 * into `fallback` (~/drives), loudly, instead of not at all.
 */
export function resolveDriveSyncRoot(preferred: string, fallback: string): string {
  try {
    mkdirSync(preferred, { recursive: true })
    accessSync(preferred, constants.W_OK)
    return preferred
  } catch (err) {
    logger.error('[drive-sync] drives folder is not writable by the runtime user; syncing into the fallback', {
      preferred,
      fallback,
      error: err instanceof Error ? err.message : String(err),
    })
    mkdirSync(fallback, { recursive: true })
    return fallback
  }
}

/** Start drive sync when the API asked for it. One per process. */
export function startDriveSyncFromEnv(cfg: Config, env: NodeJS.ProcessEnv = process.env): DriveSyncService | null {
  if (service) return service
  const on = (env[DRIVE_SYNC_ENV] ?? '').trim()
  if (on !== '1' && on.toLowerCase() !== 'true') return null
  const sessionId = env.KORTIX_SESSION_ID?.trim()
  if (!cfg.apiUrl || !cfg.projectId || !cfg.sandboxToken || !sessionId) {
    logger.error('[drive-sync] missing API/project/session/token env; drives will not sync')
    return null
  }
  const root = resolveDriveSyncRoot(
    env.KORTIX_DRIVE_SYNC_ROOT?.trim() || DRIVES_PREFIX,
    join(env.HOME?.trim() || '/home/kortix', 'drives'),
  )
  service = new DriveSyncService({
    api: createHttpDriveSyncApi({ apiUrl: cfg.apiUrl, projectId: cfg.projectId, sessionId, token: cfg.sandboxToken }),
    root,
    stateDir: join(resolveKortixRuntimeStateDirectory(env), 'drive-sync'),
  })
  service.start()
  logger.info('[drive-sync] started')
  return service
}

/** The daemon is stopping: push what is left, bounded. */
export async function flushDriveSyncOnShutdown(timeoutMs = 20_000): Promise<void> {
  if (!service) return
  service.stop()
  await service.flush(timeoutMs).catch(() => {})
}

/** POST /kortix/drive-sync/flush: the API asks for the final push before it stops the box. */
export function createDriveSyncRouter(cfg: Config): Hono {
  const app = new Hono()
  app.post('/flush', async (c) => {
    if (!cfg.sandboxToken) return c.json({ error: 'daemon not configured' }, 503)
    const auth = verifyKortixUserContext(c.req.header(KORTIX_USER_CONTEXT_HEADER), cfg.sandboxToken)
    if (!auth.ok) return c.json({ error: 'unauthorized', reason: auth.reason }, 401)
    if (!service) return c.json({ ok: true, syncing: false })
    const { ok } = await service.flush(25_000, c.req.query('driveId') || undefined)
    return c.json({ ok, syncing: true }, ok ? 200 : 202)
  })
  return app
}
