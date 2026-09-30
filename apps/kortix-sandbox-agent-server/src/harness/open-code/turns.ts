/**
 * The Kortix turn verbs on OpenCode: each one is the matching OpenCode REST
 * call (`prompt_async` with `?directory=` and `{providerID, modelID}`,
 * `/session/:id/abort`, `/session/:id/message/:id`, `/agent`), sent through
 * the adapter's own proxy forward so the instance guard and the stop record
 * run exactly as for a client's request.
 */
import type { HarnessProxyService } from '../contract/proxy'
import type { HarnessTurnResponse, HarnessTurnService } from '../contract/turns'

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
  return {
    async prompt(sessionId, input): Promise<HarnessTurnResponse> {
      const result = await call(proxy, 'POST', `/session/${segment(sessionId)}/prompt_async`, input.directory ?? workspace(), {
        ...(input.messageId ? { messageID: input.messageId } : {}),
        parts: input.parts,
        ...(input.agent ? { agent: input.agent } : {}),
        ...(input.model ? { model: input.model } : {}),
        ...(input.variant ? { variant: input.variant } : {}),
        ...(input.noReply ? { noReply: true } : {}),
      })
      // `prompt_async` answers 204: accepted, the turn runs on the event stream.
      if (result.status >= 200 && result.status < 300) {
        return { status: 202, body: { message_id: input.messageId ?? null } }
      }
      return result
    },
    abort: (sessionId) => call(proxy, 'POST', `/session/${segment(sessionId)}/abort`, workspace()),
    readMessage: (sessionId, messageId) =>
      call(proxy, 'GET', `/session/${segment(sessionId)}/message/${segment(messageId)}`, workspace()),
    removeMessage: (sessionId, messageId) =>
      call(proxy, 'DELETE', `/session/${segment(sessionId)}/message/${segment(messageId)}`, workspace()),
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
