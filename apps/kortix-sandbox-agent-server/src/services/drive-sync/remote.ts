import { createHash } from 'node:crypto'
import { open, rename, rm } from 'node:fs/promises'

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

/** A refusal from the API that retrying will not fix (403/404/413). */
export class DriveSyncRefused extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'DriveSyncRefused'
  }
}

/**
 * The drive's file is no longer the version the change was based on: the
 * API refused the write (409). The engine keeps both versions.
 */
export class RemoteChanged extends Error {
  constructor(readonly path: string) {
    super(`${path} changed on the drive`)
    this.name = 'RemoteChanged'
  }
}

/** Files up to this size go in one PUT; larger ones use the block upload. */
export const SINGLE_PUT_MAX = 8 * 1024 * 1024
export const BLOCK_BYTES = 1024 * 1024
const DOWNLOAD_ATTEMPTS = 4

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
      async download(path, dest) {
        // Ranged and resumable: a dropped connection continues from the bytes already on disk.
        const part = `${dest}.part`
        await rm(part, { force: true })
        let total: number | null = null
        for (let attempt = 1; ; attempt++) {
          // One handle per attempt: the resume point is its own size, never a
          // path checked and then reopened (CodeQL js/file-system-race).
          const fh = await open(part, 'a')
          try {
            const have = (await fh.stat()).size
            if (total !== null && have >= total) break
            const res = await req(`${d}/files/content${q({ path })}`, have > 0 ? { headers: { Range: `bytes=${have}-` } } : {})
            const length = Number(res.headers.get('x-pt-content-length') ?? res.headers.get('content-length') ?? NaN)
            const range = res.headers.get('content-range')
            if (res.status === 206 && range) total = Number(range.split('/')[1])
            else if (Number.isFinite(length)) total = length
            // A whole-file answer restarts the copy; appends then land at 0.
            if (res.status !== 206) await fh.truncate(0)
            if (res.body) for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) await fh.write(chunk)
            const got = (await fh.stat()).size
            if (total === null || got >= total) break
            throw new Error(`short read ${got}/${total}`)
          } catch (err) {
            if (err instanceof DriveSyncRefused || attempt >= DOWNLOAD_ATTEMPTS) {
              await rm(part, { force: true })
              throw err
            }
            await new Promise((r) => setTimeout(r, attempt * 500))
          } finally {
            await fh.close()
          }
        }
        const sha = await sha256File(part)
        await rename(part, dest)
        return sha
      },
      async upload(path, src, expect) {
        // One handle: the size and the bytes come from the same open file.
        const fh = await open(src, 'r')
        try {
          const size = (await fh.stat()).size
          if (size <= SINGLE_PUT_MAX) {
            const body = new Uint8Array(await fh.readFile())
            const sha = createHash('sha256').update(body).digest('hex')
            const r = await json<{ version?: string }>(`${d}/files/content${q({ path, expect })}`, {
              method: 'PUT',
              body,
              headers: { 'Content-Type': 'application/octet-stream' },
            })
            return { version: r.version ?? null, sha256: sha }
          }
          // Block upload: hash each 1 MiB block, send only the ones storage lacks.
          const blocks: string[] = []
          const whole = createHash('sha256')
          const buf = Buffer.alloc(BLOCK_BYTES)
          for (let off = 0; off < size; off += BLOCK_BYTES) {
            const { bytesRead } = await fh.read(buf, 0, Math.min(BLOCK_BYTES, size - off), off)
            const slice = buf.subarray(0, bytesRead)
            whole.update(slice)
            blocks.push(createHash('sha256').update(slice).digest('hex'))
          }
          const plan = await json<{ upload_id: string; missing: string[] }>(`${d}/files/upload`, {
            method: 'POST',
            body: JSON.stringify({ files: [{ path, size, blocks }] }),
            headers: { 'Content-Type': 'application/json' },
          })
          const missing = new Set(plan.missing ?? [])
          for (let i = 0; i < blocks.length; i++) {
            const sha = blocks[i]!
            if (!missing.has(sha)) continue
            missing.delete(sha)
            const off = i * BLOCK_BYTES
            const { bytesRead } = await fh.read(buf, 0, Math.min(BLOCK_BYTES, size - off), off)
            await req(`${d}/files/upload/${encodeURIComponent(plan.upload_id)}/blocks/${sha}`, {
              method: 'PUT',
              body: new Uint8Array(buf.subarray(0, bytesRead)),
              headers: { 'Content-Type': 'application/octet-stream' },
            })
          }
          await req(`${d}/files/upload/${encodeURIComponent(plan.upload_id)}/commit${q({ path, expect })}`, { method: 'POST' })
          return { version: null, sha256: whole.digest('hex') }
        } finally {
          await fh.close()
        }
      },
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

export async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256')
  const fh = await open(path, 'r')
  try {
    const buf = Buffer.alloc(BLOCK_BYTES)
    for (;;) {
      const { bytesRead } = await fh.read(buf, 0, BLOCK_BYTES, null)
      if (!bytesRead) break
      hash.update(buf.subarray(0, bytesRead))
    }
  } finally {
    await fh.close()
  }
  return hash.digest('hex')
}
