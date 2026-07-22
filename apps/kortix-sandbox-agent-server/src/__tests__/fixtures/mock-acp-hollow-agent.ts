import { createInterface } from 'node:readline'

// Regression fixture for the "hollow session/prompt completion" bug
// (OpenCode 1.17.11 swallowing an upstream 400 — Anthropic's
// `thinking.type=enabled` deprecation for newer Claude models — and
// answering `session/prompt` with a bare `end_turn` + all-zero usage
// instead of surfacing any error). Scripted by the prompt TEXT so one
// fixture covers every case the regression test needs:
//
//   "hollow"       -> end_turn, usage all zero (the bug pattern)
//   "cancelled"    -> stopReason cancelled, usage all zero (legitimate — must
//                     NOT be rewritten into an error)
//   "error-detail" -> streams a `{"detail":"…"}` upstream rejection as message
//                     content then end_turn WITH real usage (the codex
//                     error-as-content pattern the hollow guard can't see)
//   "json-answer"  -> a real JSON answer with domain keys (must NOT be
//                     mistaken for an error envelope)
//   anything else  -> a normal healthy completion with real usage

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
    // Codex leaking an upstream rejection (unsupported model) as message
    // content: the raw `{"detail":"…"}` body streamed as an agent_message_chunk
    // then a normal end_turn WITH real usage — so the hollow guard cannot see
    // it and only the error-as-content detector can. Split across two chunks
    // to exercise accumulation.
    if (text === 'error-detail') {
      const detail = JSON.stringify({
        detail: "The 'openai/gpt-5.4' model is not supported when using Codex with a ChatGPT account.",
      })
      const half = Math.floor(detail.length / 2)
      send({ method: 'session/update', params: { sessionId: 'mock-session', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: detail.slice(0, half) } } } })
      send({ method: 'session/update', params: { sessionId: 'mock-session', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `${detail.slice(half)}\n\n` } } } })
      send({ id: envelope.id, result: { stopReason: 'end_turn', usage: { inputTokens: 7, outputTokens: 3, totalTokens: 10 } } })
      return
    }
    // A REAL answer that is itself valid JSON but carries domain keys — must
    // NOT be mistaken for an error envelope.
    if (text === 'json-answer') {
      send({ method: 'session/update', params: { sessionId: 'mock-session', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '{"result":"ok","value":42}' } } } })
      send({ id: envelope.id, result: { stopReason: 'end_turn', usage: { inputTokens: 8, outputTokens: 5, totalTokens: 13 } } })
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
