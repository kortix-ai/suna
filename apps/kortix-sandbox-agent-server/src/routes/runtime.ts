/** HTTP controllers for the existing runtime API; the selected harness owns operations. */
import { Hono, type Context } from 'hono'
import type { Config } from '../config'
import { logger } from '../logger'
import { KORTIX_USER_CONTEXT_HEADER, verifyKortixUserContext } from '../kortix-user-context'
import type { KortixEvent } from '../kortix-event-bus'
import { etagMatches, notModified, timedJson } from '../kortix-http'
import type { HarnessActionResult, HarnessQueryService, HarnessReadResult } from '../harness/queries'

/** Existing transcript page-size contract. */
export const DEFAULT_MESSAGE_PAGE = 20
export const MAX_MESSAGE_PAGE = 200
/** Heartbeat cadence on `/events`. Three of these fit in a 60 s client budget. */
export const EVENT_HEARTBEAT_MS = 15_000
export const KORTIX_USER_CONTEXT_QUERY_PARAM = '__kortix_user_context'

function bearerToken(header: string | undefined): string | null {
  if (!header?.startsWith('Bearer ')) return null
  return header.slice('Bearer '.length).trim() || null
}

type AuthOutcome = { ok: true } | { ok: false; response: Response }

function authorize(cfg: Config, c: Context): AuthOutcome {
  if (!cfg.sandboxToken) {
    return {
      ok: false,
      response: Response.json(
        { error: 'daemon not configured', detail: 'KORTIX_TOKEN unset' },
        { status: 503 },
      ),
    }
  }
  if (bearerToken(c.req.header('Authorization')) === cfg.sandboxToken) return { ok: true }
  const header = c.req.header(KORTIX_USER_CONTEXT_HEADER) ?? c.req.query(KORTIX_USER_CONTEXT_QUERY_PARAM)
  const auth = verifyKortixUserContext(header, cfg.sandboxToken)
  if (!auth.ok) {
    logger.warn('[kortix-runtime] reject', { reason: auth.reason })
    return {
      ok: false,
      response: Response.json({ error: 'unauthorized', reason: auth.reason }, { status: 401 }),
    }
  }
  return { ok: true }
}

function intParam(value: string | undefined, fallback: number, max: number): number {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.min(Math.floor(n), max)
}

