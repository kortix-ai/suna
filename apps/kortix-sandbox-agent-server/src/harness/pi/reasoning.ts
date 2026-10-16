/**
 * C3 (session-log `ReasoningBlock`): reasoning is display only across models.
 * pi-ai replays a thinking block that another model wrote as visible assistant
 * text (`transformMessages`). The request drops the thinking of another model
 * first, with pi-ai's own "same model" test (provider, api, model id). The same
 * model's thinking is unchanged. The session store and the session log keep
 * every block: only the request loses it. pi's summarizers need no filter: since
 * pi 1.2.0 `serializeConversation` omits every thinking block.
 */
import type { StreamFn } from '@earendil-works/pi-agent-core'

type Target = { provider: string; api: string; id: string }
type Msg = { role?: string; provider?: string; api?: string; model?: string; content?: unknown }

/** `messages` without the thinking blocks another model than `target` wrote. An unchanged message keeps its identity. */
export function dropForeignThinking<T>(messages: T[], target: Target): T[] {
  return messages.map((message) => {
    const m = message as Msg
    if (m?.role !== 'assistant' || (m.provider === target.provider && m.api === target.api && m.model === target.id)) return message
    const blocks = Array.isArray(m.content) ? (m.content as Array<{ type?: string }>) : []
    const content = blocks.filter((b) => b?.type !== 'thinking')
    return content.length === blocks.length ? message : ({ ...m, content } as T)
  })
}

/** Model requests: the root agent and every child agent. */
export function withoutForeignReasoning(stream: StreamFn): StreamFn {
  return (model, context, options) => stream(model, { ...context, messages: dropForeignThinking(context.messages, model) }, options)
}

