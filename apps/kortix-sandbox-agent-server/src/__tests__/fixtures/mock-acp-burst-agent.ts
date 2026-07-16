import { createInterface } from 'node:readline'

// Gate 5 fixture (WS3-P4-a): a real spawned process used to exercise the
// bridge's bounded in-memory replay buffer. `burst` emits `params.count`
// session/update notifications back-to-back (each becomes one replay-buffer
// event), then replies to the triggering request only after every
// notification line has been written — so by the time the HTTP POST that
// sent `burst` resolves, the full burst is guaranteed to already be in the
// bridge's replay buffer (or evicted from it).

function send(envelope: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...envelope })}\n`)
}

const input = createInterface({ input: process.stdin })
input.on('line', (line) => {
  const envelope = JSON.parse(line) as Record<string, unknown>
  if (envelope.method === 'burst') {
    const params = envelope.params as { count?: number } | undefined
    const count = params?.count ?? 0
    for (let i = 0; i < count; i++) {
      send({ method: 'session/update', params: { n: i } })
    }
    send({ id: envelope.id, result: { emitted: count } })
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
