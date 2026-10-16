/**
 * An OpenAI-compatible `/chat/completions` on 127.0.0.1 for harness tests (no real
 * model provider, dummy key): it streams the next scripted step and records each
 * request body. pi and OpenCode both speak this dialect.
 */
/**
 * `reasoning`: the reasoning tokens the step's usage reports (`completion_tokens_details.reasoning_tokens`).
 * `thinking`: reasoning text streamed as `reasoning_content` before the step.
 */
export type Step = ({ text: string } | { tool: string; args: Record<string, unknown> }) & { reasoning?: number; thinking?: string }
export type ChatBody = { messages: unknown[]; tools?: unknown[] }

export function startFakeModel(modelId = 'test-model') {
  let script: Step[] = []
  let calls = 0
  const bodies: ChatBody[] = []
  const chunk = (delta: Record<string, unknown>, finish: string | null = null) =>
    `data: ${JSON.stringify({ id: 'chatcmpl-test', object: 'chat.completion.chunk', created: 0, model: modelId, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    idleTimeout: 0,
    async fetch(req) {
      if (req.method !== 'POST' || !new URL(req.url).pathname.endsWith('/chat/completions')) return new Response('not found', { status: 404 })
      bodies.push((await req.json()) as ChatBody)
      const step = script.shift() ?? { text: 'OK' }
      calls += 1
      let body = chunk({ role: 'assistant', content: '' })
      if (step.thinking) body += chunk({ reasoning_content: step.thinking })
      if ('tool' in step) {
        body += chunk({ tool_calls: [{ index: 0, id: `call_${calls}_0`, type: 'function', function: { name: step.tool, arguments: JSON.stringify(step.args) } }] })
        body += chunk({}, 'tool_calls')
      } else {
        body += chunk({ content: step.text })
        body += chunk({}, 'stop')
      }
      body += `data: ${JSON.stringify({ id: 'chatcmpl-test', object: 'chat.completion.chunk', created: 0, model: modelId, choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, ...(step.reasoning !== undefined ? { completion_tokens_details: { reasoning_tokens: step.reasoning } } : {}) } })}\n\n`
      body += 'data: [DONE]\n\n'
      return new Response(body, { headers: { 'content-type': 'text/event-stream' } })
    },
  })
  return {
    origin: `http://127.0.0.1:${server.port}`,
    url: `http://127.0.0.1:${server.port}/v1/llm`,
    bodies,
    script: (steps: Step[]) => void (script = [...steps]),
    stop: () => server.stop(true),
  }
}
