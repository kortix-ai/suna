/**
 * `/kortix/opencode/*` — the Kortix Runtime API, in-sandbox half.
 *
 * The product speaks Kortix contracts; OpenCode never crosses this boundary.
 * Five routes replace the fifteen proxied reads and four self-heal polls a
 * session open and its steady state pay for today (WS-V §1):
 *
 *   GET  /kortix/opencode/state                one projection for 7 reads
 *   GET  /kortix/opencode/messages/:sessionId  trimmed transcript, ids verbatim
 *   GET  /kortix/opencode/events?since=        ONE sequenced SSE stream
 *   POST /kortix/opencode/act                  permission | question | stop | revert
 *   GET  /kortix/opencode/turn/:messageId      the turn-outcome oracle
 *
 * ADDITIVE. Every `/p/<box>/8000/...` path OpenCode serves today still works.
 * `/kortix/health?turn=1` still answers. This namespace is a faster, smaller,
 * sequenced way to ask the same questions — nothing is taken away in this
 * change, so a client can move one surface at a time and roll back per surface.
 *
 * NAMESPACED BY THE MANAGED BINARY, not by a version. `/kortix/opencode/*` is
 * "the runtime OpenCode manages"; a future harness gets `/kortix/<harness>/*`.
 * If this contract ever needs versioning it prefixes the WHOLE path, so a
 * client never has to parse a version out of the middle of a URL.
 *
 * AUTH. Same posture as `/kortix/diag` and `/kortix/logs`: a service call
 * presents `Authorization: Bearer <KORTIX_TOKEN>`, a user call presents the
 * HMAC-signed `X-Kortix-User-Context` the API mints. The SSE route also accepts
 * the context in a query parameter, exactly as `/kortix/pty/connect` does —
 * `EventSource` cannot set a header, and the API's proxy forwards the query
 * string untouched.
 */
import { Hono, type Context } from 'hono'

import type { Config } from '../config'
import { logger } from '../logger'
import type { Opencode } from '../opencode'
import {
  KORTIX_USER_CONTEXT_HEADER,
  verifyKortixUserContext,
} from '../kortix-user-context'
import type { OpencodeDb } from '../opencode-db'
import { isSupportedOpencodeVersion } from '../opencode-db'
import { projectTranscript } from '../opencode-projection'
import type { RuntimeStateStore } from '../runtime-state-projection'
import { kortixEventBus, type KortixEvent } from '../kortix-event-bus'
import { etagMatches, notModified, timedJson } from '../kortix-http'
import { observeRequestedTurn, resolveTurnObservationIdentity } from './health'
import { readPinnedSessionId } from '../opencode-turn-state'

/** Matches OpenCode's own first-page size (`server-session.ts:30`). */
export const DEFAULT_MESSAGE_PAGE = 20
export const MAX_MESSAGE_PAGE = 200
/** Heartbeat cadence on `/events`. Three of these fit in a 60 s client budget. */
export const EVENT_HEARTBEAT_MS = 15_000
export const KORTIX_USER_CONTEXT_QUERY_PARAM = '__kortix_user_context'

export interface OpencodeRuntimeDeps {
  opencode: Opencode
  db: OpencodeDb
  state: RuntimeStateStore
  /**
   * The pinned OpenCode conversation. Injected rather than read from the pin
   * file inside the handler: `act` and `turn` both fall back to it, and a
   * route that reaches for `/home/kortix/.local/state` on its own cannot be
   * exercised anywhere but a real box.
   */
  pinnedSessionId?: () => string | null
  /** Overridable for tests. */
  now?: () => number
}

function bearerToken(header: string | undefined): string | null {
  if (!header?.startsWith('Bearer ')) return null
  return header.slice('Bearer '.length).trim() || null
}

type AuthOutcome = { ok: true } | { ok: false; response: Response }

function authorize(cfg: Config, c: Context): AuthOutcome {
  if (!cfg.sandboxToken) {
    return {
      ok: false,
      response: Response.json({ error: 'daemon not configured', detail: 'KORTIX_TOKEN unset' }, { status: 503 }),
    }
  }
  if (bearerToken(c.req.header('Authorization')) === cfg.sandboxToken) return { ok: true }
  const header = c.req.header(KORTIX_USER_CONTEXT_HEADER) ?? c.req.query(KORTIX_USER_CONTEXT_QUERY_PARAM)
  const auth = verifyKortixUserContext(header, cfg.sandboxToken)
  if (!auth.ok) {
    logger.warn('[kortix-runtime] reject', { reason: auth.reason })
    return { ok: false, response: Response.json({ error: 'unauthorized', reason: auth.reason }, { status: 401 }) }
  }
  return { ok: true }
}

function intParam(value: string | undefined, fallback: number, max: number): number {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.min(Math.floor(n), max)
}

