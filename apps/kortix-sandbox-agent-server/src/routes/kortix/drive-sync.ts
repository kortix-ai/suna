import { Hono } from 'hono'
import type { Config } from '@/lib/config/config'
import { KORTIX_USER_CONTEXT_HEADER, verifyKortixUserContext } from '@/lib/kortix-api/kortix-user-context'
import { activeDriveSync } from '@/services/drive-sync/drive-sync'

/** POST /kortix/drive-sync/flush: the API asks for the final push before it stops the box. */
export function createDriveSyncRouter(cfg: Config): Hono {
  const app = new Hono()
  app.post('/flush', async (c) => {
    if (!cfg.sandboxToken) return c.json({ error: 'daemon not configured' }, 503)
    const auth = verifyKortixUserContext(c.req.header(KORTIX_USER_CONTEXT_HEADER), cfg.sandboxToken)
    if (!auth.ok) return c.json({ error: 'unauthorized', reason: auth.reason }, 401)
    const service = activeDriveSync()
    if (!service) return c.json({ ok: true, syncing: false })
    const { ok } = await service.flush(25_000, c.req.query('driveId') || undefined)
    return c.json({ ok, syncing: true }, ok ? 200 : 202)
  })
  return app
}
