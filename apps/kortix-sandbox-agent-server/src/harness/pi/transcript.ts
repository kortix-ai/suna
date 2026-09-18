/**
 * The wire transcript: `/session/:id/message` and `/kortix/opencode/messages`
 * serve exactly what `/events` said.
 *
 * ONE SOURCE OF TRUTH for list AND stream: every wire event the adapter emits
 * is (a) sequenced onto the bus and (b) applied here, so the two can never
 * disagree on a message id or a part's final text.
 */
export type WireFrame = { type: string; properties: Record<string, unknown> }

export type WireMessage = { info: Record<string, unknown>; parts: Array<Record<string, unknown>> }

interface StoredMessage {
  info: Record<string, unknown> & { id: string }
  parts: Map<string, Record<string, unknown>>
  order: string[]
}

export class WireTranscript {
  private readonly messages = new Map<string, StoredMessage>()
  private order: string[] = []

  apply(wire: WireFrame): void {
    if (wire.type === 'message.updated') {
      const info = wire.properties.info as (Record<string, unknown> & { id?: string }) | undefined
      if (!info?.id) return
      const existing = this.messages.get(info.id)
      if (existing) {
        existing.info = { ...existing.info, ...info, id: info.id }
        return
      }
      this.messages.set(info.id, { info: { ...info, id: info.id }, parts: new Map(), order: [] })
      this.order.push(info.id)
      this.order.sort()
      return
    }
    if (wire.type === 'message.part.updated') {
      const part = wire.properties.part as
        | (Record<string, unknown> & { id?: string; messageID?: string; sessionID?: string })
        | undefined
      if (!part?.id || !part.messageID) return
      let message = this.messages.get(part.messageID)
      if (!message) {
        // A part can outrun its message frame on a hot stream — hold the slot.
        message = {
          info: { id: part.messageID, role: 'assistant', sessionID: part.sessionID },
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
    if (wire.type === 'message.removed') {
      const id = wire.properties.messageID as string | undefined
      if (!id) return
      this.messages.delete(id)
      this.order = this.order.filter((x) => x !== id)
      return
    }
    if (wire.type === 'message.part.removed') {
      const id = wire.properties.messageID as string | undefined
      const partId = wire.properties.partID as string | undefined
      if (!id || !partId) return
      const message = this.messages.get(id)
      if (!message) return
      message.parts.delete(partId)
      message.order = message.order.filter((x) => x !== partId)
    }
  }

  messageById(id: string): WireMessage | null {
    const m = this.messages.get(id)
    if (!m) return null
    return { info: m.info, parts: m.order.map((pid) => m.parts.get(pid)!).filter(Boolean) }
  }

  /** Oldest-first page ending at `before` (exclusive), like OpenCode's list. */
  page(opts: { limit: number; before: string | null }): { messages: WireMessage[]; hasMore: boolean } {
    const eligible = opts.before ? this.order.filter((id) => id < (opts.before as string)) : this.order
    const window = eligible.slice(-opts.limit)
    return {
      messages: window.map((id) => this.messageById(id)!),
      hasMore: eligible.length > window.length,
    }
  }

  all(): WireMessage[] {
    return this.order.map((id) => this.messageById(id)!)
  }

  get count(): number {
    return this.order.length
  }

  /** The newest user message id, or null. */
  newestUserId(): string | null {
    for (let i = this.order.length - 1; i >= 0; i--) {
      const m = this.messages.get(this.order[i]!)
      if (m?.info.role === 'user') return m.info.id
    }
    return null
  }

  /** Replace the store from a persisted dump (restart restore). */
  load(messages: WireMessage[]): void {
    this.messages.clear()
    this.order = []
    for (const message of messages) {
      const id = message.info.id
      if (typeof id !== 'string') continue
      const stored: StoredMessage = { info: { ...message.info, id }, parts: new Map(), order: [] }
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
