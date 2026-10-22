import { describe, expect, test } from 'bun:test'
import { getCurrentTools, normalizeContext, type SimpleStreamOptions, type TranscriptContext } from '@earendil-works/pi-ai'
import { withAgentSampling } from '@/harness/pi/sampling'

type Call = { tools: number; options: SimpleStreamOptions | undefined }

function recorder() {
  const calls: Call[] = []
  const stream = ((_model: unknown, context: TranscriptContext, options?: SimpleStreamOptions) => {
    calls.push({ tools: getCurrentTools(context.messages).length, options })
    return {} as never
  }) as never
  return { calls, stream }
}

const tool = { name: 'bash', description: '', parameters: {} } as never
const user = { role: 'user', content: 'go', timestamp: 0 } as never
const toolResult = { role: 'toolResult', toolCallId: 'c', toolName: 'bash', content: [], isError: false, timestamp: 0 } as never
const context = (last: unknown): TranscriptContext => normalizeContext({ systemPrompt: '', messages: [last] as never, tools: [tool] })

describe('withAgentSampling', () => {
  test('temperature and top_p ride on every request', () => {
    const r = recorder()
    const fn = withAgentSampling(r.stream, () => ({ temperature: 0.2, top_p: 0.9 }))
    fn({} as never, context(user), { reasoning: 'low' })
    expect(r.calls[0]!.options).toEqual({ reasoning: 'low', temperature: 0.2, samplingParams: { top_p: 0.9 } })
  })

  test('a model that takes no temperature gets none', () => {
    const r = recorder()
    const fn = withAgentSampling(r.stream, () => ({ temperature: 0.2, acceptsTemperature: false }))
    fn({} as never, context(user), undefined)
    expect(r.calls[0]!.options).toEqual({})
  })

  test('the request that reaches steps may not call a tool, and a new prompt starts the count again', () => {
    const r = recorder()
    const fn = withAgentSampling(r.stream, () => ({ steps: 2 }))
    fn({} as never, context(user), undefined)
    fn({} as never, context(toolResult), undefined)
    fn({} as never, context(user), undefined)
    expect(r.calls.map((c) => c.options?.toolChoice)).toEqual([undefined, 'none', undefined])
  })

  test('a request without tools (compaction) neither counts nor resets a step', () => {
    const r = recorder()
    const fn = withAgentSampling(r.stream, () => ({ steps: 2 }))
    fn({} as never, context(user), undefined)
    fn({} as never, normalizeContext({ systemPrompt: '', messages: [user] }), undefined)
    fn({} as never, context(toolResult), undefined)
    expect(r.calls.map((c) => c.options?.toolChoice)).toEqual([undefined, undefined, 'none'])
  })
})
