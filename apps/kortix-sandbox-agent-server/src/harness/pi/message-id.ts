/**
 * pi's session and message ids. Message ids use the platform codec,
 * `@kortix/sdk/wire-message-id` (packages/sdk/src/core/session/wire-message-id.ts,
 * import-free): kortixd reaches that one file through a tsconfig path and the
 * Dockerfiles copy it, so there is no second implementation of the format.
 *
 * The id IS the transcript's sort key today. The web client splits messages
 * into "placed by the server" and "local to this tab" with `/^msg_[0-9a-f]{12}/`
 * (`compareMessagesForDisplay`, packages/sdk `core/turns/grouping.ts`) and
 * sorts every local one AFTER every placed one, so a reply minted here must
 * carry a real clock and sort strictly after the user message it answers.
 *
 * pi mints with no backdate: this box's clock is the clock that persists the
 * message. The SDK backdates by default because a client mints against a box
 * whose clock it does not know.
 */
import { createHash } from 'node:crypto'
import {
  WIRE_MESSAGE_ID,
  mintWireMessageIdAbove,
  wireIdClock,
  wireIdClockDelta,
} from '@kortix/sdk/wire-message-id'

/** One pi root per session, deterministic: a restart resolves the same id. */
export function mintRootId(sessionId: string): string {
  const digest = createHash('sha256').update(`pi-root\0${sessionId}`).digest('hex')
  return `ses_pi${digest.slice(0, 24)}`
}

/** A child session id: same shape as the root's, unique per (root, minted message id). */
export function mintChildId(rootId: string, nonce: string): string {
  const digest = createHash('sha256').update(`pi-child\0${rootId}\0${nonce}`).digest('hex')
  return `ses_pi${digest.slice(0, 24)}`
}

/** `msg_` + 12 lowercase hex clock chars + 14 base62 chars. */
export const MESSAGE_ID = WIRE_MESSAGE_ID

/**
 * Session-scoped minter: every id it returns sorts after every id it has seen.
 * Every ordering compare is on the 48-bit ring (`wireIdClockDelta`), never `>`.
 */
export class MessageIdClock {
  private newest: bigint | null = null

  /** Advance past an externally supplied or restored id. */
  observe(id: string | null | undefined): void {
    const time = wireIdClock(id)
    if (time !== null && (this.newest === null || wireIdClockDelta(time, this.newest) > BigInt(0))) this.newest = time
  }

  mint(nowMs: number = Date.now()): string {
    const minted = mintWireMessageIdAbove({ nowMs, newestKnownTime: this.newest, backdateMs: 0 })
    this.newest = minted.time
    return minted.id
  }
}
