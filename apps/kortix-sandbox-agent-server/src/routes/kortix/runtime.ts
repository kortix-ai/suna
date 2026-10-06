/** HTTP controllers for the existing runtime API; the selected harness owns operations. */
import { Hono, type Context } from 'hono'
import { RUNTIME_NOT_READY_CODE } from '@kortix/api-contract/runtime-relay'
import type { Config } from '@/lib/config/config'
import { logger } from '@/lib/log/logger'
import { KORTIX_SERVICE_CALL_HEADER, KORTIX_USER_CONTEXT_HEADER, verifyKortixUserContext } from '@/lib/kortix-api/kortix-user-context'
import type { KortixEvent } from '@/services/event-bus/kortix-event-bus'
import { etagMatches, notModified, timedJson } from './kortix-http'
import type { HarnessQueryService } from '@/harness/contract/queries'
import type { HarnessReadiness } from '@/harness/contract/proxy'
import type { HarnessTurnService, RuntimePromptInput } from '@/harness/contract/turns'

/** Existing transcript page-size contract. */
export const DEFAULT_MESSAGE_PAGE = 20
export const MAX_MESSAGE_PAGE = 200
/** Heartbeat cadence on `/events`. Three of these fit in a 60 s client budget. */
const EVENT_HEARTBEAT_MS = 15_000
/**
 * Frames one `/events` reader may leave unread before the stream ends. The API
 * pauses its read while its own client is slow; past this the reader has
 * stopped, and the ring (not this queue) holds what it missed.
 */
const EVENT_STREAM_MAX_QUEUED = 4_096
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

const optionalString = (value: unknown): value is string | undefined => value === undefined || typeof value === 'string'

/**
 * Validate a `POST /sessions/:id/prompt` body:
 * `{ message_id?, parts, agent?, model?: "provider/model", variant?, directory?, no_reply? }`.
 */
export function parseRuntimePromptBody(raw: unknown): RuntimePromptInput | string {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 'body must be a JSON object'
  const body = raw as Record<string, unknown>
  if (!Array.isArray(body.parts) || body.parts.length === 0) return 'parts must be a non-empty array'
  if (body.parts.some((part) => !part || typeof part !== 'object' || Array.isArray(part))) return 'parts must be objects'
  for (const key of ['message_id', 'agent', 'model', 'variant', 'directory'] as const) {
    if (!optionalString(body[key])) return `${key} must be a string`
  }
  if (body.no_reply !== undefined && typeof body.no_reply !== 'boolean') return 'no_reply must be a boolean'
  let model: RuntimePromptInput['model']
  if (typeof body.model === 'string') {
    const slash = body.model.indexOf('/')
    if (slash <= 0 || slash === body.model.length - 1) return 'model must be "provider/model"'
    model = { providerID: body.model.slice(0, slash), modelID: body.model.slice(slash + 1) }
  }
  const text = (key: string) => (typeof body[key] === 'string' && (body[key] as string).trim() ? (body[key] as string).trim() : undefined)
  return {
    parts: body.parts as Array<Record<string, unknown>>,
    ...(text('message_id') ? { messageId: text('message_id') } : {}),
    ...(text('agent') ? { agent: text('agent') } : {}),
    ...(model ? { model } : {}),
    ...(text('variant') ? { variant: text('variant') } : {}),
    ...(text('directory') ? { directory: text('directory') } : {}),
    ...(body.no_reply === true ? { noReply: true } : {}),
  }
}

function intParam(value: string | undefined, fallback: number, max: number): number {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.min(Math.floor(n), max)
}

