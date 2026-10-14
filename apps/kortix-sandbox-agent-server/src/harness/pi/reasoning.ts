/**
 * C3 (session-log `ReasoningBlock`): reasoning is display only across models.
 * pi-ai replays a thinking block that another model wrote as visible assistant
 * text (`transformMessages`). This wrapper removes those blocks from every
 * request before pi-ai sees it, with pi-ai's own "same model" test (provider,
 * api, model id). The same model's thinking is unchanged. The session store and
 * the session log keep every block: only the request loses it.
 */
import type { StreamFn } from '@earendil-works/pi-agent-core'

export function withoutForeignReasoning(stream: StreamFn): StreamFn {
  return (model, context, options) => {
    const messages = context.messages.map((m) => {
      if (m.role !== 'assistant' || (m.provider === model.provider && m.api === model.api && m.model === model.id)) return m
      const content = m.content.filter((b) => b.type !== 'thinking')
      return content.length === m.content.length ? m : { ...m, content }
    })
    return stream(model, { ...context, messages }, options)
  }
}
