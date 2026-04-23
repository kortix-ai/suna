const SOCKET_PATH =
  process.env.KORTIX_SUPERVISOR_SOCKET || '/run/kortix/supervisor.sock'
const TIMEOUT_MS = 30_000

export interface FsEntry {
  name: string
  type: 'file' | 'directory' | 'symlink' | 'other'
  size: number
  mtime: number
}

export interface FsStat {
  exists: boolean
  type?: 'file' | 'directory' | 'symlink' | 'other'
  size?: number
  mode?: number
  mtime?: number
}

export interface FsContent {
  type: 'text' | 'binary'
  encoding?: 'utf-8' | 'base64'
  content: string
  size: number
}

export class FsError extends Error {
  readonly status: number
  readonly code?: string
  constructor(status: number, code: string | undefined, message: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

async function callFs(path: string, body: unknown): Promise<any> {
  const res = await fetch(`http://supervisor${path}`, {
    // @ts-ignore Bun supports unix
    unix: SOCKET_PATH,
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  const text = await res.text()
  if (!res.ok) {
    let code: string | undefined
    let message = text
    try {
      const parsed = JSON.parse(text) as { error?: string; message?: string }
      code = parsed.error
      message = parsed.message || text
    } catch {}
    throw new FsError(res.status, code, message)
  }
  try {
    return JSON.parse(text)
  } catch {
    throw new FsError(500, 'parse_error', `invalid json from supervisor ${path}: ${text.slice(0, 200)}`)
  }
}

export async function fsReaddir(uid: number, path: string): Promise<FsEntry[]> {
  const res = await callFs('/fs/readdir', { uid, path })
  return res.entries as FsEntry[]
}

export async function fsStat(uid: number, path: string): Promise<FsStat> {
  return callFs('/fs/stat', { uid, path })
}

export async function fsRead(uid: number, path: string): Promise<FsContent> {
  return callFs('/fs/read', { uid, path })
}

export async function fsMkdir(uid: number, path: string): Promise<void> {
  await callFs('/fs/mkdir', { uid, path })
}

export async function fsUnlink(uid: number, path: string): Promise<void> {
  await callFs('/fs/unlink', { uid, path })
}

export async function fsRename(uid: number, from: string, to: string): Promise<void> {
  await callFs('/fs/rename', { uid, from, to })
}
