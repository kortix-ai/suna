import type { NodeChannelFrame } from '@kortix/api-contract/node-channel'
import type { NodeCapabilityHandler } from '../capabilities/types'

interface RpcState {
  receiveSeq: number
  sendSeq: number
  abort: AbortController
}

export class NodeRpcAgent {
  private readonly requests = new Map<string, RpcState>()

  constructor(
    private readonly send: (frame: NodeChannelFrame) => void,
    private readonly methods: ReadonlyMap<string, NodeCapabilityHandler>,
  ) {}

  handle(frame: NodeChannelFrame): boolean {
    if (!frame.type.startsWith('rpc.')) return false
    if (frame.type !== 'rpc.request') throw new Error(`Unexpected API RPC frame ${frame.type}`)
    if (this.requests.has(frame.stream_id)) throw new Error('Duplicate node RPC request')
    const state: RpcState = { receiveSeq: 1, sendSeq: 0, abort: new AbortController() }
    this.requests.set(frame.stream_id, state)
    const handler = this.methods.get(frame.method)
    if (!handler) {
      this.emit(frame.stream_id, state, { v: 1, type: 'rpc.error', stream_id: frame.stream_id, seq: 0, code: -32001, message: `Capability is not registered for method: ${frame.method}` })
      this.requests.delete(frame.stream_id)
      return true
    }
    void handler(frame.params, state.abort.signal)
      .then((result) => this.emit(frame.stream_id, state, { v: 1, type: 'rpc.result', stream_id: frame.stream_id, seq: 0, result }))
      .catch((error) => this.emit(frame.stream_id, state, {
        v: 1,
        type: 'rpc.error',
        stream_id: frame.stream_id,
        seq: 0,
        code: -32003,
        message: (error instanceof Error ? error.message : String(error)).replace(/[\r\n]/g, ' ').slice(0, 1024),
      }))
      .finally(() => this.requests.delete(frame.stream_id))
    return true
  }

  disconnect(): void {
    for (const state of this.requests.values()) state.abort.abort('node channel disconnected')
    this.requests.clear()
  }

  private emit(streamId: string, state: RpcState, frame: NodeChannelFrame): void {
    if (!this.requests.has(streamId)) return
    frame.seq = state.sendSeq++
    this.send(frame)
  }
}
