/**
 * The OpenCode wire message-id clock — framework-free.
 *
 * FORMAT. `msg_` + the LOW 48 bits of `Date.now() * 0x1000` as 12 lowercase
 * hex chars + 14 random base62 chars. OpenCode's own `Identifier.ascending`
 * keeps the low 6 bytes, so the clock wraps every 2^36 ms (~2.2 years); the
 * last wrap was 2026-08-14 11:19:55 UTC.
 *
 * WHY IT MATTERS. A user message's id is its POSITION in the transcript:
 * OpenCode ≤ 1.18.14 decides "has this prompt been answered?" by id order, and
 * every host renders placed messages in id order (`compareMessagesForDisplay`).
 * An id minted from the HIGH bits instead (`kortix sessions send` did this from
 * 2026-08-22 until this module existed) lands ~40 days ahead of every id
 * OpenCode mints itself and renders every later turn above it.
 *
 * The same contract lives in `apps/api/src/projects/wire-message-id.ts` (the
 * API has no `@kortix/sdk` dependency). `tests/spec/wire-message-id.vectors.json`
 * is asserted by both, so a divergence fails two suites.
 */

// `BigInt(0x…)`, not `0x…n`: consumers typecheck this package under targets
// below ES2020, where BigInt literals are a compile error.
const WIRE_ID_TIME_SCALE = BigInt(0x1000);
const WIRE_ID_TIME_MASK = BigInt(0xffffffffffff);
const WIRE_ID_TIME_SPAN = WIRE_ID_TIME_MASK + BigInt(1);
const HALF_SPAN = WIRE_ID_TIME_SPAN / BigInt(2);

/**
 * How far an id's clock may sit from the clock it is compared with and still
 * count as placed by it: 1 hour. Every correct mint is within ~2 minutes of its
 * own server timestamp (the backdate below); the high-bits bug put ids ~40 days
 * out. Shared with the API's `MAX_WIRE_ID_CLOCK_CORRECTION`.
 */
export const WIRE_ID_CLOCK_TOLERANCE = BigInt(60 * 60 * 1000) * WIRE_ID_TIME_SCALE;

/**
 * How far back a mint is dated before any transcript lift places it. Too EARLY
 * is self-correcting (the lift raises it above what is on record); too LATE is
 * undetectable downstream, because the next reply is minted from the box clock
 * and would sort above its own prompt.
 */
export const WIRE_ID_BACKDATE_MS = 2 * 60 * 1000;

const WIRE_ID_CLOCK = /^msg_([0-9a-f]{12})/;
const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/** The 48-bit clock encoded in a wire id, or null when `id` is not one. */
export function wireIdClock(id: string | null | undefined): bigint | null {
  const match = WIRE_ID_CLOCK.exec(id ?? '');
  return match ? BigInt(`0x${match[1]}`) : null;
}

/** The unmasked id clock of wall-clock instant `ms`. */
export function absoluteWireIdClockAt(ms: number): bigint {
  return BigInt(Math.trunc(ms)) * WIRE_ID_TIME_SCALE;
}

/** The 48-bit id clock of wall-clock instant `ms`, as OpenCode writes it. */
export function wireIdClockAt(ms: number): bigint {
  return absoluteWireIdClockAt(ms) & WIRE_ID_TIME_MASK;
}

/**
 * Undo the 48-bit wrap: the absolute clock congruent to `clock` that is
 * nearest to `anchor` (an absolute clock). Two ids unwrapped against anchors
 * within ~1.1 years of each other keep their true order across a wrap.
 */
export function unwrapWireIdClock(clock: bigint, anchor: bigint): bigint {
  const base = anchor - (anchor & WIRE_ID_TIME_MASK);
  let unwrapped = base + clock;
  if (unwrapped - anchor > HALF_SPAN) unwrapped -= WIRE_ID_TIME_SPAN;
  else if (anchor - unwrapped > HALF_SPAN) unwrapped += WIRE_ID_TIME_SPAN;
  return unwrapped;
}

/**
 * Signed distance from `reference` to `clock` on the 48-bit ring: positive
 * when `clock` is ahead. Wrap-safe for distances under ~1.1 years.
 */
function ringDelta(clock: bigint, reference: bigint): bigint {
  let delta = (clock - reference) & WIRE_ID_TIME_MASK;
  if (delta >= HALF_SPAN) delta -= WIRE_ID_TIME_SPAN;
  return delta;
}

/**
 * Whether `id` claims a clock more than {@link WIRE_ID_CLOCK_TOLERANCE} ahead
 * of `nowMs`. Such an id cannot have been placed against any real transcript;
 * a floor or a lift must skip it rather than let it veto every later mint.
 */
export function isWireIdAheadOf(id: string, nowMs: number): boolean {
  const clock = wireIdClock(id);
  if (clock === null) return false;
  return ringDelta(clock, wireIdClockAt(nowMs)) > WIRE_ID_CLOCK_TOLERANCE;
}

/** Options for {@link mintWireMessageId}. */
export interface MintWireMessageIdOptions {
  /** Wall clock to mint at, in ms since epoch. Default: `Date.now()`. */
  nowMs?: number;
  /**
   * Ids already in the transcript. The mint sorts strictly after the newest of
   * them that is within one hour of the clock; ids further ahead than that are
   * ignored, so one bad id cannot drag every later message forward.
   */
  after?: Iterable<string | null | undefined>;
}

/**
 * Mint an OpenCode wire message id for a prompt.
 *
 * Use this — never a hand-rolled `Date.now()` encoding — for the `messageId`
 * of `session.prompts.create()`. It is dated {@link WIRE_ID_BACKDATE_MS} back
 * and lifted just above the newest id in `after`. A caller that cannot read the
 * transcript should also pass `remintOnDelivery: true`, so the control plane
 * places the id against the live transcript before delivery.
 */
export function mintWireMessageId(options: MintWireMessageIdOptions = {}): string {
  const nowMs = options.nowMs ?? Date.now();
  let encoded = wireIdClockAt(nowMs - WIRE_ID_BACKDATE_MS);
  let newest: bigint | null = null;
  for (const id of options.after ?? []) {
    const clock = wireIdClock(id);
    if (clock === null) continue;
    const ahead = ringDelta(clock, encoded);
    if (ahead < BigInt(0) || ahead > WIRE_ID_CLOCK_TOLERANCE) continue;
    if (newest === null || ringDelta(clock, newest) > BigInt(0)) newest = clock;
  }
  if (newest !== null) encoded = (newest + BigInt(1)) & WIRE_ID_TIME_MASK;
  let tail = '';
  for (let i = 0; i < 14; i++) tail += BASE62[Math.floor(Math.random() * 62)];
  return `msg_${encoded.toString(16).padStart(12, '0')}${tail}`;
}
