import { mkdirSync, chmodSync, existsSync, unlinkSync } from 'fs'
import { DaemonRegistry } from './daemons'
import { ProjectLifecycle } from './projects'
import { installUpload } from './files'
import * as fsops from './fs-ops'
import type {
  DaemonSpec,
  FileInstallSpec,
  ProjectDeleteSpec,
  ProjectEnsureSpec,
  ProjectGrantSpec,
  ProjectRevokeSpec,
} from './schema'

const SOCKET_PATH = process.env.KORTIX_SUPERVISOR_SOCKET || '/run/kortix/supervisor.sock'
const SOCKET_DIR = SOCKET_PATH.substring(0, SOCKET_PATH.lastIndexOf('/'))

mkdirSync(SOCKET_DIR, { recursive: true, mode: 0o755 })
if (existsSync(SOCKET_PATH)) {
  try {
    unlinkSync(SOCKET_PATH)
  } catch {}
}

const registry = new DaemonRegistry()
registry.startIdleReaper()

const projects = new ProjectLifecycle({
  respawnDaemon: async (username, supabaseUserId) => {
    if (supabaseUserId) {
      await registry.stop(supabaseUserId)
    } else {
      await registry.stopByUsername(username)
    }
  },
})

const shutdown = async (signal: string) => {
  console.log(`[supervisor] received ${signal}, shutting down`)
  await registry.shutdown()
  process.exit(0)
}
process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('uncaughtException', (err) => {
  console.error('[supervisor] uncaught:', err)
})
process.on('unhandledRejection', (err) => {
  console.error('[supervisor] unhandled:', err)
})

function isDaemonSpec(value: unknown): value is DaemonSpec {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return (
    typeof v.supabase_user_id === 'string' &&
    typeof v.username === 'string' &&
    typeof v.linux_uid === 'number' &&
    typeof v.storage_base === 'string'
  )
}

function isProjectEnsureSpec(value: unknown): value is ProjectEnsureSpec {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return (
    typeof v.project_id === 'string' &&
    Array.isArray(v.members) &&
    v.members.every(
      (m) =>
        typeof m === 'object' &&
        m !== null &&
        typeof (m as Record<string, unknown>).username === 'string' &&
        typeof (m as Record<string, unknown>).linux_uid === 'number',
    )
  )
}

function isProjectGrantSpec(value: unknown): value is ProjectGrantSpec {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return (
    typeof v.project_id === 'string' &&
    typeof v.username === 'string' &&
    typeof v.linux_uid === 'number'
  )
}

function isProjectRevokeSpec(value: unknown): value is ProjectRevokeSpec {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return typeof v.project_id === 'string' && typeof v.username === 'string'
}

function isProjectDeleteSpec(value: unknown): value is ProjectDeleteSpec {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return typeof v.project_id === 'string'
}

function isFileInstallSpec(value: unknown): value is FileInstallSpec {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return (
    typeof v.src === 'string' &&
    typeof v.dest_dir === 'string' &&
    typeof v.filename === 'string' &&
    typeof v.owner_uid === 'number'
  )
}

async function handleFsOp(req: Request, path: string): Promise<Response> {
  const body = await readJson(req)
  if (typeof body !== 'object' || body === null) {
    return Response.json({ error: 'invalid_body' }, { status: 400 })
  }
  const v = body as Record<string, unknown>
  const uid = typeof v.uid === 'number' ? v.uid : null
  if (uid === null) return Response.json({ error: 'uid required' }, { status: 400 })

  try {
    switch (path) {
      case '/fs/readdir': {
        if (typeof v.path !== 'string') return badReq('path required')
        const entries = await fsops.readdir(uid, v.path)
        return Response.json({ entries })
      }
      case '/fs/stat': {
        if (typeof v.path !== 'string') return badReq('path required')
        return Response.json(await fsops.stat(uid, v.path))
      }
      case '/fs/read': {
        if (typeof v.path !== 'string') return badReq('path required')
        return Response.json(await fsops.readFile(uid, v.path))
      }
      case '/fs/mkdir': {
        if (typeof v.path !== 'string') return badReq('path required')
        await fsops.mkdir(uid, v.path)
        return Response.json({ ok: true, path: v.path })
      }
      case '/fs/unlink': {
        if (typeof v.path !== 'string') return badReq('path required')
        await fsops.unlink(uid, v.path)
        return Response.json({ ok: true, path: v.path })
      }
      case '/fs/rename': {
        if (typeof v.from !== 'string' || typeof v.to !== 'string') return badReq('from/to required')
        await fsops.rename(uid, v.from, v.to)
        return Response.json({ ok: true, path: v.to })
      }
      default:
        return new Response('not found', { status: 404 })
    }
  } catch (err) {
    const anyErr = err as { code?: string | number; message?: string }
    const message = anyErr.message || String(err)
    const code = typeof anyErr.code === 'string' ? anyErr.code : undefined
    const status = code === 'ENOENT' ? 404 : code === 'EACCES' ? 403 : 500
    return Response.json({ error: code || 'op_failed', message }, { status })
  }
}

