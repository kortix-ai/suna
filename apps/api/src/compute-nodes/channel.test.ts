import { describe, expect, test } from 'bun:test'
import { createHmac } from 'node:crypto'
import { ComputeNodeChannelHub } from './channel'

class FakeSocket {
  sent: string[] = []
  closed: Array<[number | undefined, string | undefined]> = []
  send(value: string) { this.sent.push(value) }
  close(code?: number, reason?: string) { this.closed.push([code, reason]) }
}

function signed(value: Record<string, unknown>, key: string, nonce: number) {
  return JSON.stringify({ ...value, _nonce: nonce, _sig: createHmac('sha256', key).update(`${nonce}:${JSON.stringify(value)}`).digest('hex') })
}

describe('ComputeNodeChannelHub', () => {
  test('authenticates a sandbox node and replaces its prior connection', async () => {
    const hub = new ComputeNodeChannelHub(async (nodeId, token) => token === 'valid' ? { nodeId, externalId: 'ext-1' } : null)
    const first = new FakeSocket()
    const second = new FakeSocket()
    hub.open(first)
    await hub.message(first, JSON.stringify({ type: 'node.auth', node_id: 'node-1', token: 'valid', version: '1' }))
    hub.open(second)
    await hub.message(second, JSON.stringify({ type: 'node.auth', node_id: 'node-1', token: 'valid', version: '1' }))
    expect(hub.isConnected('node-1')).toBe(true)
    expect(first.closed[0]).toEqual([4004, 'replaced by newer kortixd connection'])
    expect(JSON.parse(second.sent[0]!).type).toBe('node.auth.ok')
  })

  test('rejects a bad credential', async () => {
    const hub = new ComputeNodeChannelHub(async () => null)
    const socket = new FakeSocket()
    hub.open(socket)
    await hub.message(socket, JSON.stringify({ type: 'node.auth', node_id: 'node-1', token: 'bad' }))
    expect(socket.closed[0]).toEqual([4001, 'node authentication failed'])
  })

  test('accepts signed heartbeats from the authenticated node', async () => {
    const heartbeats: Array<{ nodeId: string; version?: string; capabilities: string[] }> = []
    const hub = new ComputeNodeChannelHub(
      async (nodeId) => ({ nodeId }),
      undefined,
      async (nodeId, info) => { heartbeats.push({ nodeId, version: info.version, capabilities: info.capabilities }) },
    )
    const socket = new FakeSocket()
    hub.open(socket)
    await hub.message(socket, JSON.stringify({ type: 'node.auth', node_id: 'node-1', token: 'valid' }))
    const key = JSON.parse(socket.sent[0]!).signing_key as string
    await hub.message(socket, signed({
      v: 1,
      type: 'node.heartbeat',
      stream_id: crypto.randomUUID(),
      seq: 0,
      version: '1.2.3',
      capabilities: ['filesystem', 'terminal'],
      platform: 'linux',
      arch: 'x64',
      sent_at: new Date().toISOString(),
    }, key, 1))
    expect(heartbeats).toEqual([{ nodeId: 'node-1', version: '1.2.3', capabilities: ['filesystem', 'terminal'] }])
  })

  test('authenticates before provider external id exists and resolves it later', async () => {
    const hub = new ComputeNodeChannelHub(
      async (nodeId) => ({ nodeId }),
      async (externalId) => externalId === 'ext-later' ? 'node-1' : null,
    )
    const socket = new FakeSocket()
    hub.open(socket)
    await hub.message(socket, JSON.stringify({ type: 'node.auth', node_id: 'node-1', token: 'valid' }))
    const response = hub.fetchByExternalId('ext-later', 8000, new Request('http://node.test/health'))
    await Bun.sleep(0)
    expect(JSON.parse(socket.sent[1]!).type).toBe('stream.open')
    void response.catch(() => {})
    hub.close(socket)
  })

  test('streams an HTTP response from the connected node', async () => {
    const hub = new ComputeNodeChannelHub(async (nodeId) => ({ nodeId, externalId: 'ext-1' }))
    const socket = new FakeSocket()
    hub.open(socket)
    await hub.message(socket, JSON.stringify({ type: 'node.auth', node_id: 'node-1', token: 'valid' }))
    const key = JSON.parse(socket.sent[0]!).signing_key as string
    const responsePromise = hub.fetchByExternalId('ext-1', 8000, new Request('http://node.test/events'))
    await Bun.sleep(0)
    const open = JSON.parse(socket.sent[1]!)
    await hub.message(socket, signed({ v: 1, type: 'stream.response', stream_id: open.stream_id, seq: 0, status: 200, headers: [['content-type', 'text/event-stream']], window: 1024 }, key, 1))
    await hub.message(socket, signed({ v: 1, type: 'stream.response.data', stream_id: open.stream_id, seq: 1, data: Buffer.from('data: ok\n\n').toString('base64') }, key, 2))
    const response = await responsePromise
    expect(response.status).toBe(200)
    expect(socket.sent.slice(2).some((raw) => JSON.parse(raw).type === 'stream.window')).toBe(false)
    const reader = response.body!.getReader()
    expect(Buffer.from((await reader.read()).value!).toString()).toBe('data: ok\n\n')
    const endRead = reader.read()
    await Bun.sleep(0)
    expect(JSON.parse(socket.sent.at(-1)!).type).toBe('stream.window')
    await hub.message(socket, signed({ v: 1, type: 'stream.response.end', stream_id: open.stream_id, seq: 2 }, key, 3))
    expect((await endRead).done).toBe(true)
  })

  test('relays response-consumer cancellation to kortixd', async () => {
    const hub = new ComputeNodeChannelHub(async (nodeId) => ({ nodeId, externalId: 'ext-1' }))
    const socket = new FakeSocket()
    hub.open(socket)
    await hub.message(socket, JSON.stringify({ type: 'node.auth', node_id: 'node-1', token: 'valid' }))
    const key = JSON.parse(socket.sent[0]!).signing_key as string
    const responsePromise = hub.fetch('node-1', 8000, new Request('http://node.test/events'))
    await Bun.sleep(0)
    const open = JSON.parse(socket.sent[1]!)
    await hub.message(socket, signed({ v: 1, type: 'stream.response', stream_id: open.stream_id, seq: 0, status: 200, headers: [], window: 1024 }, key, 1))
    const response = await responsePromise
    await response.body!.cancel('browser left')
    expect(JSON.parse(socket.sent.at(-1)!).type).toBe('stream.cancel')
  })

  test('relays a bidirectional WebSocket through the connected node', async () => {
    const events: string[] = []
    const hub = new ComputeNodeChannelHub(async (nodeId) => ({ nodeId, externalId: 'ext-1' }))
    const socket = new FakeSocket()
    hub.open(socket)
    await hub.message(socket, JSON.stringify({ type: 'node.auth', node_id: 'node-1', token: 'valid' }))
    const key = JSON.parse(socket.sent[0]!).signing_key as string
    const relay = await hub.connectWebSocketByExternalId('ext-1', 8000, '/pty/1', { authorization: 'Bearer key' }, {
      open: () => events.push('open'),
      message: (data) => events.push(Buffer.from(data).toString()),
      close: (code, reason) => events.push(`${code}:${reason}`),
    })
    const open = JSON.parse(socket.sent[1]!)
    expect(open).toMatchObject({ type: 'socket.open', port: 8000, path: '/pty/1' })

    await hub.message(socket, signed({ v: 1, type: 'socket.opened', stream_id: open.stream_id, seq: 0 }, key, 1))
    await hub.message(socket, signed({ v: 1, type: 'socket.data', stream_id: open.stream_id, seq: 1, data: Buffer.from('reply').toString('base64'), binary: false, fin: true }, key, 2))
    expect(events).toEqual(['open', 'reply'])
    relay.send('request')
    expect(JSON.parse(socket.sent.at(-1)!).type).toBe('socket.data')
    relay.close(1000, 'done')
    expect(JSON.parse(socket.sent.at(-1)!).type).toBe('socket.close')
  })

  test('relays capability RPC results and errors', async () => {
    const hub = new ComputeNodeChannelHub(async (nodeId) => ({ nodeId }))
    const socket = new FakeSocket()
    hub.open(socket)
    await hub.message(socket, JSON.stringify({ type: 'node.auth', node_id: 'node-1', token: 'valid' }))
    const key = JSON.parse(socket.sent[0]!).signing_key as string
    const resultPromise = hub.rpc('node-1', 'fs.stat', { path: '/workspace/a' })
    const request = JSON.parse(socket.sent[1]!)
    await hub.message(socket, signed({ v: 1, type: 'rpc.result', stream_id: request.stream_id, seq: 0, result: { size: 3 } }, key, 1))
    expect(await resultPromise).toEqual({ size: 3 })

    const errorPromise = hub.rpc('node-1', 'shell.exec', { command: 'false' })
    const errorRequest = JSON.parse(socket.sent[2]!)
    await hub.message(socket, signed({ v: 1, type: 'rpc.error', stream_id: errorRequest.stream_id, seq: 0, code: -32003, message: 'failed' }, key, 2))
    await expect(errorPromise).rejects.toMatchObject({ code: -32003, message: 'failed' })
  })

  test('applies, observes, and stops a compute node assignment over the same channel', async () => {
    const events: string[] = []
    const hub = new ComputeNodeChannelHub(
      async (nodeId) => ({ nodeId }),
      undefined,
      undefined,
      async (_nodeId, _assignmentId, state) => { events.push(state) },
    )
    const socket = new FakeSocket()
    hub.open(socket)
    await hub.message(socket, JSON.stringify({ type: 'node.auth', node_id: 'node-1', token: 'valid' }))
    const key = JSON.parse(socket.sent[0]!).signing_key as string
    const assignmentId = crypto.randomUUID()
    const readyPromise = hub.assign('node-1', {
      assignment_id: assignmentId,
      session_id: crypto.randomUUID(),
      project_id: crypto.randomUUID(),
      lease_epoch: 1,
      lease_expires_at: '2030-01-01T00:00:00.000Z',
      workload: 'session',
      harness: 'opencode',
      repository: { url: 'https://api.test/repo.git', branch: 'session', base_ref: 'main' },
      secrets_revision: 'rev-1',
      ports: [8000],
      writable_roots: ['/workspace'],
      env: {},
    })
    const apply = JSON.parse(socket.sent[1]!)
    expect(apply).toMatchObject({ type: 'assignment.apply', stream_id: assignmentId, seq: 0 })
    await hub.message(socket, signed({ v: 1, type: 'assignment.accept', stream_id: assignmentId, seq: 0, status: 'starting' }, key, 1))
    await hub.message(socket, signed({ v: 1, type: 'assignment.ready', stream_id: assignmentId, seq: 1, ports: [8000] }, key, 2))
    expect((await readyPromise).ports).toEqual([8000])
    hub.stopAssignment('node-1', assignmentId, 'release')
    expect(JSON.parse(socket.sent.at(-1)!)).toMatchObject({ type: 'assignment.stop', seq: 1, reason: 'release' })
    await hub.message(socket, signed({ v: 1, type: 'assignment.stopped', stream_id: assignmentId, seq: 2, reason: 'release' }, key, 3))
    expect(events).toEqual(['accepted', 'ready', 'stopped'])
  })
})
