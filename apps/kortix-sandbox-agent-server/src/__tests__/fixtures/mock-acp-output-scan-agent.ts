import { createInterface } from 'node:readline'

// output-scan.test.ts fixture: a real spawned process used to prove the
// OutputScanTracker wiring inside AcpProcess. On `session/prompt` it emits a
// completed `execute` tool_call update (the harness's own event) before
// replying to the prompt itself — the daemon's synthetic `kortix-outputs:`
// scan event must land strictly after both, in the same replay buffer.

function send(envelope: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...envelope })}\n`)
}

const input = createInterface({ input: process.stdin })
input.on('line', (line) => {
  const envelope = JSON.parse(line) as Record<string, unknown>
  if (envelope.method === 'session/prompt') {
    const params = envelope.params as { sessionId?: string } | undefined
    const sessionId = params?.sessionId ?? 'mock-session'
    send({
      method: 'session/update',
      params: {
        sessionId,
        update: { sessionUpdate: 'tool_call', toolCallId: 'harness-call-1', kind: 'execute', status: 'completed' },
      },
    })
    send({ id: envelope.id, result: { stopReason: 'end_turn' } })
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
