import { createInterface } from 'node:readline'

let pendingPromptId: unknown = null

function send(envelope: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...envelope })}\n`)
}

const input = createInterface({ input: process.stdin })
input.on('line', (line) => {
  const envelope = JSON.parse(line) as Record<string, unknown>

  // Mid-prompt cancel: a real `session/cancel` notification (no `id`,
  // per ACP) arriving while a prompt is outstanding resolves that prompt
  // with `stopReason: 'cancelled'` instead of ever reaching the permission
  // round-trip below — the SDK-integration proof (sdk-bridge.e2e.test.ts)
  // uses this to observe the daemon's real `busy` flag (`GET /acp`) clear.
  if (envelope.method === 'session/cancel' && pendingPromptId !== null) {
    const cancelledId = pendingPromptId
    pendingPromptId = null
    send({ id: cancelledId, result: { stopReason: 'cancelled' } })
    return
  }

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
    // Acknowledgment notification proving the agent actually received the
    // client's permission response (sdk-bridge.e2e.test.ts's permission
    // round-trip proof) — not a real ACP method, a test-only signal.
    const outcome = (envelope.result as Record<string, unknown> | undefined)?.outcome as
      | Record<string, unknown>
      | undefined
    send({
      method: 'kortix/test_permission_ack',
      params: {
        sessionId: 'mock-session',
        receivedOutcome: outcome?.outcome ?? null,
        receivedOptionId: outcome?.optionId ?? null,
      },
    })
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
