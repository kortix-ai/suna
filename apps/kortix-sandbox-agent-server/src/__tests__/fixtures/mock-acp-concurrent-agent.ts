import { createInterface } from 'node:readline'

// Gate 7 fixture (WS3-P4-a): a real spawned process used to prove that a
// long-running JSON-RPC exchange does not block a concurrent one on the same
// ACP connection. `slow` sleeps before responding; `fast` responds
// immediately. Both are dispatched by the bridge's write queue, which only
// serializes the stdin *writes* themselves, never the request lifetimes.

function send(envelope: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...envelope })}\n`)
}

const input = createInterface({ input: process.stdin })
input.on('line', (line) => {
  const envelope = JSON.parse(line) as Record<string, unknown>
  if (envelope.method === 'slow') {
    setTimeout(() => send({ id: envelope.id, result: { kind: 'slow' } }), 300)
    return
  }
  if (envelope.method === 'fast') {
    send({ id: envelope.id, result: { kind: 'fast' } })
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
