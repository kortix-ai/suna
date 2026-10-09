import { createHash } from 'node:crypto'
import { Readable, Transform, type Writable } from 'node:stream'

import { logger } from '../log/logger'
import { ProjectSnapshotError, abortReason, errorMessage, isAbortError, type S3Stage } from './errors'

/**
 * A transfer that delivers no byte for this long is dead, whatever the socket
 * says: a reset mid-body does not always surface as a stream error under Bun,
 * and the Git path aborts a stalled pack the same way (http.lowSpeedTime=12).
 * Classified `unavailable` (transient, retried), never `timeout`.
 */
export const DEFAULT_INACTIVITY_TIMEOUT_MS = 12_000

/** Range resumes of one object whose body closed short, before the attempt fails. */
const MAX_RESUMES = 3

export interface SnapshotTransferOptions {
  fetchImpl?: typeof fetch
  inactivityTimeoutMs?: number
  tarBinary?: string
}

/** Query strings carry the signature; only scheme://host/path may be logged. */
export function sanitizeUrlForLog(raw: string): string {
  try {
    const u = new URL(raw)
    return `${u.protocol}//${u.host}${u.pathname}`
  } catch {
    return raw.split('?')[0] ?? raw
  }
}

export function linkedSignal(parent: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal; dispose: () => void; timedOut: () => boolean } {
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort(new Error(`timed out after ${timeoutMs}ms`))
  }, timeoutMs)
  const onParentAbort = () => controller.abort(parent?.reason)
  if (parent) {
    if (parent.aborted) onParentAbort()
    else parent.addEventListener('abort', onParentAbort, { once: true })
  }
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer)
      parent?.removeEventListener('abort', onParentAbort)
    },
    timedOut: () => timedOut,
  }
}

export interface StreamedObject {
  received: number
  digest: string
  /** ms from request start to first byte / last byte. */
  firstByteMs: number
  totalMs: number
}

/**
 * Stream one presigned object through the SHA-256 hasher into `sink`, and
 * (optionally) into `tap` — a second consumer whose errors are RECORDED, never
 * fatal: the transfer's own outcome is decided by byte count and digest.
 * Resolves only when the sink has finished and the bytes are exactly the
 * expected object; rejects with a classified ProjectSnapshotError otherwise.
 */
