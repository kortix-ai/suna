import { createInterface } from 'node:readline'

// Regression fixture for the "hollow session/prompt completion" bug
// (OpenCode 1.17.11 swallowing an upstream 400 — Anthropic's
// `thinking.type=enabled` deprecation for newer Claude models — and
// answering `session/prompt` with a bare `end_turn` + all-zero usage
// instead of surfacing any error). Scripted by the prompt TEXT so one
// fixture covers every case the regression test needs:
//
//   "hollow"    -> end_turn, usage all zero (the bug pattern)
//   "cancelled" -> stopReason cancelled, usage all zero (legitimate — must
//                  NOT be rewritten into an error)
//   anything else -> a normal healthy completion with real usage

function send(envelope: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...envelope })}\n`)
}

const input = createInterface({ input: process.stdin })
input.on('line', (line) => {
  const envelope = JSON.parse(line) as Record<string, unknown>

  if (envelope.method === 'session/prompt') {
    const params = envelope.params as Record<string, unknown> | undefined
    const prompt = Array.isArray(params?.prompt) ? (params.prompt as Array<Record<string, unknown>>) : []
    const text = typeof prompt[0]?.text === 'string' ? (prompt[0].text as string) : ''

    if (text === 'hollow') {
      send({ id: envelope.id, result: { stopReason: 'end_turn', usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } } })
      return
    }
    if (text === 'cancelled') {
      send({ id: envelope.id, result: { stopReason: 'cancelled', usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } } })
      return
    }
    send({
      method: 'session/update',
      params: { sessionId: 'mock-session', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'banana' } } },
    })
    send({ id: envelope.id, result: { stopReason: 'end_turn', usage: { inputTokens: 9, outputTokens: 4, totalTokens: 13 } } })
    return
  }

  if (Object.prototype.hasOwnProperty.call(envelope, 'id')) {
    const method = String(envelope.method)
    const result = method === 'session/new' ? { sessionId: 'mock-session' } : { protocolVersion: 1, agentCapabilities: {} }
    send({ id: envelope.id, result })
  }
})
