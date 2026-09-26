/**
 * pi's OpenCode-compatible raw surface, served IN-PROCESS behind the host's
 * catch-all transport (`routes/runtime-proxy.ts` → `HarnessProxyService`).
 *
 * The SDK's OpenCode client points at `<backend>/p/<externalId>/8000` and
 * calls `/session`, `/session/:id/message`, `/session/:id/prompt_async`,
 * `/session/:id/abort`, `/config`, `/agent`, `/provider`, `/permission/:id/reply`
 * and friends unchanged. The API delivers every turn with `prompt_async` and
 * proves it landed with `GET /session/:id/message/:messageID`. This module
 * answers those routes from the runtime's own state; nothing is forwarded.
 *
 * Auth is the host's: the daemon verifies the signed user context before this
 * catch-all runs, so the surface never sees an unauthenticated request.
 */
import { kortixEventBus } from '../../kortix-event-bus'
import { stripInlineAttachmentBytes } from '../../inline-attachments'
import type { HarnessForwardInput, HarnessForwardResult } from '../proxy'
import { PromptRejected, parsePromptBody, type PiRuntime } from './runtime'

const json = (status: number, body: unknown, headers: Record<string, string> = {}): HarnessForwardResult => ({
  status,
  statusText: status === 200 ? 'OK' : status === 204 ? 'No Content' : '',
  headers: new Headers({ 'content-type': 'application/json; charset=utf-8', ...headers }),
  body: status === 204 ? null : JSON.stringify(body),
})

const notFound = (path: string) => json(404, { error: `no pi handler for ${path}` })

function decodeSegment(value: string): string | null {
  try {
    return decodeURIComponent(value)
  } catch {
    return null
  }
}

async function readJsonBody(body: HarnessForwardInput['body']): Promise<unknown> {
  const text = body ? await new Response(body).text() : ''
  if (!text.trim()) return {}
  return JSON.parse(text) as unknown
}

/** `/kortix/part/<session>/<message>/<part>` for attachment bytes taken out of a list. */
function partRef(sessionId: string) {
  return (messageId: string, partId: string) =>
    `/kortix/part/${encodeURIComponent(sessionId)}/${encodeURIComponent(messageId)}/${encodeURIComponent(partId)}`
}