function badReq(message: string): Response {
  return Response.json({ error: 'invalid_body', message }, { status: 400 })
}

async function readJson(req: Request): Promise<unknown> {
  try {
    return await req.json()
  } catch {
    return null
  }
}

const server = Bun.serve({
  unix: SOCKET_PATH,
  async fetch(req) {
    const url = new URL(req.url)
    const path = url.pathname

    if (req.method === 'GET' && path === '/health') {
      return new Response('ok', { status: 200 })
    }

    if (req.method === 'POST' && path === '/daemon/ensure') {
      const body = await readJson(req)
      if (!isDaemonSpec(body)) {
        return Response.json({ error: 'invalid_body' }, { status: 400 })
      }
      try {
        const port = await registry.ensure(body)
        return Response.json({ port })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        console.error(`[supervisor] ensure failed: ${message}`)
        return Response.json({ error: 'spawn_failed', message }, { status: 500 })
      }
    }

    if (req.method === 'POST' && path === '/daemon/stop') {
      const body = await readJson(req)
      const userId =
        typeof body === 'object' && body !== null
          ? (body as Record<string, unknown>).supabase_user_id
          : null
      if (typeof userId !== 'string') {
        return Response.json({ error: 'invalid_body' }, { status: 400 })
      }
      await registry.stop(userId)
      return Response.json({ ok: true })
    }

    if (req.method === 'GET' && path === '/daemon/list') {
      return Response.json({ daemons: registry.list() })
    }

    if (req.method === 'POST' && path === '/project/ensure') {
      const body = await readJson(req)
      if (!isProjectEnsureSpec(body)) {
        return Response.json({ error: 'invalid_body' }, { status: 400 })
      }
      try {
        const result = await projects.ensure(body)
        return Response.json(result)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        console.error(`[supervisor] project ensure failed: ${message}`)
        return Response.json({ error: 'ensure_failed', message }, { status: 500 })
      }
    }

    if (req.method === 'POST' && path === '/project/grant') {
      const body = await readJson(req)
      if (!isProjectGrantSpec(body)) {
        return Response.json({ error: 'invalid_body' }, { status: 400 })
      }
      try {
        const result = await projects.grant(body)
        return Response.json(result)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        console.error(`[supervisor] project grant failed: ${message}`)
        return Response.json({ error: 'grant_failed', message }, { status: 500 })
      }
    }

    if (req.method === 'POST' && path === '/project/revoke') {
      const body = await readJson(req)
      if (!isProjectRevokeSpec(body)) {
        return Response.json({ error: 'invalid_body' }, { status: 400 })
      }
      try {
        const result = await projects.revoke(body)
        return Response.json(result)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        console.error(`[supervisor] project revoke failed: ${message}`)
        return Response.json({ error: 'revoke_failed', message }, { status: 500 })
      }
    }

    if (req.method === 'POST' && path === '/project/delete') {
      const body = await readJson(req)
      if (!isProjectDeleteSpec(body)) {
        return Response.json({ error: 'invalid_body' }, { status: 400 })
      }
      try {
        const result = await projects.delete(body)
        return Response.json(result)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        console.error(`[supervisor] project delete failed: ${message}`)
        return Response.json({ error: 'delete_failed', message }, { status: 500 })
      }
    }

    if (req.method === 'POST' && path === '/file/install') {
      const body = await readJson(req)
      if (!isFileInstallSpec(body)) {
        return Response.json({ error: 'invalid_body' }, { status: 400 })
      }
      try {
        const result = installUpload(body)
        return Response.json(result)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        console.error(`[supervisor] file install failed: ${message}`)
        return Response.json({ error: 'install_failed', message }, { status: 500 })
      }
    }

    if (req.method === 'POST' && path.startsWith('/fs/')) {
      return handleFsOp(req, path)
    }

    return new Response('not found', { status: 404 })
  },
})

try {
  chmodSync(SOCKET_PATH, 0o666)
} catch (err) {
  console.warn(
    `[supervisor] chmod on ${SOCKET_PATH} failed: ${err instanceof Error ? err.message : err}`,
  )
}

console.log(`[supervisor] listening on ${SOCKET_PATH}`)
void server
