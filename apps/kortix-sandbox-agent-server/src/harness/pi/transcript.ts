/**
 * The session transcript: `/kortix/runtime/messages` (and the compatibility
 * `/session/:id/message`) serve exactly what `/events` said.
 *
 * ONE SOURCE OF TRUTH for list AND stream: every event the runtime emits is
 * (a) sequenced onto the bus and (b) applied here, so the two can never
 * disagree on a message id or a part's final text.
 */
import type {
  KortixMessage,
  KortixMessageInfo,
  KortixPart,
  KortixSessionEvent,
} from '@kortix/api-contract/transcript'

/**
 * A frame on the daemon bus: a Kortix session event, or one of the session
 * tree events the SDK reads beside them (a subagent's child session).
 */
export type RuntimeFrame =
  | KortixSessionEvent
  | { type: 'session.created' | 'session.updated'; properties: { sessionID: string; info: Record<string, unknown> } }

interface StoredMessage {
  info: KortixMessageInfo
  parts: Map<string, KortixPart>
  order: string[]
}

export class TranscriptStore {
  private readonly messages = new Map<string, StoredMessage>()
  private order: string[] = []

  apply(frame: RuntimeFrame): void {
    if (frame.type === 'message.updated') {
      const info = frame.properties.info
      if (!info?.id) return
      const existing = this.messages.get(info.id)
      if (existing) {
        existing.info = { ...existing.info, ...info } as KortixMessageInfo
        return
      }
      this.messages.set(info.id, { info, parts: new Map(), order: [] })
      this.order.push(info.id)
      this.order.sort()
      return
    }
    if (frame.type === 'message.part.updated') {
      const part = frame.properties.part
      if (!part?.id || !part.messageID) return
      let message = this.messages.get(part.messageID)
      if (!message) {
        // A part can outrun its message frame on a hot stream — hold the slot
        // with the fields a part names; the message frame fills in the rest.
        message = {
          info: { id: part.messageID, role: 'assistant', sessionID: part.sessionID } as KortixMessageInfo,
          parts: new Map(),
          order: [],
        }
        this.messages.set(part.messageID, message)
        this.order.push(part.messageID)
        this.order.sort()
      }
      if (!message.parts.has(part.id)) message.order.push(part.id)
      message.parts.set(part.id, part)
      return
    }
    if (frame.type === 'message.removed') {
      const id = frame.properties.messageID
      if (!id) return
      this.messages.delete(id)
      this.order = this.order.filter((x) => x !== id)
      return
    }
    if (frame.type === 'message.part.removed') {
      const { messageID: id, partID: partId } = frame.properties
      if (!id || !partId) return
      const message = this.messages.get(id)
      if (!message) return
      message.parts.delete(partId)
      message.order = message.order.filter((x) => x !== partId)
    }
  }

  messageById(id: string): KortixMessage | null {
    const m = this.messages.get(id)
    if (!m) return null
    return { info: m.info, parts: m.order.map((pid) => m.parts.get(pid)!).filter(Boolean) }
  }

  /** Oldest-first page ending at `before` (exclusive), like OpenCode's list. */
  page(opts: { limit: number; before: string | null }): { messages: KortixMessage[]; hasMore: boolean } {
    const eligible = opts.before ? this.order.filter((id) => id < (opts.before as string)) : this.order
    const window = eligible.slice(-opts.limit)
    return {
      messages: window.map((id) => this.messageById(id)!),
      hasMore: eligible.length > window.length,
    }
  }

  all(): KortixMessage[] {
    return this.order.map((id) => this.messageById(id)!)
  }

  get count(): number {
    return this.order.length
  }

  /** Replace the store from a persisted dump (restart restore). */
  load(messages: KortixMessage[]): void {
    this.messages.clear()
    this.order = []
    for (const message of messages) {
      const id = message.info.id
      if (typeof id !== 'string') continue
      const stored: StoredMessage = { info: message.info, parts: new Map(), order: [] }
      for (const part of message.parts) {
        const pid = part.id
        if (typeof pid !== 'string') continue
        stored.parts.set(pid, part)
        stored.order.push(pid)
      }
      this.messages.set(id, stored)
      this.order.push(id)
    }
    this.order.sort()
  }
}
