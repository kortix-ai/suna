import { createInterface } from 'node:readline'

let pendingPromptId: unknown = null

function send(envelope: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...envelope })}\n`)
}

const input = createInterface({ input: process.stdin })
input.on('line', (line) => {
  const envelope = JSON.parse(line) as Record<string, unknown>
  if (envelope.method === 'session/prompt') {
    pendingPromptId = envelope.id
    send({
      id: 'permission-1',
      method: 'session/request_permission',
      params: { sessionId: 'mock-session', options: [{ optionId: 'allow_once' }] },
    })
    return
  }

  if (envelope.id === 'permission-1' && pendingPromptId !== null) {
    send({
      method: 'session/update',
      params: {
        sessionId: 'mock-session',
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'done' } },
      },
    })
    send({ id: pendingPromptId, result: { stopReason: 'end_turn' } })
    pendingPromptId = null
    return
  }

  if (Object.prototype.hasOwnProperty.call(envelope, 'id')) {
    const method = String(envelope.method)
    const result = method === 'session/new'
      ? { sessionId: 'mock-session' }
      : { protocolVersion: 1, agentCapabilities: {} }
    send({ id: envelope.id, result })
  }
})
