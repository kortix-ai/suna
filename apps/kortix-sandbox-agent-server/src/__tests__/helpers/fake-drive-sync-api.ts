import { createHash } from 'node:crypto'
import type { SyncMountInfo } from '../../drive-sync/remote'

/**
 * The Kortix API's drive-sync routes (apps/api projects/routes/session-drive-sync.ts)
 * over in-memory drives, on a real port: the box's HTTP client and sync
 * engine run against it unchanged. Like the real routes it answers only the
 * session's bearer, only for drives in `mounts`, inside each mount's folder,
 * and refuses a write through a read-only mount.
 */

interface FakeFile {
  data: Uint8Array
  mtime: number
  version: string
}

export interface FakeDriveSyncApi {
  url: string
  projectId: string
  sessionId: string
  token: string
  /** Every request, as "METHOD /drive-relative-route path". */
  calls: string[]
  mounts: SyncMountInfo[]
  ready: boolean
  notes: string
  /** Blocks uploaded through the block protocol, by sha. */
  blocks: Map<string, Uint8Array>
  write(driveId: string, path: string, content: string | Uint8Array): void
  read(driveId: string, path: string): string | null
  remove(driveId: string, path: string): void
  paths(driveId: string): string[]
  stop(): void
}

export function startFakeDriveSyncApi(): FakeDriveSyncApi {
  const projectId = 'proj-1'
  const sessionId = '11111111-2222-3333-4444-555555555555'
  const token = 'session-token'
  const drives = new Map<string, { files: Map<string, FakeFile>; head: number }>()
  const uploads = new Map<string, { driveId: string; path: string; blocks: string[] }>()
  let clock = Date.now()
  let seq = 0
  const driveOf = (id: string) => {
    let d = drives.get(id)
    if (!d) drives.set(id, (d = { files: new Map(), head: 0 }))
    return d
  }
  const put = (driveId: string, path: string, data: Uint8Array) => {
    const d = driveOf(driveId)
    const f = { data, mtime: ++clock, version: `v${++seq}` }
    d.files.set(path, f)
    d.head++
    return f
  }
  const within = (path: string, dir?: string) => !dir || path === dir || path.startsWith(`${dir}/`)

  const api: FakeDriveSyncApi = {
    url: '',
    projectId,
    sessionId,
    token,
    calls: [],
    mounts: [],
    ready: true,
    notes: '# Drives in this session\n',
    blocks: new Map(),
    write: (driveId, path, content) => {
      put(driveId, path, typeof content === 'string' ? new TextEncoder().encode(content) : content)
    },
    read: (driveId, path) => {
      const f = drives.get(driveId)?.files.get(path)
      return f ? new TextDecoder().decode(f.data) : null
    },
    remove: (driveId, path) => {
      const d = driveOf(driveId)
      d.files.delete(path)
      d.head++
    },
    paths: (driveId) => [...(drives.get(driveId)?.files.keys() ?? [])].sort(),
    stop: () => server.stop(true),
  }

  const allowed = (driveId: string, path: string, need: 'read' | 'write') =>
    api.mounts.some((m) => m.driveId === driveId && within(path, m.subdir) && (need === 'read' || !m.readOnly))

  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      const prefix = `/v1/projects/${projectId}/sessions/${sessionId}/drive-sync`
      if (req.headers.get('authorization') !== `Bearer ${token}` || !url.pathname.startsWith(prefix)) {
        return Response.json({ error: 'forbidden' }, { status: 403 })
      }
      const route = url.pathname.slice(prefix.length)
      const q = url.searchParams
      if (route === '/mounts') api.calls.push('GET /mounts')
      if (route === '/mounts') return Response.json({ ready: api.ready, mounts: api.ready ? api.mounts : [], notes: api.ready ? api.notes : null })
      const [, driveId, ...rest] = route.split('/')
      const sub = `/${rest.join('/')}`
      const d = driveOf(driveId!)
      const path = q.get('path') ?? '/'
      const need = req.method === 'GET' ? 'read' : 'write'
      api.calls.push(`${req.method} ${sub.replace(/\/(u\d+)\/(blocks\/[0-9a-f]+|commit)$/, '/:id/$2').replace(/blocks\/[0-9a-f]+$/, 'blocks')} ${q.get('path') ?? ''}`.trim())
      if (sub === '/head') return Response.json({ head: d.head ? `c${d.head}` : null })
      if (sub === '/files' && req.method === 'GET') {
        if (!allowed(driveId!, path, 'read')) return Response.json({ error: 'Drive not found' }, { status: 404 })
        const base = path === '/' ? '' : path
        const dirs = new Set<string>()
        const entries: Array<{ path: string; type: string; size: number; mtime: number }> = []
        for (const [p, f] of d.files) {
          if (!p.startsWith(`${base}/`)) continue
          entries.push({ path: p, type: 'file', size: f.data.byteLength, mtime: f.mtime })
          const parts = p.slice(base.length + 1).split('/')
          for (let i = 1; i < parts.length; i++) dirs.add(`${base}/${parts.slice(0, i).join('/')}`)
        }
        for (const dir of dirs) entries.push({ path: dir, type: 'dir', size: 0, mtime: 0 })
        // Two pages, so the client's cursor walk is exercised.
        const half = Math.ceil(entries.length / 2)
        const second = q.get('cursor') === 'page2'
        return Response.json({ entries: second ? entries.slice(half) : entries.slice(0, half), next_cursor: !second && entries.length > 1 ? 'page2' : null })
      }
      if (!allowed(driveId!, path, need) && !sub.startsWith('/files/upload') && sub !== '/files/move') {
        return Response.json({ error: need === 'write' ? 'This drive is read-only in this session' : 'Drive not found' }, { status: need === 'write' ? 403 : 404 })
      }
      if (sub === '/files/stat') {
        const f = d.files.get(path)
        if (!f) return Response.json({ error: 'not found' }, { status: 404 })
        return Response.json({ path, type: 'file', size: f.data.byteLength, mtime: f.mtime, version: f.version })
      }
      if (sub === '/files/content' && req.method === 'GET') {
        const f = d.files.get(path)
        if (!f) return Response.json({ error: 'not found' }, { status: 404 })
        const range = /^bytes=(\d+)-$/.exec(req.headers.get('range') ?? '')
        if (range) {
          const from = Number(range[1])
          return new Response(f.data.slice(from), {
            status: 206,
            headers: { 'content-range': `bytes ${from}-${f.data.byteLength - 1}/${f.data.byteLength}` },
          })
        }
        return new Response(f.data, { headers: { 'content-length': String(f.data.byteLength) } })
      }
      if (sub === '/files/content' && req.method === 'PUT') {
        const f = put(driveId!, path, new Uint8Array(await req.arrayBuffer()))
        return Response.json({ path, size: f.data.byteLength, version: f.version })
      }
      if (sub === '/files' && req.method === 'DELETE') {
        d.files.delete(path)
        d.head++
        return Response.json({ ok: true })
      }
      if (sub === '/files/move') {
        const body = (await req.json()) as { src: string; dst: string }
        if (!allowed(driveId!, body.src, 'write') || !allowed(driveId!, body.dst, 'write')) {
          return Response.json({ error: 'read-only' }, { status: 403 })
        }
        const f = d.files.get(body.src)
        if (!f) return Response.json({ error: 'not found' }, { status: 404 })
        d.files.delete(body.src)
        d.files.set(body.dst, { ...f, mtime: ++clock })
        d.head++
        return Response.json({ ok: true })
      }
      if (sub === '/files/upload') {
        const plan = (await req.json()) as { files: Array<{ path: string; size: number; blocks: string[] }> }
        const file = plan.files[0]!
        if (!allowed(driveId!, file.path, 'write')) return Response.json({ error: 'read-only' }, { status: 403 })
        const id = `u${++seq}`
        uploads.set(id, { driveId: driveId!, path: file.path, blocks: file.blocks })
        return Response.json({ upload_id: id, missing: [...new Set(file.blocks.filter((b) => !api.blocks.has(b)))] })
      }
      const block = /^\/files\/upload\/([^/]+)\/blocks\/([0-9a-f]{64})$/.exec(sub)
      if (block) {
        const data = new Uint8Array(await req.arrayBuffer())
        if (createHash('sha256').update(data).digest('hex') !== block[2]) return Response.json({ error: 'bad block' }, { status: 400 })
        api.blocks.set(block[2]!, data)
        return new Response(null, { status: 204 })
      }
      const commit = /^\/files\/upload\/([^/]+)\/commit$/.exec(sub)
      if (commit) {
        const up = uploads.get(commit[1]!)
        if (!up) return Response.json({ error: 'no upload' }, { status: 404 })
        const parts = up.blocks.map((b) => api.blocks.get(b)!)
        const data = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0))
        let off = 0
        for (const p of parts) {
          data.set(p, off)
          off += p.byteLength
        }
        put(up.driveId, up.path, data)
        return Response.json({ commit_id: `c${d.head}`, files: 1 })
      }
      return Response.json({ error: `no route ${req.method} ${sub}` }, { status: 404 })
    },
  })
  api.url = `http://127.0.0.1:${server.port}`
  return api
}