export async function streamObject(
  url: string,
  expected: { bytes: number; sha256: string },
  io: { sink: Writable; tap?: Writable; onTapError?: (err: unknown) => void },
  options: {
    fetchImpl?: typeof fetch
    signal?: AbortSignal
    timeoutMs: number
    inactivityTimeoutMs?: number
    accept: string
    /** Stage reported for transport failures. */
    stage: S3Stage
    /** Stage reported when the bytes are complete but not the object. */
    digestStage: S3Stage
  },
): Promise<StreamedObject> {
  const expectedBytes = expected.bytes
  const inactivityMs = options.inactivityTimeoutMs ?? DEFAULT_INACTIVITY_TIMEOUT_MS
  const link = linkedSignal(options.signal, options.timeoutMs)
  const started = Date.now()
  const stage = options.stage

  /**
   * GET the object — or, with `offset`, only its missing tail — and vet the
   * response before a byte flows. Returns null when a resume is refused (the
   * store answered anything but exactly `offset..end`): the caller reports the
   * short transfer and the provider's retry takes over.
   */
  const open = async (offset: number): Promise<Readable | null> => {
    let res: Response
    try {
      // No Authorization header: the URL IS the authorization, and the object
      // store would reject a foreign credential anyway. A SigV4 query presign
      // signs only `host`, so a Range header does not invalidate it.
      res = await (options.fetchImpl ?? fetch)(url, {
        headers: offset > 0 ? { accept: options.accept, range: `bytes=${offset}-` } : { accept: options.accept },
        signal: link.signal,
        redirect: 'error',
      })
    } catch (err) {
      const reason = isAbortError(err) ? abortReason(options, link.timedOut()) : 'unavailable'
      throw new ProjectSnapshotError(stage, reason, `object request failed: ${errorMessage(err)}`, 0, { cause: err })
    }
    if (res.status === 403) {
      throw new ProjectSnapshotError(stage, 'expired-authorization', 'object download authorization was refused (HTTP 403)')
    }
    if (res.status === 404) throw new ProjectSnapshotError(stage, 'missing', 'archive object not found (HTTP 404)')
    if (offset > 0) {
      const range = res.headers.get('content-range')
      if (res.status !== 206 || range !== `bytes ${offset}-${expectedBytes - 1}/${expectedBytes}`) {
        await res.body?.cancel().catch(() => {})
        return null
      }
    } else if (!res.ok) {
      throw new ProjectSnapshotError(stage, 'unavailable', `object HTTP ${res.status}`)
    }
    if (!res.body) throw new ProjectSnapshotError(stage, 'unavailable', 'object response has no body')
    const want = expectedBytes - offset
    const declared = Number(res.headers.get('content-length'))
    if (Number.isFinite(declared) && declared > 0 && declared !== want) {
      throw new ProjectSnapshotError(stage, declared > want ? 'limit-exceeded' : 'digest-mismatch', `object content-length ${declared} != expected ${want}`)
    }
    return Readable.fromWeb(res.body as never)
  }

  try {
    // Only a resume can be refused; the first GET either streams or throws.
    const first = (await open(0))!

    const hash = createHash('sha256')
    let received = 0
    // Bytes the sources handed to the hasher — the resume offset. `received`
    // counts what the hasher already transformed, which lags when its consumers
    // push back, so it cannot name the next byte to ask for.
    let delivered = 0
    let resumes = 0
    let firstByteAt = 0
    let watchdog: ReturnType<typeof setTimeout> | undefined
    let onInactivity: (() => void) | null = null
    const armWatchdog = () => {
      if (watchdog) clearTimeout(watchdog)
      watchdog = setTimeout(() => onInactivity?.(), inactivityMs)
    }
    const hasher = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        if (!firstByteAt) firstByteAt = Date.now()
        armWatchdog()
        received += chunk.length
        if (received > expectedBytes) {
          // Every response declared exactly its share of `expectedBytes`
          // (checked in `open`), so an overrun is transport garbage, not a
          // large object: Bun 1.3 (the sandbox agent's build runtime) re-issues
          // the GET after a mid-body socket reset and appends the second
          // response to this same stream. Transient → `unavailable`, retried.
          callback(new ProjectSnapshotError(stage, 'unavailable', `transfer overran the declared ${expectedBytes} bytes`))
          return
        }
        hash.update(chunk)
        callback(null, chunk)
      },
    })

    await new Promise<void>((resolve, reject) => {
      let settled = false
      let current: Readable = first
      const fail = (err: unknown) => {
        if (settled) return
        settled = true
        if (watchdog) clearTimeout(watchdog)
        current.destroy()
        io.sink.destroy?.()
        if (err instanceof ProjectSnapshotError) return reject(err)
        if (isAbortError(err) || link.signal.aborted) {
          return reject(new ProjectSnapshotError(stage, abortReason(options, link.timedOut()), `transfer aborted: ${errorMessage(err)}`, 0, { cause: err }))
        }
        reject(new ProjectSnapshotError(stage, 'unavailable', `transfer failed: ${errorMessage(err)}`, 0, { cause: err }))
      }
      const done = () => {
        if (settled) return
        settled = true
        if (watchdog) clearTimeout(watchdog)
        resolve()
      }
      // A body that closed short (S3 does this at boot: `transfer closed after
      // 1572864 of 1573214 bytes`, 3 of 12 dev boots on 2026-09-18) keeps the
      // same presigned URL valid, so ask for the missing tail instead of
      // re-downloading the whole object on a fresh descriptor.
      const settleSource = async () => {
        if (settled) return
        if (delivered >= expectedBytes) {
          hasher.end()
          return
        }
        const short = new ProjectSnapshotError(stage, 'unavailable', `transfer closed after ${delivered} of ${expectedBytes} bytes`)
        if (resumes >= MAX_RESUMES) return fail(short)
        resumes += 1
        logger.warn('[project-snapshot] s3 transfer closed early; resuming with Range', {
          received: delivered,
          expected: expectedBytes,
          resume: resumes,
        })
        try {
          const next = await open(delivered)
          if (settled) return next?.destroy()
          if (!next) return fail(short)
          attach(next)
        } catch (err) {
          fail(err)
        }
      }
      const attach = (source: Readable) => {
        current = source
        let over = false
        // Bun can close a reset source without `end` or `error`; either way the
        // byte count, not the event, decides between "complete" and "resume".
        const finished = () => {
          if (over) return
          over = true
          source.unpipe(hasher)
          setImmediate(() => void settleSource())
        }
        source.on('data', (chunk: Buffer) => {
          delivered += chunk.length
        })
        source.on('error', fail)
        source.on('end', finished)
        source.on('close', finished)
        source.pipe(hasher, { end: false })
      }
      onInactivity = () => fail(new ProjectSnapshotError(stage, 'unavailable', `transfer stalled: no bytes for ${inactivityMs}ms`))
      armWatchdog()
      hasher.on('error', fail)
      io.sink.on('error', fail)
      io.sink.on('finish', done)
      link.signal.addEventListener('abort', () => fail(link.signal.reason), { once: true })
      if (io.tap) {
        const tap = io.tap
        tap.on('error', (err) => {
          io.onTapError?.(err)
          hasher.unpipe(tap)
        })
        hasher.pipe(tap)
      }
      hasher.pipe(io.sink)
      attach(first)
    })
    const finishedAt = Date.now()
    if (received < expectedBytes) {
      throw new ProjectSnapshotError(stage, 'unavailable', `transfer ended after ${received} of ${expectedBytes} bytes`)
    }
    const digest = hash.digest('hex')
    if (received !== expectedBytes || digest !== expected.sha256) {
      throw new ProjectSnapshotError(options.digestStage, 'digest-mismatch', `object digest/size mismatch: got ${digest}/${received}, expected ${expected.sha256}/${expectedBytes}`)
    }
    return {
      received,
      digest,
      firstByteMs: firstByteAt ? firstByteAt - started : finishedAt - started,
      totalMs: finishedAt - started,
    }
  } finally {
    link.dispose()
  }
}
