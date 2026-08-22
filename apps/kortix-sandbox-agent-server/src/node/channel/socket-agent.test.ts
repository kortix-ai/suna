import { describe, expect, test } from 'bun:test'
import { NodeSocketAgent } from './socket-agent'

class FakeWebSocket {
  binaryType = 'blob'
  sent: unknown[] = []
  closed: Array<[number | undefined, string | undefined]> = []
  private listeners = new Map<string, Array<(event: any) => void>>()
  addEventListener(type: string, listener: (event: any) => void) {
    const values = this.listeners.get(type) ?? []
    values.push(listener)
    this.listeners.set(type, values)
  }
  send(data: unknown) { this.sent.push(data) }
  close(code?: number, reason?: string) { this.closed.push([code, reason]) }
  emit(type: string, event: any = {}) { for (const listener of this.listeners.get(type) ?? []) listener(event) }
}

describe('kortixd node socket agent', () => {
  test('relays bidirectional WebSocket messages through an authorized loopback port', () => {
    const sent: any[] = []
    const upstream = new FakeWebSocket()
    const agent = new NodeSocketAgent(
      (frame) => sent.push(frame),
      new Set([8000]),
      (url, headers) => {
        expect(url).toBe('ws://127.0.0.1:8000/pty/1?x=1')
        expect(headers.authorization).toBe('Bearer key')
        return upstream as unknown as WebSocket
      },
    )
    const id = crypto.randomUUID()

    expect(agent.handle({ v: 1, type: 'socket.open', stream_id: id, seq: 0, port: 8000, path: '/pty/1?x=1', headers: [['authorization', 'Bearer key']] })).toBe(true)
    agent.handle({ v: 1, type: 'socket.data', stream_id: id, seq: 1, data: Buffer.from('queued').toString('base64'), binary: false, fin: true })
    expect(upstream.sent).toHaveLength(0)
    upstream.emit('open')
    expect(sent[0].type).toBe('socket.opened')
    expect(upstream.sent[0]).toBe('queued')

    upstream.emit('message', { data: Buffer.from('reply').buffer })
    expect(Buffer.from(sent[1].data, 'base64').includes(Buffer.from('reply'))).toBe(true)
    agent.handle({ v: 1, type: 'socket.close', stream_id: id, seq: 2, code: 1000, reason: 'done' })
    expect(upstream.closed[0]).toEqual([1000, 'done'])
  })

  test('rejects unauthorized loopback ports', () => {
    const sent: any[] = []
    const agent = new NodeSocketAgent((frame) => sent.push(frame), new Set([8000]))
    agent.handle({ v: 1, type: 'socket.open', stream_id: crypto.randomUUID(), seq: 0, port: 22, path: '/', headers: [] })
    expect(sent[0]).toMatchObject({ type: 'socket.close', code: 4403 })
  })
})
