/**
 * The Kortix turn verbs on OpenCode: each one is the matching OpenCode REST
 * call (`prompt_async` with `?directory=` and `{providerID, modelID}`,
 * `/session/:id/abort`, `/session/:id/message/:id`, `/agent`), sent through
 * the adapter's own proxy forward so the instance guard and the stop record
 * run exactly as for a client's request.
 */
import { logger } from '@/lib/log/logger'
import type { HarnessProxyService } from '../contract/proxy'
import type { HarnessTurnResponse, HarnessTurnService } from '../contract/turns'

/** How many forwarded message ids the daemon remembers; OpenCode's own store covers older ones. */
const RECENT_PROMPT_IDS = 512

async function call(
  proxy: Pick<HarnessProxyService, 'forward'>,
  method: string,
  path: string,
  directory: string | null,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  const result = await proxy.forward({
    method,
    path,
    search: directory ? `?directory=${encodeURIComponent(directory)}` : '',
    headers: new Headers(body === undefined ? {} : { 'content-type': 'application/json' }),
    body: body === undefined ? null : new Response(JSON.stringify(body)).body,
  })
  const text = typeof result.body === 'string' ? result.body : await new Response(result.body).text()
  let parsed: unknown = null
  try {
    parsed = text ? JSON.parse(text) : null
  } catch {
    parsed = { error: text.slice(0, 500) }
  }
  return { status: result.status, body: parsed }
}

const segment = encodeURIComponent

export function createOpenCodeTurnService(
  proxy: Pick<HarnessProxyService, 'forward'>,
  workspace: () => string,
): HarnessTurnService {
  // A repeated messageID is the same prompt sent twice (a retry, a second
  // replica, a reclaimed delivery). OpenCode does not refuse it, so answer it
  // as pi does: `200 {deduplicated: true}`. `recent` covers a send still in
  // flight and one OpenCode has not listed yet; the message read covers a
  // daemon restart, because OpenCode persists the message.
  const recent = new Set<string>()
  let readFailureLogged = false
  const alreadyHeld = async (sessionId: string, messageId: string, directory: string): Promise<boolean> => {
    try {
      const read = await call(proxy, 'GET', `/session/${segment(sessionId)}/message/${segment(messageId)}`, directory)
      return read.status === 200
    } catch (err) {
      // Fail open: a missed dedupe is the old behaviour, a dropped prompt is worse.
      if (!readFailureLogged) {
        readFailureLogged = true
        logger.warn('[opencode-turns] prompt dedupe read failed; sending anyway', { err: String(err) })
      }
      return false
    }
  }

  return {
    async prompt(sessionId, input): Promise<HarnessTurnResponse> {
      const directory = input.directory ?? workspace()
      const key = input.messageId ? `${sessionId}:${input.messageId}` : null
      if (key) {
        if (recent.has(key) || (await alreadyHeld(sessionId, input.messageId!, directory)) || recent.has(key)) {
          return { status: 200, body: { deduplicated: true } }
        }
        recent.add(key)
        if (recent.size > RECENT_PROMPT_IDS) recent.delete(recent.values().next().value!)
      }
      let result: { status: number; body: unknown }
      try {
        result = await call(proxy, 'POST', `/session/${segment(sessionId)}/prompt_async`, directory, {
          ...(input.messageId ? { messageID: input.messageId } : {}),
          parts: input.parts,
          ...(input.agent ? { agent: input.agent } : {}),
          ...(input.model ? { model: input.model } : {}),
          ...(input.variant ? { variant: input.variant } : {}),
          ...(input.noReply ? { noReply: true } : {}),
        })
      } catch (err) {
        if (key) recent.delete(key)
        throw err
      }
      // `prompt_async` answers 204: accepted, the turn runs on the event stream.
      if (result.status >= 200 && result.status < 300) {
        return { status: 202, body: { message_id: input.messageId ?? null } }
      }
      // Refused: the prompt did not go in, so a retry under the same id may.
      if (key) recent.delete(key)
      return result
    },
    abort: (sessionId) => call(proxy, 'POST', `/session/${segment(sessionId)}/abort`, workspace()),
    readMessage: (sessionId, messageId) =>
      call(proxy, 'GET', `/session/${segment(sessionId)}/message/${segment(messageId)}`, workspace()),
    removeMessage: (sessionId, messageId) => {
      // A removed message may be sent again under its id.
      recent.delete(`${sessionId}:${messageId}`)
      return call(proxy, 'DELETE', `/session/${segment(sessionId)}/message/${segment(messageId)}`, workspace())
    },
    async agents(directory) {
      const result = await call(proxy, 'GET', '/agent', directory ?? workspace())
      if (result.status !== 200 || !Array.isArray(result.body)) return result
      return {
        status: 200,
        body: {
          agents: (result.body as Array<Record<string, unknown>>).map((agent) => ({
            name: agent.name,
            description: agent.description ?? null,
            mode: agent.mode ?? null,
          })),
        },
      }
    },
  }
}