export function createRuntimeRouter(
  cfg: Config,
  queries: HarnessQueryService,
  options: {
    now?: () => number
    turns?: HarnessTurnService
    /** The runtime gate the compatibility proxy runs before every request. */
    readiness?: () => Promise<HarnessReadiness>
  } = {},
): Hono {
  const app = new Hono()
  const now = options.now ?? (() => Date.now())
  const turns = options.turns

  if (turns) {
    // The same gate and upstream failure as the compatibility proxy these
    // verbs replace: 503 with the boot phase while the runtime cannot take a
    // request, 502 when it cannot be reached (the API retries both).
    const answer = async (c: Context, verb: () => Promise<{ status: number; body: unknown }>) => {
      // Marks the answer as the verb's own: a 404 without it is a daemon that
      // lacks the route, and apps/api resends on the legacy route.
      c.header('X-Kortix-Turn-Verb', '1')
      const readiness = await options.readiness?.()
      if (readiness && !readiness.ready) {
        c.header('X-Kortix-Boot-Phase', readiness.phase)
        return c.json({ code: RUNTIME_NOT_READY_CODE, ...readiness.details, phase: readiness.phase }, 503)
      }
      try {
        const result = await verb()
        return c.json(result.body as Record<string, unknown>, result.status as 200)
      } catch (err) {
        return c.json({ error: 'upstream unreachable', details: (err as Error).message }, 502)
      }
    }

    app.post('/sessions/:sessionId/prompt', async (c) => {
      const auth = authorize(cfg, c)
      if (!auth.ok) return auth.response
      const raw = await c.req.json().catch(() => undefined)
      const input = parseRuntimePromptBody(raw)
      if (typeof input === 'string') return c.json({ error: input }, 400)
      return answer(c, () => turns.prompt(c.req.param('sessionId'), input))
    })

    // The `/prompt` body; the running turn reads it at its next step boundary.
    app.post('/sessions/:sessionId/steer', async (c) => {
      const auth = authorize(cfg, c)
      if (!auth.ok) return auth.response
      // Only apps/api may steer: its admission is where the turn's prompter
      // is checked (D9.3). The user-facing proxy authenticates every relayed
      // request with this same bearer but strips the service-call mark, so the
      // mark proves a direct platform call and the bearer proves the caller.
      if (bearerToken(c.req.header('Authorization')) !== cfg.sandboxToken || c.req.header(KORTIX_SERVICE_CALL_HEADER) !== '1') {
        logger.warn('[kortix-runtime] rejected steer from a non-service caller')
        return c.json({ error: 'steer requires the sandbox service credential', code: 'STEER_SERVICE_ONLY' }, 403)
      }
      const raw = await c.req.json().catch(() => undefined)
      const input = parseRuntimePromptBody(raw)
      if (typeof input === 'string') return c.json({ error: input }, 400)
      if (!input.messageId) return c.json({ error: 'message_id is required' }, 400)
      return answer(c, () => turns.steer(c.req.param('sessionId'), input))
    })

    app.post('/sessions/:sessionId/abort', async (c) => {
      const auth = authorize(cfg, c)
      if (!auth.ok) return auth.response
      return answer(c, () => turns.abort(c.req.param('sessionId')))
    })

    app.get('/messages/:sessionId/:messageId', async (c) => {
      const auth = authorize(cfg, c)
      if (!auth.ok) return auth.response
      return answer(c, () => turns.readMessage(c.req.param('sessionId'), c.req.param('messageId')))
    })

    app.delete('/messages/:sessionId/:messageId', async (c) => {
      const auth = authorize(cfg, c)
      if (!auth.ok) return auth.response
      return answer(c, () => turns.removeMessage(c.req.param('sessionId'), c.req.param('messageId')))
    })

    app.get('/agents', async (c) => {
      const auth = authorize(cfg, c)
      if (!auth.ok) return auth.response
      return answer(c, () => turns.agents(c.req.query('directory')?.trim() || null))
    })
  }

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
            if ((controller.desiredSize ?? 0) < -EVENT_STREAM_MAX_QUEUED) {
              // The reader stopped reading. End the stream so this queue stays
              // bounded; it reconnects with its cursor and the ring replays.
              closed = true
              if (heartbeat) clearInterval(heartbeat)
              heartbeat = null
              unsubscribe?.()
              unsubscribe = null
              controller.close()
            }
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

  return app
}
