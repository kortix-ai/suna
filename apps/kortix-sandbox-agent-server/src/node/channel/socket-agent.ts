import { NODE_CHANNEL_MAX_FRAME_BYTES, NODE_CHANNEL_MAX_SOCKET_MESSAGE_BYTES, type NodeChannelFrame } from '@kortix/api-contract/node-channel'
import type { PortPolicy } from './stream-agent'

interface SocketState {
  socket: WebSocket
  receiveSeq: number
  sendSeq: number
  opened: boolean
  queue: Array<{ data: Uint8Array; binary: boolean }>
  receiveChunks: Buffer[]
  receiveBytes: number
  receiveBinary?: boolean
}

type SocketFactory = (url: string, headers: Record<string, string>) => WebSocket
const CHUNK_BYTES = Math.floor((NODE_CHANNEL_MAX_FRAME_BYTES - 2048) * 3 / 4)

function closeCode(code: number): number {
  return code >= 1000 && code <= 4999 && ![1004, 1005, 1006, 1015].includes(code) ? code : 4500
}

/** Relays WebSocket messages between the API channel and an authorized loopback port. */
export class NodeSocketAgent {
  private readonly sockets = new Map<string, SocketState>()

  constructor(
    private readonly send: (frame: NodeChannelFrame) => void,
    private readonly allowedPorts: PortPolicy,
    private readonly socketFactory: SocketFactory = (url, headers) => new WebSocket(url, { headers } as never),
  ) {}

  handle(frame: NodeChannelFrame): boolean {
    if (!frame.type.startsWith('socket.')) return false
    if (frame.type === 'socket.open') {
      if (this.sockets.has(frame.stream_id)) throw new Error('Duplicate node socket')
      if (!this.allowedPorts.has(frame.port)) {
        this.send({ v: 1, type: 'socket.close', stream_id: frame.stream_id, seq: 0, code: 4403, reason: `Port ${frame.port} is not authorized` })
        return true
      }
      const socket = this.socketFactory(`ws://127.0.0.1:${frame.port}${frame.path}`, Object.fromEntries(frame.headers))
      socket.binaryType = 'arraybuffer'
      const state: SocketState = { socket, receiveSeq: 1, sendSeq: 0, opened: false, queue: [], receiveChunks: [], receiveBytes: 0 }
      this.sockets.set(frame.stream_id, state)
      socket.addEventListener('open', () => {
        state.opened = true
        this.emit(frame.stream_id, state, { v: 1, type: 'socket.opened', stream_id: frame.stream_id, seq: 0 })
        for (const item of state.queue.splice(0)) socket.send(item.binary ? item.data : Buffer.from(item.data).toString('utf8'))
      })
      socket.addEventListener('message', (event) => {
        const binary = typeof event.data !== 'string'
        const bytes = binary ? Buffer.from(event.data as ArrayBuffer) : Buffer.from(event.data)
        if (bytes.byteLength === 0) {
          this.emit(frame.stream_id, state, { v: 1, type: 'socket.data', stream_id: frame.stream_id, seq: 0, data: '', binary, fin: true })
          return
        }
        for (let offset = 0; offset < bytes.byteLength; offset += CHUNK_BYTES) {
          const chunk = bytes.subarray(offset, offset + CHUNK_BYTES)
          this.emit(frame.stream_id, state, { v: 1, type: 'socket.data', stream_id: frame.stream_id, seq: 0, data: chunk.toString('base64'), binary, fin: offset + chunk.byteLength === bytes.byteLength })
        }
      })
      socket.addEventListener('close', (event) => {
        this.emit(frame.stream_id, state, { v: 1, type: 'socket.close', stream_id: frame.stream_id, seq: 0, code: closeCode(event.code), reason: event.reason.slice(0, 123) })
        this.sockets.delete(frame.stream_id)
      })
      socket.addEventListener('error', () => {
        if (this.sockets.has(frame.stream_id)) this.emit(frame.stream_id, state, { v: 1, type: 'socket.close', stream_id: frame.stream_id, seq: 0, code: 4502, reason: 'loopback websocket error' })
        this.sockets.delete(frame.stream_id)
      })
      return true
    }

    const state = this.sockets.get(frame.stream_id)
    if (!state) throw new Error('Unknown node socket')
    if (frame.seq !== state.receiveSeq) throw new Error(`Invalid node socket sequence: expected ${state.receiveSeq}, received ${frame.seq}`)
    state.receiveSeq++
    if (frame.type === 'socket.data') {
      const bytes = Buffer.from(frame.data, 'base64')
      if (state.receiveBinary !== undefined && state.receiveBinary !== frame.binary) throw new Error('Node socket message type changed between fragments')
      state.receiveBinary = frame.binary
      state.receiveChunks.push(bytes)
      state.receiveBytes += bytes.byteLength
      if (state.receiveBytes > NODE_CHANNEL_MAX_SOCKET_MESSAGE_BYTES) throw new Error('Node socket message exceeds limit')
      if (frame.fin) {
        const message = Buffer.concat(state.receiveChunks, state.receiveBytes)
        const binary = state.receiveBinary
        state.receiveChunks = []
        state.receiveBytes = 0
        state.receiveBinary = undefined
        if (state.opened) state.socket.send(binary ? message : message.toString('utf8'))
        else state.queue.push({ data: message, binary: Boolean(binary) })
      }
    } else if (frame.type === 'socket.close') {
      state.socket.close(closeCode(frame.code), frame.reason)
      this.sockets.delete(frame.stream_id)
    } else {
      throw new Error(`Unexpected API socket frame ${frame.type}`)
    }
    return true
  }

  disconnect(): void {
    for (const state of this.sockets.values()) state.socket.close(1012, 'node channel disconnected')
    this.sockets.clear()
  }

  private emit(streamId: string, state: SocketState, frame: NodeChannelFrame): void {
    frame.stream_id = streamId
    frame.seq = state.sendSeq++
    this.send(frame)
  }
}
