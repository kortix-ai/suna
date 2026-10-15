import { describe, expect, test } from 'bun:test'
import { withoutForeignReasoning } from '@/harness/pi/reasoning'

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

})
