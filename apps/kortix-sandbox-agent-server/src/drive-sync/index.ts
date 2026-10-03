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
      // The drive left the session (detached, access removed, drive deleted): its copy goes too.
      this.mounts.delete(key)
      await entry.sync.discard()
      logger.info('[drive-sync] drive removed from the session', { mountPath: entry.info.mountPath })
    }
    for (const [key, info] of want) {
      const have = this.mounts.get(key)
      if (have) {
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
    if (answer.notes !== null && answer.notes !== this.notes) {
      await mkdir(this.root, { recursive: true })
      const tmp = join(this.root, '.kortix-sync-readme')
      await writeFile(tmp, answer.notes, { mode: 0o644 })
      await rename(tmp, join(this.root, 'README.md'))
      this.notes = answer.notes
    }
    return true
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

  /** Push everything not yet on the drives, now (the box is about to stop). */
  async flush(timeoutMs = 25_000): Promise<{ ok: boolean }> {
    const work = (async () => {
      await this.tick?.catch(() => {})
      await this.syncOnce({ flush: true })
    })()
    const timedOut = new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), timeoutMs).unref?.())
    const result = await Promise.race([work.then(() => 'done' as const), timedOut])
    if (result === 'timeout') logger.warn('[drive-sync] final push did not finish in time', { timeoutMs })
    return { ok: result === 'done' }
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
  }
}

let service: DriveSyncService | null = null

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
  service = new DriveSyncService({
    api: createHttpDriveSyncApi({ apiUrl: cfg.apiUrl, projectId: cfg.projectId, sessionId, token: cfg.sandboxToken }),
    root: env.KORTIX_DRIVE_SYNC_ROOT?.trim() || DRIVES_PREFIX,
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
    const { ok } = await service.flush()
    return c.json({ ok, syncing: true }, ok ? 200 : 202)
  })
  return app
}