export function createOpencodeRuntimeRouter(cfg: Config, deps: OpencodeRuntimeDeps): Hono {
  const app = new Hono()
  const now = deps.now ?? (() => Date.now())
  const pinnedSessionId = deps.pinnedSessionId ?? readPinnedSessionId
  const workspace = () => cfg.workspace || process.env.KORTIX_WORKSPACE || '/workspace'

  // -------------------------------------------------------------------------
  // GET /state
  // -------------------------------------------------------------------------
  app.get('/state', async (c) => {
    const auth = authorize(cfg, c)
    if (!auth.ok) return auth.response
    const t0 = performance.now()
    const { doc, etag, readMs } = await deps.state.read()
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

  // -------------------------------------------------------------------------
  // GET /messages/:sessionId
  // -------------------------------------------------------------------------
  //
  // Served from `opencode.db` read-only when the schema probes clean AND the
  // running OpenCode is a version this reader is verified against; from
  // OpenCode's HTTP otherwise. The fallback is not a nicety: it is what makes a
  // future OpenCode schema change a latency regression instead of an outage.
  app.get('/messages/:sessionId', async (c) => {
    const auth = authorize(cfg, c)
    if (!auth.ok) return auth.response
    const t0 = performance.now()
    const sessionId = c.req.param('sessionId')
    const limit = intParam(c.req.query('limit'), DEFAULT_MESSAGE_PAGE, MAX_MESSAGE_PAGE)
    const before = c.req.query('before')?.trim() || null
    const rawAfter = c.req.query('after')?.trim() || null
    const explicitAfterSeq = c.req.query('after_seq')?.trim() || null
    // `after` accepts either form, per the contract. An OpenCode message id is
    // `msg_…` and never numeric, so the discrimination is total.
    const afterSeq = explicitAfterSeq ?? (rawAfter && /^\d+$/.test(rawAfter) ? rawAfter : null)
    const after = afterSeq ? null : rawAfter

    const version = await deps.state.opencodeVersion()
    const probe = deps.db.probe()
    const useDb = probe.supported && isSupportedOpencodeVersion(version)

    let page: Awaited<ReturnType<OpencodeDb['messagePage']>> = null
    let source: 'sqlite' | 'opencode-http' = 'sqlite'
    const readStart = performance.now()
    if (useDb) {
      page = deps.db.messagePage({
        sessionId,
        limit,
        after,
        before,
        afterSeq: afterSeq ? Number(afterSeq) : null,
      })
    }
    if (!page) {
      source = 'opencode-http'
      const fallback = await readMessagesOverHttp(deps.opencode, workspace(), sessionId, {
        limit,
        before,
      })
      if (!fallback.ok) {
        return timedJson(
          {
            error: 'transcript unreadable',
            source,
            detail: fallback.detail,
            db: { supported: probe.supported, reason: probe.reason, version_supported: isSupportedOpencodeVersion(version) },
          },
          { status: 502, totalMs: performance.now() - t0, acceptEncoding: c.req.header('accept-encoding') },
        )
      }
      page = { messages: fallback.messages, dropped: 0, hasMore: fallback.messages.length >= limit }
    }
    const readMs = performance.now() - readStart

    const projected = projectTranscript(page.messages, sessionId)
    const first = projected.messages[0]?.info as { id?: string } | undefined
    const last = projected.messages[projected.messages.length - 1]?.info as { id?: string } | undefined
    const body = {
      session_id: sessionId,
      epoch: kortixEventBus().epoch,
      /** Stream cursor to resume from: everything in this page is already applied. */
      seq: kortixEventBus().headSeq,
      /** OpenCode's own durable cursor for this session, for `?after_seq=`. */
      head_seq: useDb ? deps.db.headSeq(sessionId) : null,
      source,
      count: projected.messages.length,
      has_more: page.hasMore,
      /** Page bounds, ids VERBATIM from OpenCode — a mirror can key on them. */
      first_message_id: first?.id ?? null,
      last_message_id: last?.id ?? null,
      dropped: page.dropped,
      attachments_referenced: projected.stripped,
      attachment_bytes_saved: projected.savedBytes,
      tool_outputs_truncated: projected.truncated,
      messages: projected.messages,
    }
    if (page.dropped > 0) {
      logger.warn('[kortix-runtime] dropped unparseable transcript rows', {
        sessionId,
        dropped: page.dropped,
      })
    }
    return timedJson(body, {
      readMs,
      totalMs: performance.now() - t0,
      acceptEncoding: c.req.header('accept-encoding'),
      headers: { 'X-Kortix-Transcript-Source': source },
    })
  })

  // -------------------------------------------------------------------------
  // GET /events?since=&epoch=  (SSE)
  // -------------------------------------------------------------------------
  //
  // Replay-then-live in ONE atomic step: `subscribe()` takes the ring snapshot
  // and attaches the listener in the same synchronous tick, so nothing can be
  // published between them. Live envelopes that arrive while the replay is
  // still being written are queued behind it and de-duplicated by seq.
  // ── Thin GET passthroughs for the last raw OpenCode reads ────────────────
  //
  // The web client speaks ONLY `/kortix/*` — no raw `/session`, `/vcs/diff`,
  // `/project/current`, `/config` on the wire. These reads are lazy or
  // user-triggered and are NOT in the state projection, so they cannot be
  // seeded from the bundle; the daemon forwards them to the LOCAL OpenCode over
  // the internal URL and returns the shape verbatim. Same auth + directory
  // scoping as every other daemon read. Kept as thin as `act`'s forwarder.
  const forwardOpencodeGet = async (
    c: Context,
    opencodePath: string,
    extraQuery = '',
  ): Promise<Response> => {
    const auth = authorize(cfg, c)
    if (!auth.ok) return auth.response
    const base = deps.opencode.getInternalUrl()
    const qs = [`directory=${encodeURIComponent(workspace())}`, extraQuery]
      .filter(Boolean)
      .join('&')
    try {
      const res = await fetch(`${base}${opencodePath}?${qs}`, {
        signal: AbortSignal.timeout(15_000),
      })
      const bodyText = await res.text()
      return new Response(bodyText, {
        status: res.status,
        headers: { 'content-type': res.headers.get('content-type') ?? 'application/json' },
      })
    } catch (err) {
      return Response.json(
        {
          error: 'opencode read failed',
          detail: err instanceof Error ? err.message : String(err),
        },
        { status: 502 },
      )
    }
  }

  app.get('/vcs-diff', (c) => {
    const mode = c.req.query('mode')
    return forwardOpencodeGet(c, '/vcs/diff', mode ? `mode=${encodeURIComponent(mode)}` : '')
  })
  app.get('/project-current', (c) => forwardOpencodeGet(c, '/project/current'))
  app.get('/config', (c) => forwardOpencodeGet(c, '/config'))
  app.get('/session/:sessionId', (c) =>
    forwardOpencodeGet(c, `/session/${encodeURIComponent(c.req.param('sessionId'))}`),
  )
  app.get('/todo/:sessionId', (c) =>
    forwardOpencodeGet(c, `/session/${encodeURIComponent(c.req.param('sessionId'))}/todo`),
  )

  app.get('/events', (c) => {
    const auth = authorize(cfg, c)
    if (!auth.ok) return auth.response
    const bus = kortixEventBus()
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

  // -------------------------------------------------------------------------
  // POST /act
  // -------------------------------------------------------------------------
  app.post('/act', async (c) => {
    const auth = authorize(cfg, c)
    if (!auth.ok) return auth.response
    const t0 = performance.now()
    let body: Record<string, unknown>
    try {
      body = (await c.req.json()) as Record<string, unknown>
    } catch {
      return timedJson({ ok: false, error: 'invalid json body' }, { status: 400, totalMs: performance.now() - t0 })
    }
    const kind = typeof body.kind === 'string' ? body.kind : null
    const pinned = pinnedSessionId()
    const sessionId = typeof body.session_id === 'string' && body.session_id ? body.session_id : pinned
    const url = deps.opencode.getInternalUrl()
    const dir = `directory=${encodeURIComponent(workspace())}`

    const forward = async (
      path: string,
      payload: unknown,
    ): Promise<Response> => {
      try {
        const res = await fetch(`${url}${path}${path.includes('?') ? '&' : '?'}${dir}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload ?? {}),
          signal: AbortSignal.timeout(15_000),
        })
        const text = await res.text()
        if (!res.ok) {
          logger.warn('[kortix-runtime] act forward failed', { kind, path, status: res.status })
          return timedJson(
            { ok: false, kind, error: `opencode ${res.status}`, detail: text.slice(0, 300) },
            { status: res.status === 404 ? 404 : 502, totalMs: performance.now() - t0 },
          )
        }
        return timedJson(
          { ok: true, kind, session_id: sessionId, seq: kortixEventBus().headSeq },
          { totalMs: performance.now() - t0 },
        )
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        logger.warn('[kortix-runtime] act threw', { kind, path, error: message })
        return timedJson({ ok: false, kind, error: message }, { status: 502, totalMs: performance.now() - t0 })
      }
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
        return forward(`/permission/${encodeURIComponent(id)}/reply`, {
          reply,
          ...(typeof body.message === 'string' ? { message: body.message } : {}),
        })
      }
      case 'question': {
        const id = typeof body.id === 'string' ? body.id : null
        if (!id) {
          return timedJson({ ok: false, error: 'question act needs { id }' }, { status: 400, totalMs: performance.now() - t0 })
        }
        if (body.reject === true) return forward(`/question/${encodeURIComponent(id)}/reject`, {})
        if (!Array.isArray(body.answers)) {
          return timedJson(
            { ok: false, error: 'question act needs { id, answers: string[][] } or { id, reject: true }' },
            { status: 400, totalMs: performance.now() - t0 },
          )
        }
        return forward(`/question/${encodeURIComponent(id)}/reply`, { answers: body.answers })
      }
      case 'stop': {
        if (!sessionId) {
          return timedJson({ ok: false, error: 'no opencode session pinned' }, { status: 409, totalMs: performance.now() - t0 })
        }
        return forward(`/session/${encodeURIComponent(sessionId)}/abort`, {})
      }
      case 'revert': {
        if (!sessionId) {
          return timedJson({ ok: false, error: 'no opencode session pinned' }, { status: 409, totalMs: performance.now() - t0 })
        }
        // `{}` with no messageID is UNREVERT — the product's "undo the undo".
        if (body.undo === true) return forward(`/session/${encodeURIComponent(sessionId)}/unrevert`, {})
        const messageID = typeof body.message_id === 'string' ? body.message_id : null
        if (!messageID) {
          return timedJson(
            { ok: false, error: 'revert act needs { message_id } or { undo: true }' },
            { status: 400, totalMs: performance.now() - t0 },
          )
        }
        return forward(`/session/${encodeURIComponent(sessionId)}/revert`, {
          messageID,
          ...(typeof body.part_id === 'string' ? { partID: body.part_id } : {}),
        })
      }
      default:
        return timedJson(
          { ok: false, error: `unsupported act kind: ${kind ?? '<missing>'}`, supported: ['permission', 'question', 'stop', 'revert'] },
          { status: 400, totalMs: performance.now() - t0 },
        )
    }
  })

  // -------------------------------------------------------------------------
  // GET /turn/:messageId
  // -------------------------------------------------------------------------
  //
  // The turn-outcome oracle, relocated off `/kortix/health?turn=1`. It is the
  // SAME observer — `observeRequestedTurn` — so the two answers can never
  // disagree; the health bolt-on keeps working for older callers and is the
  // one this eventually retires.
  app.get('/turn/:messageId', async (c) => {
    const auth = authorize(cfg, c)
    if (!auth.ok) return auth.response
    const t0 = performance.now()
    const messageId = c.req.param('messageId')
    const identity = resolveTurnObservationIdentity(
      c.req.query('session_id')?.trim(),
      messageId,
      pinnedSessionId(),
    )
    const readStart = performance.now()
    const turn = await observeRequestedTurn(deps.opencode.getInternalUrl(), workspace(), identity)
    return timedJson(
      {
        message_id: messageId,
        opencode_session_id: identity.sessionId,
        // `null` is a real answer, not a gap: the transcript proves the turn is
        // over but does not say what ended it. Only provable values are named.
        in_flight: turn.inFlight,
        end: turn.end,
        orphaned_prompt: turn.orphanedPrompt ?? false,
        seq: kortixEventBus().headSeq,
      },
      {
        readMs: performance.now() - readStart,
        totalMs: performance.now() - t0,
        acceptEncoding: c.req.header('accept-encoding'),
      },
    )
  })

  return app
}

/**
 * The HTTP fallback for `/messages`. Only reached when the SQLite shape does
 * not probe clean or the OpenCode version is outside the verified set.
 */
async function readMessagesOverHttp(
  opencode: Opencode,
  workspace: string,
  sessionId: string,
  options: { limit: number; before: string | null },
): Promise<
  | { ok: true; messages: Array<{ info: Record<string, unknown>; parts: Array<Record<string, unknown>> }> }
  | { ok: false; detail: string }
> {
  const params = new URLSearchParams({ directory: workspace, limit: String(options.limit) })
  if (options.before) params.set('before', options.before)
  const url = `${opencode.getInternalUrl()}/session/${encodeURIComponent(sessionId)}/message?${params.toString()}`
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(20_000) })
    if (!res.ok) return { ok: false, detail: `opencode ${res.status}` }
    const body = (await res.json()) as unknown
    if (!Array.isArray(body)) return { ok: false, detail: 'unexpected message list shape' }
    const messages = body
      .filter((entry): entry is { info: Record<string, unknown>; parts?: unknown } =>
        Boolean(entry && typeof entry === 'object' && (entry as { info?: unknown }).info),
      )
      .map((entry) => ({
        info: entry.info,
        parts: Array.isArray(entry.parts) ? (entry.parts as Array<Record<string, unknown>>) : [],
      }))
    return { ok: true, messages }
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) }
  }
}
