/**
 * The OpenCode wire message-id clock, server side.
 *
 * OpenCode resolves "has this prompt already been answered?" by ID ORDER: a
 * user message whose id sorts below the assistant replies already on record is
 * read as answered, and its turn never runs. So an id that goes on the wire is
 * not a name — it is a position, and minting one wrongly silently drops the
 * prompt.
 *
 * WHY THIS IS NOT IMPORTED FROM `@kortix/sdk` (a deliberate deviation from the
 * repo's "logic lives in the SDK" rule): `apps/api` has no `@kortix/sdk`
 * dependency, and the SDK's minter reads the browser sync store for the
 * session's newest known id — a thing that does not exist in this process.
 * Adding a browser package as an API dependency to share ~25 lines of
 * arithmetic is the wrong trade. The contract is held instead by the shared
 * golden-vector fixture `tests/spec/wire-message-id.vectors.json`, asserted by
 * BOTH `wire-message-id.test.ts` here and
 * `packages/sdk/src/react/use-opencode-sessions/messages.test.ts`. A divergence
 * fails two suites, not zero.
 *
 * Only the REDELIVERY path mints here. A first delivery carries the id the
 * client minted, verbatim (see `session-lifecycle/store.ts`'s
 * `wireMessageId`), because the client is the one holding the transcript.
 */

/** OpenCode keeps the low 6 bytes of its id clock, so the field wraps ~every 2.2y. */
export const WIRE_ID_TIME_MASK = BigInt(0xffffffffffff);
/** Sub-millisecond slots per millisecond in that clock (`Date.now() * 0x1000`). */
export const WIRE_ID_TIME_SCALE = BigInt(0x1000);
/**
 * Ceiling on the correction taken from the session's own transcript: 1h of
 * clock. Large enough to absorb any realistic control-plane-vs-sandbox skew,
 * small enough that one wrapped or malformed id cannot drag every later id
 * weeks into the future.
 */
export const MAX_WIRE_ID_CLOCK_CORRECTION = BigInt(60 * 60 * 1000) * WIRE_ID_TIME_SCALE;
/**
 * How far back to date a mint before the transcript lift places it.
 *
 * Same asymmetry the SDK documents: too EARLY is self-correcting (the lift
 * raises the id above everything already on record), too LATE is undetectable
 * downstream. So never trust this pod's clock forward.
 */
export const WIRE_ID_BACKDATE_MS = 2 * 60 * 1000;

/** `msg_` + 12 lowercase hex clock chars + 14 base62 chars. */
export const WIRE_MESSAGE_ID = /^msg_[0-9a-f]{12}[A-Za-z0-9]{14}$/;

const WIRE_MESSAGE_ID_TIME = /^msg_([0-9a-f]{12})/;
const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/** Decode the ordering clock out of an OpenCode wire message id, or null. */
export function wireIdTime(messageId: string): bigint | null {
  const match = WIRE_MESSAGE_ID_TIME.exec(messageId ?? '');
  if (!match) return null;
  return BigInt(`0x${match[1]}`);
}

/** The highest id-clock value in a list of transcript message ids, or null. */
export function newestWireIdTime(messageIds: Iterable<string | null | undefined>): bigint | null {
  let newest: bigint | null = null;
  for (const id of messageIds) {
    const encoded = wireIdTime(id ?? '');
    if (encoded === null) continue;
    if (newest === null || encoded > newest) newest = encoded;
  }
  return newest;
}

/**
 * Mint an id that sorts strictly after `newestKnownTime`. Pure — the caller
 * supplies the clock and the randomness, which is what makes the golden
 * vectors assertable.
 */
export function mintWireMessageId(input: {
  nowMs: number;
  newestKnownTime?: bigint | null;
  random?: () => number;
}): { id: string; time: bigint } {
  const random = input.random ?? Math.random;
  let encoded =
    (BigInt(Math.trunc(input.nowMs) - WIRE_ID_BACKDATE_MS) * WIRE_ID_TIME_SCALE) &
    WIRE_ID_TIME_MASK;
  const newest = input.newestKnownTime ?? null;
  if (newest !== null && newest >= encoded && newest - encoded <= MAX_WIRE_ID_CLOCK_CORRECTION) {
    encoded = newest + BigInt(1);
  }
  encoded &= WIRE_ID_TIME_MASK;

  let tail = '';
  for (let i = 0; i < 14; i++) tail += BASE62[Math.min(61, Math.floor(random() * 62))];
  return { id: `msg_${encoded.toString(16).padStart(12, '0')}${tail}`, time: encoded };
}
