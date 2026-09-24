/**
 * Client-side message ids in OpenCode's wire format.
 *
 * Mirrors `mintPromptMessageId` in
 * packages/sdk/src/react/use-opencode-sessions/messages.ts, which the SDK does
 * not export for this host (it reads the SDK's browser sync store). The frozen
 * contract is tests/spec/wire-message-id.vectors.json:
 * `msg_` + the low 48 bits of (clockMs * 0x1000) as 12 lowercase hex chars +
 * 14 random base62 chars. The clock is backdated by 2 min, then lifted to one
 * above the newest wire id already in the transcript, within a 1 h bound.
 *
 * The session thread sorts messages by this id as a string. An optimistic id
 * in any other format that still matches `msg_` + 12 hex digits sorts against
 * real ids by accident.
 */

const WIRE_ID_TIME_MASK = BigInt(0xffffffffffff);
const WIRE_ID_TIME_SCALE = BigInt(0x1000);
const MAX_WIRE_ID_CLOCK_CORRECTION = BigInt(60 * 60 * 1000) * WIRE_ID_TIME_SCALE;
const CLOCK_SKEW_BACKDATE_MS = 2 * 60 * 1000;
const WIRE_MESSAGE_ID_TIME = /^msg_([0-9a-f]{12})[0-9A-Za-z]{14}$/;
const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

export function mintWireMessageId({
  nowMs,
  knownMessageIds,
}: {
  nowMs: number;
  knownMessageIds: readonly string[];
}): string {
  let encoded = (BigInt(nowMs - CLOCK_SKEW_BACKDATE_MS) * WIRE_ID_TIME_SCALE) & WIRE_ID_TIME_MASK;
  const ceiling = encoded + MAX_WIRE_ID_CLOCK_CORRECTION;

  let newest: bigint | null = null;
  for (const id of knownMessageIds) {
    const match = WIRE_MESSAGE_ID_TIME.exec(id);
    if (!match) continue;
    const time = BigInt(`0x${match[1]}`);
    if (time > ceiling) continue;
    if (newest === null || time > newest) newest = time;
  }
  if (newest !== null && newest >= encoded) encoded = newest + BigInt(1);
  encoded &= WIRE_ID_TIME_MASK;

  let random = '';
  for (let i = 0; i < 14; i++) random += BASE62[Math.floor(Math.random() * 62)];
  return `msg_${encoded.toString(16).padStart(12, '0')}${random}`;
}
