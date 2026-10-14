/**
 * C3 (session-log `ReasoningBlock`): reasoning is display only across models.
 * pi-ai replays a thinking block that another model wrote as visible assistant
 * text (`transformMessages`), and pi's summarizers flatten every thinking block
 * into the prompt text (`serializeConversation`). Both paths drop the thinking
 * of another model first, with pi-ai's own "same model" test (provider, api,
 * model id). The same model's thinking is unchanged. The session store and the
 * session log keep every block: only the request loses it.
 */
import type { StreamFn } from '@earendil-works/pi-agent-core'
import type { InlineExtension } from './extensions/host'

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

/**
 * Summaries: a compaction and a branch summary run on the session's current
 * model. pi hands the same `preparation` to its default summarizer after these
 * hooks, so the hooks swap in copies; the session entries stay untouched.
 */
export function foreignReasoningExtension(): InlineExtension {
  return {
    name: 'kortix-reasoning',
    hidden: true,
    factory: (pi) => {
      pi.on('session_before_compact', (event, ctx) => {
        if (!ctx.model) return
        const p = event.preparation
        p.messagesToSummarize = dropForeignThinking(p.messagesToSummarize, ctx.model)
        p.turnPrefixMessages = dropForeignThinking(p.turnPrefixMessages, ctx.model)
      })
      pi.on('session_before_tree', (event, ctx) => {
        const model = ctx.model
        if (!model) return
        // generateBranchSummary reads this array itself, not a copy: replace its entries in place.
        const entries = event.preparation.entriesToSummarize
        entries.forEach((entry, i) => {
          if (entry.type !== 'message') return
          const [message] = dropForeignThinking([entry.message], model)
          if (message !== entry.message) entries[i] = { ...entry, message: message! }
        })
      })
    },
  }
}
