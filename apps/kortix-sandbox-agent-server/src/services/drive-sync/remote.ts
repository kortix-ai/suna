import { download, upload, DriveSyncRefused, RemoteChanged } from './drive-transfer'
export { DriveSyncRefused, RemoteChanged, SINGLE_PUT_MAX, BLOCK_BYTES, sha256File } from './drive-transfer'

/**
 * The storage side of one drive, as the box reaches it: the Kortix API's
 * drive-sync routes for this session (projects/routes/session-drive-sync.ts
 * in apps/api). Paths are drive-relative and absolute ("/notes/a.md").
 */
export interface RemoteEntry {
  path: string
  type: 'file' | 'dir' | 'symlink'
  size: number
  mtime: number
}

export interface RemoteStat {
  size: number
  mtime: number
  version: string | null
}

export interface DriveRemote {
  /** The drive's head commit; null for a drive that has never been written. */
  head(): Promise<string | null>
  /** Every entry under `dir`, recursively. */
  list(dir: string): Promise<RemoteEntry[]>
  /** null when the path does not exist. */
  stat(path: string): Promise<RemoteStat | null>
  /** Write the file at `path` into `dest` (replacing it); returns its sha256. */
  download(path: string, dest: string): Promise<string>
  /**
   * Upload the local file `src` to `path`, only if the drive's file is still
   * `expect` ("size:mtime", or "absent"); throws {@link RemoteChanged} when it
   * moved. Returns the version storage gave it, when it says.
   */
  upload(path: string, src: string, expect: string): Promise<{ version: string | null; sha256: string }>
  /**
   * Delete `path` only if the drive's file is still `expect` ("size:mtime");
   * throws {@link RemoteChanged} when it changed since this box read it.
   */
  remove(path: string, expect: string): Promise<void>
  move(src: string, dst: string): Promise<void>
}

export interface SyncMountInfo {
  driveId: string
  name: string
  mountPath: string
  readOnly: boolean
  subdir?: string
}

export interface MountsAnswer {
  ready: boolean
  mounts: SyncMountInfo[]
  notes: string | null
}

export interface DriveSyncApi {
  mounts(): Promise<MountsAnswer>
  drive(driveId: string): DriveRemote
}

export function createHttpDriveSyncApi(opts: {
  apiUrl: string
  projectId: string
  sessionId: string
  token: string
  fetchTimeoutMs?: number
}): DriveSyncApi {
  // KORTIX_API_URL is the API's /v1 base (as the API sets it); accept a bare origin too.
  const origin = opts.apiUrl.trim().replace(/\/+$/, '').replace(/\/v1$/, '')
  const base = `${origin}/v1/projects/${encodeURIComponent(opts.projectId)}/sessions/${encodeURIComponent(opts.sessionId)}/drive-sync`
  const timeout = opts.fetchTimeoutMs ?? 120_000

  const req = async (path: string, init: RequestInit = {}, okStatuses: number[] = []): Promise<Response> => {
    const res = await fetch(`${base}${path}`, {
      ...init,
      signal: init.signal ?? AbortSignal.timeout(timeout),
      headers: { Authorization: `Bearer ${opts.token}`, ...(init.headers as Record<string, string> | undefined) },
    })
    if (res.ok || okStatuses.includes(res.status)) return res
    const text = await res.text().catch(() => '')
    if (res.status === 409 && text.includes('remote_changed')) {
      throw new RemoteChanged(new URL(`${base}${path}`).searchParams.get('path') ?? path)
    }
    if (res.status === 403 || res.status === 404 || res.status === 413 || res.status === 400) {
      throw new DriveSyncRefused(res.status, `${init.method ?? 'GET'} ${path}: ${res.status} ${text.slice(0, 200)}`)
    }
    throw new Error(`${init.method ?? 'GET'} ${path}: ${res.status} ${text.slice(0, 200)}`)
  }
  const json = async <T>(path: string, init: RequestInit = {}): Promise<T> => (await req(path, init)).json() as Promise<T>

  const drive = (driveId: string): DriveRemote => {
    const d = `/${encodeURIComponent(driveId)}`
    const q = (params: Record<string, string>) => `?${new URLSearchParams(params)}`
    return {
      async head() {
        return (await json<{ head: string | null }>(`${d}/head`)).head
      },
      async list(dir) {
        const out: RemoteEntry[] = []
        let cursor: string | null = null
        do {
          const params: Record<string, string> = { path: dir, recursive: 'true' }
          if (cursor) params.cursor = cursor
          const page: { entries: RemoteEntry[]; next_cursor: string | null } = await json(`${d}/files${q(params)}`)
          out.push(...page.entries)
          cursor = page.next_cursor
        } while (cursor)
        return out
      },
      async stat(path) {
        const res = await req(`${d}/files/stat${q({ path })}`, {}, [404])
        if (res.status === 404) return null
        const s = (await res.json()) as RemoteStat
        return { size: Number(s.size), mtime: Number(s.mtime), version: s.version ?? null }
      },
      download: (path, dest) => download(dest, (init) => req(`${d}/files/content${q({ path })}`, init)),
      upload: (path, src, expect) => upload(path, src, {
        put: (body) => json(`${d}/files/content${q({ path, expect })}`, { method: 'PUT', body, headers: { 'Content-Type': 'application/octet-stream' } }),
        plan: (body) => json(`${d}/files/upload`, { method: 'POST', body, headers: { 'Content-Type': 'application/json' } }),
        block: (id, sha, body) => req(`${d}/files/upload/${encodeURIComponent(id)}/blocks/${sha}`, { method: 'PUT', body, headers: { 'Content-Type': 'application/octet-stream' } }),
        commit: (id) => req(`${d}/files/upload/${encodeURIComponent(id)}/commit${q({ path, expect })}`, { method: 'POST' }),
      }),
      async remove(path, expect) {
        await req(`${d}/files${q({ path, recursive: 'false', expect })}`, { method: 'DELETE' }, [404])
      },
      async move(src, dst) {
        await req(`${d}/files/move`, {
          method: 'POST',
          body: JSON.stringify({ src, dst }),
          headers: { 'Content-Type': 'application/json' },
        })
      },
    }
  }

  return {
    async mounts() {
      return json<MountsAnswer>('/mounts')
    },
    drive,
  }
}
