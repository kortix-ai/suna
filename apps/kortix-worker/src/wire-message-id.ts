/**
 * OpenCode wire message ids — `msg_` + a 12-hex-char clock + 14 base62 chars.
 *
 * WHY THE WORKER CARRIES ITS OWN COPY: this app is standalone by design (its
 * only dependencies are `@earendil-works/pi-*` and `ws` — no workspace
 * packages), so it cannot import `apps/api`'s `projects/wire-message-id.ts`.
 * The format is duplicated deliberately and `wire-message-id.test.ts` reads
 * the API's regex off disk and asserts every id minted here satisfies it, so
 * the two cannot drift silently. Same shape as the daemon/CLI argv contract:
 * where two packages cannot share a constant, the consumer's test reads the
 * producer's.
 *
 * WHAT DEPENDS ON THE FORMAT: the id IS the transcript's sort key. The web
 * client splits messages into "placed by the server" and "local to this tab"
 * with `/^msg_[0-9a-f]{12}/` (`compareMessagesForDisplay`, packages/sdk
 * `core/turns/grouping.ts`) and sorts every local one AFTER every placed one.
 * The worker used to mint `msg_pi00000001`, which fails that test — `p` and
 * `i` are not hex — so every reply this worker produced sorted below the whole
 * transcript, and `groupMessagesIntoTurns` then attached all of them to the
 * LAST user message. Three questions rendered as three bubbles followed by
 * three answers, none under the question it answered.
 *
 * This is the rule the register already carries as "Mint every OpenCode
 * message id with the native sortable codec" (2026-08-22), which cost a
 * production incident on a different surface.
 */

/** `msg_` + 12 lowercase hex clock chars + 14 base62 chars. */
export const WIRE_MESSAGE_ID = /^msg_[0-9a-f]{12}[A-Za-z0-9]{14}$/;

const WIRE_MESSAGE_ID_TIME = /^msg_([0-9a-f]{12})/;
const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/** Mirrors apps/api/src/projects/wire-message-id.ts. */
const WIRE_ID_TIME_MASK = BigInt(0xffffffffffff);
const WIRE_ID_TIME_SCALE = BigInt(0x1000);

/** Decode the ordering clock out of a wire message id, or null. */
export function wireIdTime(messageId: string | null | undefined): bigint | null {
  const match = WIRE_MESSAGE_ID_TIME.exec(messageId ?? '');
  if (!match) return null;
  return BigInt(`0x${match[1]}`);
}

/**
 * Mint an id that sorts strictly after `newestKnownTime`.
 *
 * Pure — the caller supplies the clock and the randomness, which is what makes
 * the format assertable without stubbing globals.
 *
 * Deliberately does NOT backdate the way the API's minter does. That
 * backdating exists so a transcript lift can place a message the API mints
 * ahead of the runtime; a reply minted HERE must sort after the user message
 * that prompted it, and `newestKnownTime` is what guarantees that whatever
 * this box's clock says.
 */
export function mintWireMessageId(input: {
  nowMs: number;
  newestKnownTime?: bigint | null;
  random?: () => number;
}): { id: string; time: bigint } {
  const random = input.random ?? Math.random;
  let encoded = (BigInt(Math.trunc(input.nowMs)) * WIRE_ID_TIME_SCALE) & WIRE_ID_TIME_MASK;

  // A clock that has not moved since the last mint — or that runs behind the
  // message being answered — must still produce a strictly larger id, or two
  // messages tie and the transcript order becomes the sort's tiebreak instead
  // of the conversation's.
  const newest = input.newestKnownTime ?? null;
  if (newest !== null && newest >= encoded) encoded = newest + BigInt(1);
  encoded &= WIRE_ID_TIME_MASK;

  let tail = '';
  for (let i = 0; i < 14; i++) tail += BASE62[Math.min(61, Math.floor(random() * 62))];
  return { id: `msg_${encoded.toString(16).padStart(12, '0')}${tail}`, time: encoded };
}