/** OpenCode's own `/event` framing: one `data:` line per `{type, properties}`. */
function eventStream(): HarnessForwardResult {
  const bus = kortixEventBus()
  const encoder = new TextEncoder()
  let unsubscribe: (() => void) | null = null
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false
      const write = (payload: string) => {
        if (closed) return
        try {
          controller.enqueue(encoder.encode(payload))
        } catch {
          closed = true
        }
      }
      write(`data: ${JSON.stringify({ type: 'server.connected', properties: {} })}\n\n`)
      const subscription = bus.subscribe((event) => {
        if (event.type.startsWith('kortix.')) return
        /*
          THE ENVELOPE NEEDS ITS OWN ID, AND STREAMED TEXT DEPENDS ON IT.

          OpenCode's wire carries a top-level `id` on every event, and the SDK
          store uses it as the idempotency key for `message.part.delta`
          (`applyPartDelta`'s `eventID`). Its rule, verbatim: "a delta with no
          id gets no protection here". The store cannot dedupe on delta CONTENT
          — text that legitimately repeats, like "..." streamed one character
          at a time, would false-positive — so identity is the only key it has.

          This frame shipped as `{type, properties}`, so every pi delta arrived
          unprotected. A redelivery then APPENDED the same text again: a
          reconnect that stacks a second live connection, or a second mounted
          subscriber, replays a tail of the stream, and the assistant's reply
          rendered twice inside one message — the second copy streaming in
          after the first had finished.

          `seq` is dense and monotonic within an epoch, and a redelivery of one
          event carries the same seq, which is exactly what a dedupe key must
          do. The epoch is prefixed because seq restarts at 0 when the daemon
          does, and an id that repeats across a restart is a key that silently
          drops a legitimate delta.
        */
        write(
          `data: ${JSON.stringify({
            id: `${bus.epoch}:${event.seq}`,
            type: event.type,
            properties: event.payload,
          })}\n\n`,
        )
      })
      unsubscribe = subscription.unsubscribe
    },
    cancel() {
      unsubscribe?.()
      unsubscribe = null
    },
  })
  return {
    status: 200,
    statusText: 'OK',
    headers: new Headers({ 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' }),
    body: stream,
  }
}

export interface PiSurface {
  handle(input: HarnessForwardInput): Promise<HarnessForwardResult>
}

export function createPiSurface(runtime: () => PiRuntime | null): PiSurface {
  return {
    async handle(input) {
      const rt = runtime()
      if (!rt) return json(503, { error: 'pi runtime is not started' })
      const method = input.method.toUpperCase()
      const path = input.path.replace(/\/+$/, '') || '/'
      const search = new URLSearchParams(input.search)
      const root = rt.rootId

      // ── streams ──────────────────────────────────────────────────────────
      if (method === 'GET' && (path === '/event' || path === '/global/event')) return eventStream()
      if (method === 'GET' && path === '/global/health') return json(200, { healthy: true, version: rt.sessionObject().version })

      // ── session ──────────────────────────────────────────────────────────
      if (path === '/session' && method === 'GET') return json(200, [rt.sessionObject()])
      if (path === '/session' && method === 'POST') return json(200, rt.sessionObject())
      if (path === '/session/status' && method === 'GET') {
        const status = rt.sessionStatus()
        return json(200, status.type === 'idle' ? {} : { [root]: status })
      }

      const session = /^\/session\/([^/]+)(?:\/(.*))?$/.exec(path)
      if (session) {
        const sessionId = decodeSegment(session[1]!)
        if (sessionId === null) return json(400, { error: 'path contains malformed percent-encoding' })
        if (sessionId !== root) return json(404, { error: 'unknown session' })
        const sub = session[2] ?? ''

        if (sub === '' && method === 'GET') return json(200, rt.sessionObject())
        if (sub === '' && method === 'PATCH') return json(200, rt.sessionObject())
        if (sub === '' && method === 'DELETE') return json(200, true)

        if ((sub === 'prompt_async' || sub === 'message') && method === 'POST') {
          let prompt
          try {
            prompt = parsePromptBody(await readJsonBody(input.body))
          } catch (err) {
            return json(400, { error: err instanceof Error ? err.message : String(err) })
          }
          let admitted: ReturnType<PiRuntime['admit']>
          try {
            admitted = rt.admit(prompt)
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err)
            return json(err instanceof PromptRejected ? (message.includes('already admitted') ? 200 : 503) : 500, {
              ...(message.includes('already admitted') ? { deduplicated: true } : { error: message }),
            })
          }
          if (sub === 'prompt_async') {
            // Accepted; execution continues on the serial queue and every byte
            // of output arrives over the event stream — exactly OpenCode's contract.
            void admitted.done.catch(() => {})
            return json(204, null)
          }
          await admitted.done
          const reply = rt.transcript.all().filter((m) => m.info.role === 'assistant' && m.info.parentID === admitted.messageId).at(-1)
          return json(200, reply ?? { info: { id: admitted.messageId, role: 'user', sessionID: root }, parts: [] })
        }

        if (sub === 'abort' && method === 'POST') {
          await rt.abort()
          return json(200, true)
        }
        if (sub === 'todo' && method === 'GET') return json(200, [])
        if (sub === 'children' && method === 'GET') return json(200, [])
        if (sub === 'diff' && method === 'GET') return json(200, [])
        if ((sub === 'revert' || sub === 'unrevert') && method === 'POST') {
          return json(501, { code: 'feature_not_supported', error: 'session rewind is not supported by the pi harness' })
        }
        if ((sub === 'command' || sub === 'summarize' || sub === 'init' || sub === 'fork' || sub === 'share' || sub === 'shell') && method === 'POST') {
          return json(501, { code: 'feature_not_supported', error: `${sub} is not supported by the pi harness` })
        }

        const message = /^message(?:\/([^/]+)(?:\/part\/([^/]+))?)?$/.exec(sub)
        if (message) {
          const messageId = message[1] ? decodeSegment(message[1]) : null
          const partId = message[2] ? decodeSegment(message[2]) : null
          if ((message[1] && messageId === null) || (message[2] && partId === null)) {
            return json(400, { error: 'path contains malformed percent-encoding' })
          }
          if (method === 'GET' && !messageId) {
            const limitRaw = Number(search.get('limit') ?? 0)
            const limit = Number.isInteger(limitRaw) && limitRaw > 0 ? limitRaw : Math.max(rt.transcript.count, 1)
            // ONE PROTOCOL, TWO SPELLINGS. The SDK's page loader sends
            // `before`; the API's transcript capture sends `cursor`
            // (session-transcript-capture.ts). Reading only `before` made
            // every capture re-read the newest page — see the header note on
            // `x-next-cursor` for why that was worse than it sounds.
            const before = (search.get('before') ?? search.get('cursor'))?.trim() || null
            const page = rt.transcript.page({ limit, before })
            const stripped = stripInlineAttachmentBytes(page.messages, partRef(root))
            /*
              THE ABSENT CURSOR IS A CLAIM, SO IT MUST BE EARNED.

              Every pager in the fleet reads "no `x-next-cursor`" as "this page
              reached the session's first message". `readTranscriptPages` turns
              that into `headComplete`, the capture turns THAT into
              `complete`, and a complete read licenses the writer's
              "DELETE what disappeared" branch. pi never sent the header, so a
              flagged session longer than one page mirrored its newest window,
              declared itself whole, and deleted every older row it had.

              `page()` already knows: `hasMore`. The cursor is the window's
              OLDEST id, because `page({before})` is an exclusive upper bound
              on the id order — the same contract OpenCode's list serves.
            */
            const older = page.hasMore ? String(page.messages[0]?.info.id ?? '') : ''
            return json(200, stripped.value, older ? { 'x-next-cursor': older } : {})
          }
          if (method === 'GET' && messageId && !partId) {
            const found = rt.transcript.messageById(messageId)
            if (!found) return json(404, { error: 'unknown message' })
            return json(200, stripInlineAttachmentBytes(found, partRef(root)).value)
          }
          if (method === 'DELETE') {
            if (rt.activeTurnMessageId() === messageId) return json(409, { error: 'message is already running' })
            return json(409, { error: 'message deletion is not supported by the pi harness' })
          }
          if (method === 'PATCH') return json(501, { code: 'feature_not_supported', error: 'part edits are not supported by the pi harness' })
        }
        return notFound(path)
      }

      // ── catalog reads ────────────────────────────────────────────────────
      if (method === 'GET') {
        if (path === '/config' || path === '/global/config') return json(200, rt.configObject())
        if (path === '/agent') return json(200, [rt.agentObject()])
        if (path === '/provider') return json(200, rt.providerList())
        if (path === '/config/providers') {
          const list = rt.providerList() as { all: unknown[]; default: Record<string, string> }
          return json(200, { providers: list.all, default: list.default })
        }
        if (path === '/command') return json(200, [])
        if (path === '/skill') {
          return json(
            200,
            rt.skillList().map((skill) => ({ name: skill.name, description: skill.description, location: skill.filePath })),
          )
        }
        if (path === '/tool/ids' || path === '/experimental/tool/ids') return json(200, rt.toolList().map((t) => t.id))
        if (path === '/tool' || path === '/experimental/tool') return json(200, rt.toolList())
        if (path === '/permission') return json(200, rt.permissions.list())
        if (path === '/question') return json(200, rt.questions.list())
        if (path === '/lsp/diagnostics' || path === '/lsp') return json(200, {})
        if (path === '/mcp') return json(200, {})
        if (path === '/path') {
          return json(200, { home: process.env.HOME ?? '/home/kortix', state: '', config: '', worktree: rt.workspace, directory: rt.workspace })
        }
        if (path === '/project/current') return json(200, { id: rt.workspace, worktree: rt.workspace, time: { created: rt.createdAt } })
        if (path === '/project') return json(200, [{ id: rt.workspace, worktree: rt.workspace, time: { created: rt.createdAt } }])
        if (path === '/vcs/diff' || path === '/vcs/status' || path === '/vcs') return json(200, [])
      }

      // ── interaction replies ──────────────────────────────────────────────
      const permission = /^\/permission\/([^/]+)\/reply$/.exec(path)
      if (permission && method === 'POST') {
        const id = decodeSegment(permission[1]!)
        if (id === null) return json(400, { error: 'path contains malformed percent-encoding' })
        let body: { reply?: unknown }
        try {
          body = (await readJsonBody(input.body)) as { reply?: unknown }
        } catch {
          return json(400, { error: 'invalid json body' })
        }
        if (body.reply !== 'once' && body.reply !== 'always' && body.reply !== 'reject') {
          return json(400, { error: 'reply must be once, always, or reject' })
        }
        return rt.permissions.reply(id, body.reply) ? json(200, true) : json(404, { error: 'permission request not found' })
      }
      const question = /^\/question\/([^/]+)\/(reply|reject)$/.exec(path)
      if (question && method === 'POST') {
        const id = decodeSegment(question[1]!)
        if (id === null) return json(400, { error: 'path contains malformed percent-encoding' })
        if (question[2] === 'reject') return rt.questions.reject(id) ? json(200, true) : json(404, { error: 'question request not found' })
        let body: { answers?: unknown }
        try {
          body = (await readJsonBody(input.body)) as { answers?: unknown }
        } catch {
          return json(400, { error: 'invalid json body' })
        }
        if (!Array.isArray(body.answers)) return json(400, { error: 'answers must be an array' })
        return rt.questions.reply(id, body.answers as string[][]) ? json(200, true) : json(404, { error: 'question request not found' })
      }

      return notFound(path)
    },
  }
}
