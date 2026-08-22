import { createHmac } from 'node:crypto'
import { describe, expect, test } from 'bun:test'
import { KortixNodeChannel } from './client'

class FakeSocket extends EventTarget {
  static readonly OPEN = 1
  readyState = 1
  sent: string[] = []
  send(value: string) { this.sent.push(value) }
  close() {}
  receive(value: unknown) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(value) })) }
}

function signed(value: Record<string, unknown>, key: string, nonce: number) {
  return { ...value, _nonce: nonce, _sig: createHmac('sha256', key).update(`${nonce}:${JSON.stringify(value)}`).digest('hex') }
}

describe('kortixd outbound node channel', () => {
  test('authenticates without putting the credential in the URL', () => {
    const socket = new FakeSocket()
    const channel = new KortixNodeChannel({ apiUrl: 'https://api.test/v1', nodeId: 'node-1', token: 'secret', ports: new Set([8000]), socketFactory: (url) => {
      expect(url).toBe('wss://api.test/v1/nodes/ws')
      return socket as unknown as WebSocket
    } })
    channel.connect()
    socket.dispatchEvent(new Event('open'))
    expect(JSON.parse(socket.sent[0]!)).toMatchObject({ type: 'node.auth', node_id: 'node-1', token: 'secret' })
  })

  test('accepts signed frames and rejects nonce replay', async () => {
    const socket = new FakeSocket()
    const channel = new KortixNodeChannel({ apiUrl: 'http://127.0.0.1:8008/v1', nodeId: 'node-1', token: 'secret', ports: new Set([8000]), socketFactory: () => socket as unknown as WebSocket })
    channel.connect()
    socket.dispatchEvent(new Event('open'))
    socket.receive({ type: 'node.auth.ok', signing_key: 'session-key' })
    await Bun.sleep(0)
    expect(JSON.parse(socket.sent[1]!).type).toBe('node.heartbeat')
    const open = { v: 1, type: 'stream.open', stream_id: crypto.randomUUID(), seq: 0, port: 22, method: 'GET', path: '/', headers: [], window: 1024 }
    socket.receive(signed(open, 'session-key', 1))
    await Bun.sleep(0)
    expect(JSON.parse(socket.sent[2]!).type).toBe('stream.cancel')
    socket.receive(signed(open, 'session-key', 1))
    await Bun.sleep(0)
    expect(channel.status().lastError).toContain('nonce')
  })
})
