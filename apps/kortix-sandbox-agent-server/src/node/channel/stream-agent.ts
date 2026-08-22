import { NODE_CHANNEL_MAX_FRAME_BYTES, NODE_CHANNEL_MAX_WINDOW_BYTES, type NodeChannelFrame } from '@kortix/api-contract/node-channel'

type FetchLike = (request: Request) => Promise<Response>
export interface PortPolicy { has(port: number): boolean }
const CHUNK_BYTES = Math.floor((NODE_CHANNEL_MAX_FRAME_BYTES - 2048) * 3 / 4)

interface StreamState {
  receiveSeq: number
  sendSeq: number
  request: ReadableStreamDefaultController<Uint8Array>
  abort: AbortController
  task: Promise<void>
  sendCredit: number
  creditWaiter?: () => void
  requestCreditPending: number
  requestPullPending: boolean
}

export class NodeStreamAgent {
  private readonly streams = new Map<string, StreamState>()
  private readonly tasks = new Set<Promise<void>>()

  constructor(
    private readonly send: (frame: NodeChannelFrame) => void,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly allowedPorts: PortPolicy,
  ) {}

  async handle(frame: NodeChannelFrame): Promise<void> {
    if (frame.type === 'stream.open') {
      if (this.streams.has(frame.stream_id)) throw new Error('Duplicate node stream')
      if (!this.allowedPorts.has(frame.port)) {
        this.send({ v: 1, type: 'stream.cancel', stream_id: frame.stream_id, seq: 0, reason: `Port ${frame.port} is not authorized` })
        return
      }
      let request!: ReadableStreamDefaultController<Uint8Array>
      let state!: StreamState
      const body = new ReadableStream<Uint8Array>({
        start: (controller) => { request = controller },
        pull: () => {
          if (!this.streams.has(frame.stream_id)) return
          if (state.requestCreditPending <= 0) {
            state.requestPullPending = true
            return
          }
          const credit = state.requestCreditPending
          state.requestCreditPending = 0
          state.requestPullPending = false
          this.emit(frame.stream_id, state, { v: 1, type: 'stream.window', stream_id: frame.stream_id, seq: 0, credit })
        },
      }, new ByteLengthQueuingStrategy({ highWaterMark: 0 }))
      state = {
        receiveSeq: 1,
        sendSeq: 0,
        request,
        abort: new AbortController(),
        task: Promise.resolve(),
        sendCredit: frame.window,
        requestCreditPending: 0,
        requestPullPending: false,
      }
      this.streams.set(frame.stream_id, state)
      state.task = this.run(frame, state, body)
      this.tasks.add(state.task)
      void state.task.finally(() => this.tasks.delete(state.task))
      return
    }
    const state = this.streams.get(frame.stream_id)
    if (!state) throw new Error('Unknown node stream')
    if (frame.seq !== state.receiveSeq) throw new Error(`Invalid node stream sequence: expected ${state.receiveSeq}, received ${frame.seq}`)
    state.receiveSeq++
    if (frame.type === 'stream.request') {
      const bytes = Buffer.from(frame.data, 'base64')
      state.request.enqueue(bytes)
      if (state.requestPullPending) {
        state.requestPullPending = false
        this.emit(frame.stream_id, state, { v: 1, type: 'stream.window', stream_id: frame.stream_id, seq: 0, credit: bytes.byteLength })
      } else {
        state.requestCreditPending += bytes.byteLength
      }
    } else if (frame.type === 'stream.request.end') {
      state.request.close()
    } else if (frame.type === 'stream.cancel') {
      state.abort.abort(frame.reason)
      state.request.error(new Error(frame.reason))
      this.streams.delete(frame.stream_id)
      state.creditWaiter?.()
    } else if (frame.type === 'stream.window') {
      state.sendCredit = Math.min(NODE_CHANNEL_MAX_WINDOW_BYTES, state.sendCredit + frame.credit)
      state.creditWaiter?.()
      state.creditWaiter = undefined
    } else {
      throw new Error(`Unexpected API frame ${frame.type}`)
    }
  }

  async idle(): Promise<void> { await Promise.allSettled([...this.tasks]) }

  disconnect(): void {
    for (const state of this.streams.values()) state.abort.abort('node channel disconnected')
    this.streams.clear()
  }

  private async run(open: Extract<NodeChannelFrame, { type: 'stream.open' }>, state: StreamState, body: ReadableStream<Uint8Array>): Promise<void> {
    try {
      const hasBody = open.method !== 'GET' && open.method !== 'HEAD'
      const response = await this.fetchImpl(new Request(`http://127.0.0.1:${open.port}${open.path}`, {
        method: open.method,
        headers: open.headers,
        body: hasBody ? body : undefined,
        duplex: hasBody ? 'half' : undefined,
        signal: state.abort.signal,
      } as RequestInit))
      this.emit(open.stream_id, state, { v: 1, type: 'stream.response', stream_id: open.stream_id, seq: 0, status: response.status, headers: [...response.headers.entries()], window: open.window })
      if (response.body) {
        const reader = response.body.getReader()
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          let offset = 0
          while (offset < value.byteLength) {
            await this.waitForCredit(state)
            if (!this.streams.has(open.stream_id)) throw new Error('Node stream closed while sending response')
            const length = Math.min(CHUNK_BYTES, state.sendCredit, value.byteLength - offset)
            state.sendCredit -= length
            this.emit(open.stream_id, state, { v: 1, type: 'stream.response.data', stream_id: open.stream_id, seq: 0, data: Buffer.from(value.subarray(offset, offset + length)).toString('base64') })
            offset += length
          }
        }
      }
      this.emit(open.stream_id, state, { v: 1, type: 'stream.response.end', stream_id: open.stream_id, seq: 0 })
    } catch (error) {
      if (!state.abort.signal.aborted) this.emit(open.stream_id, state, { v: 1, type: 'stream.cancel', stream_id: open.stream_id, seq: 0, reason: (error instanceof Error ? error.message : String(error)).slice(0, 256) })
    } finally {
      this.streams.delete(open.stream_id)
      state.creditWaiter?.()
      state.creditWaiter = undefined
    }
  }

  private async waitForCredit(state: StreamState): Promise<void> {
    while (state.sendCredit <= 0 && !state.abort.signal.aborted) {
      await new Promise<void>((resolve) => { state.creditWaiter = resolve })
    }
    if (state.abort.signal.aborted) throw new Error(String(state.abort.signal.reason ?? 'Node stream aborted'))
  }

  private emit(streamId: string, state: StreamState, frame: NodeChannelFrame): void {
    frame.stream_id = streamId
    frame.seq = state.sendSeq++
    this.send(frame)
  }
}
