import { describe, expect, test } from 'bun:test'
import { NodeRpcAgent } from './rpc-agent'

describe('kortixd node capability RPC', () => {
  test('dispatches registered methods and returns results', async () => {
    const sent: any[] = []
    const agent = new NodeRpcAgent((frame) => sent.push(frame), new Map([
      ['fs.stat', async (params: Record<string, unknown>) => ({ path: params.path })],
    ]))
    agent.handle({ v: 1, type: 'rpc.request', stream_id: crypto.randomUUID(), seq: 0, method: 'fs.stat', params: { path: '/workspace/a' } })
    await Bun.sleep(0)
    expect(sent[0]).toMatchObject({ type: 'rpc.result', result: { path: '/workspace/a' } })
  })

  test('rejects unregistered methods without executing code', () => {
    const sent: any[] = []
    const agent = new NodeRpcAgent((frame) => sent.push(frame), new Map())
    agent.handle({ v: 1, type: 'rpc.request', stream_id: crypto.randomUUID(), seq: 0, method: 'root.exec', params: {} })
    expect(sent[0]).toMatchObject({ type: 'rpc.error', code: -32001 })
  })
})
