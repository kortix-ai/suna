/**
 * The text of every OPEN text/reasoning part, as streamed so far.
 *
 * OpenCode 1.18 does not persist text deltas: an open text or reasoning part is
 * saved EMPTY (`time.start` set, no `time.end`) and its whole text is written
 * once, when the part ends. Every transcript read of an open step therefore
 * returned the step's answer as `''`. A browser that reloaded mid-step lost
 * the words it had just watched stream in until the step finished — minutes,
 * when tools run after the text.
 *
 * The daemon already observes every delta: `boot.ts` feeds each OpenCode
 * `/event` frame here beside the event bus. This module keeps the accumulated
 * text per open part, and the proxied transcript list (`proxy.ts`) overlays it
 * onto parts OpenCode persisted shorter. The overlay only ever EXTENDS
 * persisted text (a strict prefix match), never replaces it, and never touches
 * an ended part — those are complete on disk.
 *
 * Bounded and forgetful by design. The text is a read-side convenience, not a
 * record: an entry leaves when its part ends, its message completes or its
 * session goes idle, at most {@link OPEN_PART_TEXT_MAX_PARTS} are held, and a
 * (re)subscribed event stream clears everything because it may have missed
 * deltas — a gapped text is worse than none.
 */

/** Open parts held at once. A turn streams one or two at a time. */
export const OPEN_PART_TEXT_MAX_PARTS = 64

/** Characters kept per part. Past this the entry stops overlaying at all. */
export const OPEN_PART_TEXT_MAX_CHARS = 2_000_000

interface Entry {
  sessionID: string | null
  messageID: string | null
  text: string
  /** Hit {@link OPEN_PART_TEXT_MAX_CHARS}: the text is incomplete, never served. */
  overflow: boolean
}

type EventLike = { type?: string; properties?: unknown }

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function isTextLike(type: unknown): boolean {
  return type === 'text' || type === 'reasoning'
}

function ended(part: Record<string, unknown>): boolean {
  const end = record(part.time)?.end
  return typeof end === 'number' && end > 0
}

export class OpenPartText {
  /** Insertion order is recency: a write re-inserts its key at the end. */
  private readonly parts = new Map<string, Entry>()

  get size(): number {
    return this.parts.size
  }

  clear(): void {
    this.parts.clear()
  }

  /** One OpenCode `/event` frame. Never throws. */
  noteEvent(event: EventLike): void {
    try {
      this.apply(event)
    } catch {
      // A malformed frame must never reach the event fan-out that called us.
    }
  }

  /**
   * Extend the open text/reasoning parts of a transcript list (OpenCode's
   * `GET /session/:id/message` body) in place. Returns how many parts changed.
   */
  overlay(body: unknown): number {
    if (!Array.isArray(body) || this.parts.size === 0) return 0
    let changed = 0
    for (const message of body) {
      const parts = record(message)?.parts
      if (!Array.isArray(parts)) continue
      for (const raw of parts) {
        const part = record(raw)
        if (!part || !isTextLike(part.type) || ended(part)) continue
        const id = str(part.id)
        const entry = id ? this.parts.get(id) : undefined
        if (!entry || entry.overflow) continue
        const persisted = str(part.text) ?? ''
        if (entry.text.length > persisted.length && entry.text.startsWith(persisted)) {
          part.text = entry.text
          changed += 1
        }
      }
    }
    return changed
  }

  private apply(event: EventLike): void {
    const props = record(event?.properties)
    if (!props) return
    switch (event.type) {
      case 'message.part.delta': {
        if (props.field !== 'text') return
        const partID = str(props.partID)
        const delta = str(props.delta)
        if (!partID || delta === null) return
        // Only a part seen STARTING (its `message.part.updated` snapshot) is
        // tracked. A delta for any other part — after a resubscribe, or an
        // eviction — lacks the part's beginning and would be served as if it
        // were the whole text.
        const entry = this.parts.get(partID)
        if (!entry) return
        if (!entry.overflow) {
          if (entry.text.length + delta.length > OPEN_PART_TEXT_MAX_CHARS) {
            entry.overflow = true
            entry.text = ''
          } else {
            entry.text += delta
          }
        }
        this.touch(partID, entry)
        return
      }
      case 'message.part.updated': {
        const part = record(props.part)
        const partID = part ? str(part.id) : null
        if (!part || !partID || !isTextLike(part.type)) return
        if (ended(part)) {
          this.parts.delete(partID)
          return
        }
        const text = str(part.text) ?? ''
        const entry = this.parts.get(partID)
        if (!entry) {
          this.touch(partID, {
            sessionID: str(part.sessionID) ?? str(props.sessionID),
            messageID: str(part.messageID),
            text,
            overflow: false,
          })
        } else if (!entry.overflow && text.length > entry.text.length && text.startsWith(entry.text)) {
          entry.text = text
        }
        return
      }
      case 'message.part.removed': {
        const partID = str(props.partID)
        if (partID) this.parts.delete(partID)
        return
      }
      case 'message.updated': {
        const info = record(props.info)
        const completed = record(info?.time)?.completed
        const messageID = info ? str(info.id) : null
        if (messageID && typeof completed === 'number') this.dropWhere((e) => e.messageID === messageID)
        return
      }
      case 'session.idle':
      case 'session.error': {
        const sessionID = str(props.sessionID)
        if (sessionID) this.dropWhere((e) => e.sessionID === sessionID)
        return
      }
      case 'session.status': {
        const sessionID = str(props.sessionID)
        if (sessionID && record(props.status)?.type === 'idle') this.dropWhere((e) => e.sessionID === sessionID)
        return
      }
    }
  }

  private touch(partID: string, entry: Entry): void {
    this.parts.delete(partID)
    this.parts.set(partID, entry)
    while (this.parts.size > OPEN_PART_TEXT_MAX_PARTS) {
      const oldest = this.parts.keys().next().value
      if (oldest === undefined) break
      this.parts.delete(oldest)
    }
  }

  private dropWhere(match: (entry: Entry) => boolean): void {
    for (const [id, entry] of this.parts) if (match(entry)) this.parts.delete(id)
  }
}

let store: OpenPartText | null = null

/** The daemon's one store — fed by `boot.ts`, read by `proxy.ts`. */
export function openPartText(): OpenPartText {
  if (!store) store = new OpenPartText()
  return store
}
