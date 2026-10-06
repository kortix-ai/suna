// Session and message ids, exactly as kortixd's pi harness mints them
// (apps/kortix-sandbox-agent-server/src/harness/pi/message-id.ts), so a cell
// is indistinguishable from a kortixd pi box to the API and the SDK:
//
//  - the root id is deterministic per Kortix session, so a session pinned on a
//    kortixd pi box resolves to the same root on a cell and the reverse;
//  - message ids use the platform codec (`@kortix/sdk/wire-message-id`, an
//    import-free file), reached by path because the cell is not a workspace
//    package. There is no second implementation of the format.
import {
  WIRE_MESSAGE_ID,
  mintWireMessageIdAbove,
  wireIdClock,
  wireIdClockDelta,
} from "../../../../packages/sdk/src/core/session/wire-message-id.ts";

export const MESSAGE_ID = WIRE_MESSAGE_ID;

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** One pi root per session: `ses_pi` + 24 hex of sha256("pi-root\0" + session). */
export async function mintRootId(sessionId) {
  return `ses_pi${(await sha256Hex(`pi-root\0${sessionId}`)).slice(0, 24)}`;
}

/** A subagent child's session id: kortixd's `mintChildId` (harness/pi/message-id.ts), byte for byte. */
export async function mintChildId(rootId, nonce) {
  return `ses_pi${(await sha256Hex(`pi-child\0${rootId}\0${nonce}`)).slice(0, 24)}`;
}

/** A root id has this shape; a request path that carries one names its cell. */
export const ROOT_ID = /^ses_pi[0-9a-f]{24}$/;

/**
 * Session-scoped minter: every id it returns sorts after every id it has seen.
 * Compares on the 48-bit ring (`wireIdClockDelta`), never with `>`. No
 * backdate: this cell's clock is the clock that persists the message.
 */
export class MessageIdClock {
  newest = null;

  /** Advance past an externally supplied or restored id. */
  observe(id) {
    const time = wireIdClock(id);
    if (time !== null && (this.newest === null || wireIdClockDelta(time, this.newest) > 0n)) this.newest = time;
  }

  mint(nowMs = Date.now()) {
    const minted = mintWireMessageIdAbove({ nowMs, newestKnownTime: this.newest, backdateMs: 0 });
    this.newest = minted.time;
    return minted.id;
  }
}
