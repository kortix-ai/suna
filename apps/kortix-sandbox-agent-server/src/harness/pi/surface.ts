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
        write(`data: ${JSON.stringify({ type: event.type, properties: event.payload })}\n\n`)
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
      if (path === '/session' && method === 'GET') return json(200, [rt.sessionObject(), ...rt.childSessions()])
      if (path === '/session' && method === 'POST') return json(200, rt.sessionObject())
      if (path === '/session/status' && method === 'GET') {
        const statuses = (rt.stateDoc().statuses as { value: Record<string, { type: string }> }).value
        return json(200, Object.fromEntries(Object.entries(statuses).filter(([, status]) => status.type !== 'idle')))
      }

      const session = /^\/session\/([^/]+)(?:\/(.*))?$/.exec(path)
      if (session) {
        const sessionId = decodeSegment(session[1]!)
        if (sessionId === null) return json(400, { error: 'path contains malformed percent-encoding' })
        // A child session (a subagent) is readable here; it is driven only by its parent's task tool.
        const child = sessionId === root ? null : rt.childSession(sessionId)
        if (sessionId !== root && !child) return json(404, { error: 'unknown session' })
        const transcript = child?.transcript ?? rt.transcript
        const sub = session[2] ?? ''

        if (sub === '' && method === 'GET') return json(200, child?.object ?? rt.sessionObject())
        if (sub === 'children' && method === 'GET') return json(200, child ? [] : rt.childSessions())
        const message = /^message(?:\/([^/]+)(?:\/part\/([^/]+))?)?$/.exec(sub)
        if (message && method === 'GET') {
          const messageId = message[1] ? decodeSegment(message[1]) : null
          if ((message[1] && messageId === null) || (message[2] && decodeSegment(message[2]) === null)) {
            return json(400, { error: 'path contains malformed percent-encoding' })
          }
          if (!messageId) {
            const limitRaw = Number(search.get('limit') ?? 0)
            const limit = Number.isInteger(limitRaw) && limitRaw > 0 ? limitRaw : Math.max(transcript.count, 1)
            const before = search.get('before')?.trim() || null
            return json(200, stripInlineAttachmentBytes(transcript.page({ limit, before }).messages, partRef(sessionId)).value)
          }
          if (!message[2]) {
            const found = transcript.messageById(messageId)
            if (!found) return json(404, { error: 'unknown message' })
            return json(200, stripInlineAttachmentBytes(found, partRef(sessionId)).value)
          }
        }
        if (child) {
          if ((sub === 'todo' || sub === 'diff') && method === 'GET') return json(200, [])
          return json(501, { code: 'feature_not_supported', error: 'a pi subagent session is read-only; its parent task drives it' })
        }
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
        if (sub === 'diff' && method === 'GET') return json(200, [])
        if ((sub === 'revert' || sub === 'unrevert') && method === 'POST') {
          return json(501, { code: 'feature_not_supported', error: 'session rewind is not supported by the pi harness' })
        }
        if ((sub === 'command' || sub === 'summarize' || sub === 'init' || sub === 'fork' || sub === 'share' || sub === 'shell') && method === 'POST') {
          return json(501, { code: 'feature_not_supported', error: `${sub} is not supported by the pi harness` })
        }

        if (message) {
          const messageId = message[1] ? decodeSegment(message[1]) : null
          if (message[1] && messageId === null) return json(400, { error: 'path contains malformed percent-encoding' })
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
