/**
 * OpenCode wire message ids — `msg_` + a 12-hex-char clock + 14 base62 chars.
 *
 * The id IS the transcript's sort key. The web client splits messages into
 * "placed by the server" and "local to this tab" with `/^msg_[0-9a-f]{12}/`
 * (`compareMessagesForDisplay`, packages/sdk `core/turns/grouping.ts`) and
 * sorts every local one AFTER every placed one, so a reply minted here must
 * carry a real clock and sort strictly after the user message it answers.
 *
 * Mirrors apps/api/src/projects/wire-message-id.ts. The daemon ships inside
 * the sandbox image and cannot import apps/api, so the codec is duplicated
 * deliberately; `pi-wire-id.test.ts` reads the API's regex off disk and
 * asserts every id minted here satisfies it, so the two cannot drift silently.
 */
import { createHash } from 'node:crypto'

/** One pi root per session, deterministic: a restart resolves the same id. */
export function mintRootId(sessionId: string): string {
  const digest = createHash('sha256').update(`pi-root\0${sessionId}`).digest('hex')
  return `ses_pi${digest.slice(0, 24)}`
}

/** `msg_` + 12 lowercase hex clock chars + 14 base62 chars. */
export const WIRE_MESSAGE_ID = /^msg_[0-9a-f]{12}[A-Za-z0-9]{14}$/

const WIRE_MESSAGE_ID_TIME = /^msg_([0-9a-f]{12})/
const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'

export const WIRE_ID_TIME_MASK = BigInt(0xffffffffffff)
export const WIRE_ID_TIME_SCALE = BigInt(0x1000)
/** Same one-hour correction ceiling as the API and SDK wire-id minters. */
export const MAX_WIRE_ID_CLOCK_CORRECTION = BigInt(60 * 60 * 1000) * WIRE_ID_TIME_SCALE

function wireClockAt(nowMs: number): bigint {
  return (BigInt(Math.trunc(nowMs)) * WIRE_ID_TIME_SCALE) & WIRE_ID_TIME_MASK
}

/** Decode the ordering clock out of a wire message id, or null. */
export function wireIdTime(messageId: string | null | undefined): bigint | null {
  const match = WIRE_MESSAGE_ID_TIME.exec(messageId ?? '')
  if (!match) return null
  return BigInt(`0x${match[1]}`)
}

/**
 * Mint an id that sorts strictly after `newestKnownTime`.
 *
 * Pure: the caller supplies the clock and the randomness, which is what makes
 * the format assertable without stubbing globals.
 */
export function mintWireMessageId(input: {
  nowMs: number
  newestKnownTime?: bigint | null
  random?: () => number
}): { id: string; time: bigint } {
  const random = input.random ?? Math.random
  let encoded = wireClockAt(input.nowMs)
  const newest = input.newestKnownTime ?? null
  if (newest === WIRE_ID_TIME_MASK) throw new Error('wire message id ordering clock is exhausted')
  if (
    newest !== null &&
    newest >= encoded &&
    newest < WIRE_ID_TIME_MASK &&
    newest - encoded <= MAX_WIRE_ID_CLOCK_CORRECTION
  ) {
    encoded = newest + BigInt(1)
  }
  encoded &= WIRE_ID_TIME_MASK
  let tail = ''
  for (let i = 0; i < 14; i++) tail += BASE62[Math.min(61, Math.floor(random() * 62))]
  return { id: `msg_${encoded.toString(16).padStart(12, '0')}${tail}`, time: encoded }
}

/** Session-scoped minter: every id it returns sorts after every id it has seen. */
export class WireIdClock {
  private newest: bigint | null = null

  /** Advance past an externally supplied or restored id. */
  observe(id: string | null | undefined): void {
    const time = wireIdTime(id)
    if (time !== null && (this.newest === null || time > this.newest)) this.newest = time
  }

  mint(nowMs: number = Date.now()): string {
    const minted = mintWireMessageId({ nowMs, newestKnownTime: this.newest })
    this.newest = minted.time
    return minted.id
  }
}
