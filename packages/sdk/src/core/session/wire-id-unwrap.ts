/**
 * The UNWRAPPED wire-id clock — internal, not exported from any entry point.
 *
 * `core/turns/grouping.ts` orders messages for display on an absolute clock:
 * each placed id is unwrapped against its own `time.created`, so two messages
 * keep their true order even when their `created` stamps disagree with the
 * ring distance between their ids. Every other caller orders on the ring with
 * `wireIdClockDelta` (`./wire-message-id`) and never needs an absolute clock.
 *
 * Kept out of `wire-message-id.ts` so that module stays import-free and its
 * published subpath carries only the names a host needs.
 */

import { WIRE_ID_TIME_MASK, WIRE_ID_TIME_SCALE } from './wire-message-id';

const WIRE_ID_TIME_SPAN = WIRE_ID_TIME_MASK + BigInt(1);
const HALF_SPAN = WIRE_ID_TIME_SPAN / BigInt(2);

/** The unmasked id clock of wall-clock instant `ms`. */
export function absoluteWireIdClockAt(ms: number): bigint {
  return BigInt(Math.trunc(ms)) * WIRE_ID_TIME_SCALE;
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
