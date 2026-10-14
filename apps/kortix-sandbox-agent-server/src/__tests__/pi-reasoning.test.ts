import { describe, expect, test } from 'bun:test'
import { foreignReasoningExtension, withoutForeignReasoning } from '@/harness/pi/reasoning'

const target = { provider: 'kortix', api: 'openai-completions', id: 'model-b' }
const thinking = { type: 'thinking', thinking: 'FOREIGN' }
const foreign = () => ({ role: 'assistant', provider: 'kortix', api: 'openai-completions', model: 'model-a', content: [thinking, { type: 'text', text: 'a' }] })

describe('pi reasoning across models (P7.3)', () => {
  test('a request: an assistant message with `content: null` passes through', async () => {
    let seen: unknown
    const stream = withoutForeignReasoning(((_m: unknown, context: { messages: unknown[] }) => (seen = context.messages)) as never)
    const messages = [{ role: 'assistant', provider: 'x', api: 'y', model: 'z', content: null }, foreign()]
    stream(target as never, { messages } as never, undefined)
    expect(seen).toEqual([messages[0], { ...foreign(), content: [{ type: 'text', text: 'a' }] }])
  })

  test('summaries: compaction and branch summaries get copies without foreign thinking; the session entries keep it', async () => {
    const handlers: Record<string, (event: any, ctx: any) => void> = {}
    ;(foreignReasoningExtension() as unknown as { factory: (pi: unknown) => void }).factory({ on: (name: string, fn: (event: any, ctx: any) => void) => void (handlers[name] = fn) })
    const ctx = { model: target }
    const stored = foreign()
    const preparation = { messagesToSummarize: [stored], turnPrefixMessages: [stored, { ...stored, model: 'model-b' }] }
    handlers.session_before_compact!({ preparation }, ctx)
    expect(JSON.stringify(preparation.messagesToSummarize)).not.toContain('FOREIGN')
    expect(preparation.turnPrefixMessages[0]!.content).toEqual([{ type: 'text', text: 'a' }])
    expect(preparation.turnPrefixMessages[1]!.content).toContain(thinking)
    const entries = [{ type: 'message', message: stored }, { type: 'compaction', summary: 's' }]
    handlers.session_before_tree!({ preparation: { entriesToSummarize: entries } }, ctx)
    expect(JSON.stringify(entries)).not.toContain('FOREIGN')
    expect(stored.content).toContain(thinking)
  })
})
