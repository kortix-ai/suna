import { createHash } from 'node:crypto'
import { open, rename, rm } from 'node:fs/promises'
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
export async function download(dest: string, req: (init: RequestInit) => Promise<Response>) {
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
      const res = await req(have > 0 ? { headers: { Range: `bytes=${have}-` } } : {})
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
}
export async function upload(path: string, src: string, io: {
  put(body: Uint8Array): Promise<{ version?: string }>
  plan(body: string): Promise<{ upload_id: string; missing: string[] }>
  block(id: string, sha: string, body: Uint8Array): Promise<Response>
  commit(id: string): Promise<Response>
}) {
  // One handle: the size and the bytes come from the same open file.
  const fh = await open(src, 'r')
  try {
    const size = (await fh.stat()).size
    if (size <= SINGLE_PUT_MAX) {
      const body = new Uint8Array(await fh.readFile())
      const sha = createHash('sha256').update(body).digest('hex')
      const r = await io.put(body)
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
    const plan = await io.plan(JSON.stringify({ files: [{ path, size, blocks }] }))
    const missing = new Set(plan.missing ?? [])
    for (let i = 0; i < blocks.length; i++) {
      const sha = blocks[i]!
      if (!missing.has(sha)) continue
      missing.delete(sha)
      const off = i * BLOCK_BYTES
      const { bytesRead } = await fh.read(buf, 0, Math.min(BLOCK_BYTES, size - off), off)
      await io.block(plan.upload_id, sha, new Uint8Array(buf.subarray(0, bytesRead)))
    }
    await io.commit(plan.upload_id)
    return { version: null, sha256: whole.digest('hex') }
  } finally {
    await fh.close()
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