export function createRuntimeRouter(
  cfg: Config,
  queries: HarnessQueryService,
  options: { now?: () => number } = {},
): Hono {
  const app = new Hono()
  const now = options.now ?? (() => Date.now())

  app.get('/state', async (c) => {
    const auth = authorize(cfg, c)
    if (!auth.ok) return auth.response
    const t0 = performance.now()
    const { doc, etag, readMs } = await queries.readState()
    if (etagMatches(c.req.header('if-none-match'), etag)) {
      return notModified(etag, performance.now() - t0)
    }
    return timedJson(doc, {
      etag,
      readMs,
      totalMs: performance.now() - t0,
      acceptEncoding: c.req.header('accept-encoding'),
    })
  })

  app.get('/messages/:sessionId', async (c) => {
    const auth = authorize(cfg, c)
    if (!auth.ok) return auth.response
    const t0 = performance.now()
    const sessionId = c.req.param('sessionId')
    const limit = intParam(c.req.query('limit'), DEFAULT_MESSAGE_PAGE, MAX_MESSAGE_PAGE)
    const before = c.req.query('before')?.trim() || null
    const rawAfter = c.req.query('after')?.trim() || null
    const explicitAfterSeq = c.req.query('after_seq')?.trim() || null
    // `after` accepts either form, per the contract. A message id is
    // `msg_…` and never numeric, so the discrimination is total.
    const afterSeq = explicitAfterSeq ?? (rawAfter && /^\d+$/.test(rawAfter) ? rawAfter : null)
    const after = afterSeq ? null : rawAfter

    const result = await queries.readMessages({
      sessionId,
      limit,
      before,
      after,
      afterSeq: afterSeq ? Number(afterSeq) : null,
    })
    if (!result.ok) {
      return timedJson(result.body, {
        status: 502,
        totalMs: performance.now() - t0,
        acceptEncoding: c.req.header('accept-encoding'),
      })
    }
    return timedJson(result.body, {
      readMs: result.readMs,
      totalMs: performance.now() - t0,
      acceptEncoding: c.req.header('accept-encoding'),
      headers: { 'X-Kortix-Transcript-Source': result.source },
    })
  })

  // Existing compatibility reads preserve their native response payloads.
  const read = async (c: Context, operation: () => Promise<HarnessReadResult>): Promise<Response> => {
    const auth = authorize(cfg, c)
    if (!auth.ok) return auth.response
    const result = await operation()
    if (!result.ok) return Response.json(result.body, { status: 502 })
    return new Response(result.text, {
      status: result.upstreamStatus,
      headers: { 'content-type': result.contentType },
    })
  }
  app.get('/vcs-diff', (c) => read(c, () => queries.readVcsDiff(c.req.query('mode'))))
  app.get('/project-current', (c) => read(c, () => queries.readCurrentProject()))
  app.get('/config', (c) => read(c, () => queries.readConfiguration()))
  app.get('/session/:sessionId', (c) => read(c, () => queries.readSession(c.req.param('sessionId'))))
  app.get('/todo/:sessionId', (c) => read(c, () => queries.readTodo(c.req.param('sessionId'))))

  app.get('/events', (c) => {
    const auth = authorize(cfg, c)
    if (!auth.ok) return auth.response
    const bus = queries.events
    const sinceRaw = c.req.query('since')
    const since = sinceRaw !== undefined && /^\d+$/.test(sinceRaw) ? Number(sinceRaw) : null
    const epoch = c.req.query('epoch')?.trim() || null

    const encoder = new TextEncoder()
    let heartbeat: ReturnType<typeof setInterval> | null = null
    let unsubscribe: (() => void) | null = null

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        let closed = false
        let replaying = true
        let lastSent = -1
        const pending: KortixEvent[] = []

        const write = (payload: string) => {
          if (closed) return
          try {
            controller.enqueue(encoder.encode(payload))
          } catch {
            closed = true
          }
        }
        const send = (event: KortixEvent) => {
          if (event.seq <= lastSent) return
          lastSent = event.seq
          write(`event: ${event.type}\nid: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`)
        }

        const subscription = bus.subscribe(
          (event) => {
            if (replaying) pending.push(event)
            else send(event)
          },
          { since, epoch },
        )
        unsubscribe = subscription.unsubscribe

        // `kortix.hello` opens every stream: it names the epoch and the exact
        // cursor the client now holds, so a reconnect never has to guess.
        write(
          `event: kortix.hello\ndata: ${JSON.stringify({
            type: 'kortix.hello',
            epoch: bus.epoch,
            head_seq: bus.headSeq,
            first_seq: bus.firstSeq,
            since,
            at: now(),
          })}\n\n`,
        )
        if (subscription.resync) {
          write(
            `event: kortix.resync\ndata: ${JSON.stringify({ type: 'kortix.resync', ...subscription.resync })}\n\n`,
          )
          lastSent = bus.headSeq
        }
        for (const event of subscription.replay) send(event)
        replaying = false
        for (const event of pending) send(event)
        pending.length = 0

        // A TYPED heartbeat, not a `:` comment. SSE parsers swallow comments
        // without yielding anything, so a comment keeps TCP warm while leaving
        // every consumer's liveness watchdog blind — the exact defect
        // `sse-keepalive.ts` documents from the 2026-08-26 prod incident. It
        // carries NO seq: it is not part of the sequenced log, and burning
        // numbers on it would make a gap check lie.
        heartbeat = setInterval(() => {
          write(
            `event: kortix.heartbeat\ndata: ${JSON.stringify({
              type: 'kortix.heartbeat',
              at: now(),
              head_seq: bus.headSeq,
            })}\n\n`,
          )
        }, EVENT_HEARTBEAT_MS)
      },
      cancel() {
        if (heartbeat) clearInterval(heartbeat)
        heartbeat = null
        unsubscribe?.()
        unsubscribe = null
      },
    })

    return new Response(stream, {
      status: 200,
      headers: {
        // NOT gzipped, ever: a gzip stream buffers, and a buffered event
        // stream is a broken event stream.
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
        'X-Kortix-Epoch': bus.epoch,
      },
    })
  })

  app.post('/act', async (c) => {
    const auth = authorize(cfg, c)
    if (!auth.ok) return auth.response
    const t0 = performance.now()
    let body: Record<string, unknown>
    try {
      body = (await c.req.json()) as Record<string, unknown>
    } catch {
      return timedJson(
        { ok: false, error: 'invalid json body' },
        { status: 400, totalMs: performance.now() - t0 },
      )
    }
    const kind = typeof body.kind === 'string' ? body.kind : null
    const pinned = queries.pinnedSessionId()
    const sessionId = typeof body.session_id === 'string' && body.session_id ? body.session_id : pinned
    const execute = async (operation: Promise<HarnessActionResult>): Promise<Response> => {
      const result = await operation
      const status = result.ok
        ? 200
        : result.reason === 'no-session'
          ? 409
          : result.reason === 'not-found'
            ? 404
            : 502
      return timedJson(result.body, { status, totalMs: performance.now() - t0 })
    }

    switch (kind) {
      case 'permission': {
        const id = typeof body.id === 'string' ? body.id : null
        const reply = typeof body.reply === 'string' ? body.reply : null
        if (!id || !reply || !['once', 'always', 'reject'].includes(reply)) {
          return timedJson(
            { ok: false, error: 'permission act needs { id, reply: once|always|reject }' },
            { status: 400, totalMs: performance.now() - t0 },
          )
        }
        return execute(
          queries.replyPermission({
            id,
            reply: reply as 'once' | 'always' | 'reject',
            sessionId,
            ...(typeof body.message === 'string' ? { message: body.message } : {}),
          }),
        )
      }
      case 'question': {
        const id = typeof body.id === 'string' ? body.id : null
        if (!id) {
          return timedJson(
            { ok: false, error: 'question act needs { id }' },
            { status: 400, totalMs: performance.now() - t0 },
          )
        }
        if (body.reject === true) return execute(queries.rejectQuestion({ id, sessionId }))
        if (!Array.isArray(body.answers)) {
          return timedJson(
            { ok: false, error: 'question act needs { id, answers: string[][] } or { id, reject: true }' },
            { status: 400, totalMs: performance.now() - t0 },
          )
        }
        return execute(queries.replyQuestion({ id, sessionId, answers: body.answers }))
      }
      case 'stop': {
        return execute(queries.stopSession(sessionId))
      }
      case 'revert': {
        // Missing native session takes precedence over revert-body validation.
        if (!sessionId || body.undo === true) return execute(queries.unrevertSession(sessionId))
        const messageID = typeof body.message_id === 'string' ? body.message_id : null
        if (!messageID) {
          return timedJson(
            { ok: false, error: 'revert act needs { message_id } or { undo: true }' },
            { status: 400, totalMs: performance.now() - t0 },
          )
        }
        return execute(
          queries.revertSession({
            sessionId,
            messageId: messageID,
            ...(typeof body.part_id === 'string' ? { partId: body.part_id } : {}),
          }),
        )
      }
      default:
        return timedJson(
          {
            ok: false,
            error: `unsupported act kind: ${kind ?? '<missing>'}`,
            supported: ['permission', 'question', 'stop', 'revert'],
          },
          { status: 400, totalMs: performance.now() - t0 },
        )
    }
  })

  app.get('/turn/:messageId', async (c) => {
    const auth = authorize(cfg, c)
    if (!auth.ok) return auth.response
    const t0 = performance.now()
    const result = await queries.observeTurn({
      messageId: c.req.param('messageId'),
      sessionId: c.req.query('session_id')?.trim(),
    })
    return timedJson(result.body, {
      readMs: result.readMs,
      totalMs: performance.now() - t0,
      acceptEncoding: c.req.header('accept-encoding'),
    })
  })
  return app
}
