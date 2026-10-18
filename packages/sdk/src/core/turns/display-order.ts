/**
 * Display order and session-list comparators — framework-agnostic.
 *
 * Owns the TOTAL order the transcript sorts by (`compareMessagesForDisplay`)
 * and the session-list helpers (sidebar / tabs). Split out of `grouping.ts`,
 * which keeps turn grouping; `display-order.test.ts` pins the order.
 */

import { WIRE_ID_CLOCK_TOLERANCE, wireIdClock } from '../session/wire-message-id';
import { absoluteWireIdClockAt, unwrapWireIdClock } from '../session/wire-id-unwrap';

/**
 * Display order, as a TOTAL order over two disjoint segments.
 *
 *   1. PLACED — the message has a wire id, so the server has given it a
 *      position. Ordered by that id.
 *   2. LOCAL — an optimistic stub, or a queued inbox row the transcript has
 *      not echoed yet. Ordered by the instant the user sent it, untimed last.
 *
 * Every placed message precedes every local one, because a local placeholder
 * exists precisely because the server has not placed it yet; the moment it is
 * echoed it gains a wire id and moves into segment 1.
 *
 * The wire id is the message's POSITION: OpenCode's own loop resolves "is this
 * answered?" by id order, and every id that reaches the transcript is placed by
 * the control plane (the proxy's wire-id repair lifts a stale client id; the
 * drain re-mints a queued prompt above the live turn). So for wire ids, id
 * order IS conversation order.
 *
 * `time.created` is NOT, which is why it only ever orders segment 2. OpenCode
 * stamps it at PERSISTENCE, from arrival wall-clock. A batch of queued prompts
 * is posted concurrently on purpose (so one step answers them all), and their
 * arrival order is the network's — sorting placed messages by it displayed
 * "B4, FIRST, B2, B3" for a burst the model itself read, and answered, in id
 * order.
 *
 * WHY THE SEGMENTS. This function used to switch ordering per PAIR: wire-id
 * order when both ids were well-formed wire ids, `time.created` for every pair
 * involving anything else. That is not an order at all. Two placed messages A,
 * B and one queued row S whose host-fabricated stamp sat below the box clock
 * compared as A < B (by id), S < A (by time) and B < S (by time) — a cycle.
 * `Array.prototype.sort` may emit any permutation of a cyclic comparator, and
 * V8 switches algorithm with input length, so three prompts sent "who", "are",
 * "you" rendered "who", "you", "are". `groupMessagesIntoTurns` walks the same
 * sorted list to attach assistant messages that carry no `parentID`, so the
 * replies re-parented too, and a queued row could sort ABOVE the whole
 * transcript. Segmenting removes the mixed comparison, and with it the need
 * for any host to fabricate a timestamp to keep a queued row in place.
 *
 * A message with no timestamp AND no wire id (a host's plain stub) sorts last —
 * it is the latest thing the user did — and two such are a TIE, so the stable
 * sort keeps the order the host handed them over in. Equal timestamps keep id
 * order.
 *
 * AN ID IS A POSITION ONLY WHILE IT AGREES WITH ITS OWN CLOCK. The id encodes
 * the low 48 bits of `Date.now() * 0x1000`, so a placed message is ordered by
 * that clock UNWRAPPED against its own `time.created` — which is what keeps a
 * session spanning the 2026-08-14 wrap in order. Every correct mint sits within
 * minutes of its timestamp. An id more than {@link WIRE_ID_CLOCK_TOLERANCE}
 * (1 hour) away from it was not placed by any transcript — `kortix sessions
 * send` minted the HIGH bits, ~40 days ahead, until 2026-09 — and falls back to
 * the server's own order: `time.created`, then id (`MessageV2.page()`). Without
 * this, every turn sent after such a prompt rendered ABOVE it. A placed message
 * with no timestamp (an optimistic stub keyed by a wire id) is unwrapped
 * against the newest timestamp in the list being sorted — the stub is the
 * newest thing the user did — or, compared pairwise, against the current clock.
 */
type DisplayOrdered = { info: { id: string; time?: { created?: number } } };

/** The absolute id clock a placed message is ordered by. */
function placedDisplayClock(message: DisplayOrdered, untimedAnchor: bigint): bigint {
  const clock = wireIdClock(message.info.id) ?? BigInt(0);
  const created = message.info.time?.created;
  if (typeof created !== 'number') return unwrapWireIdClock(clock, untimedAnchor);
  const own = absoluteWireIdClockAt(created);
  const unwrapped = unwrapWireIdClock(clock, own);
  const drift = unwrapped > own ? unwrapped - own : own - unwrapped;
  return drift <= WIRE_ID_CLOCK_TOLERANCE ? unwrapped : own;
}

/** `0` for a message the server has placed, `1` for one only this tab knows. */
function displaySegment(id: string): 0 | 1 {
  return wireIdClock(id) === null ? 1 : 0;
}

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function compareMessagesForDisplay(
  a: { info: { id: string; time?: { created?: number } } },
  b: { info: { id: string; time?: { created?: number } } },
): number {
  return compareForDisplayAt(a, b, absoluteWireIdClockAt(Date.now()));
}

/** The anchor untimed placed ids unwrap against: the list's newest timestamp. */
export function untimedAnchorOf(messages: readonly DisplayOrdered[]): bigint {
  let newest: number | null = null;
  for (const message of messages) {
    const created = message.info.time?.created;
    if (typeof created === 'number' && (newest === null || created > newest)) newest = created;
  }
  return absoluteWireIdClockAt(newest ?? Date.now());
}

export function compareForDisplayAt(a: DisplayOrdered, b: DisplayOrdered, untimedAnchor: bigint): number {
  const segmentA = displaySegment(a.info.id);
  const segmentB = displaySegment(b.info.id);
  if (segmentA !== segmentB) return segmentA - segmentB;

  // Placed: the wire id is the position, and it is the only clock that agrees
  // with the loop that produced the messages.
  if (segmentA === 0) {
    const clockA = placedDisplayClock(a, untimedAnchor);
    const clockB = placedDisplayClock(b, untimedAnchor);
    if (clockA !== clockB) return clockA < clockB ? -1 : 1;
    return compareIds(a.info.id, b.info.id);
  }

  // Local: the send instant is the only record of what the user did, and it is
  // this tab's own clock for both sides, so it is comparable. Untimed last.
  const at = typeof a.info.time?.created === 'number' ? a.info.time.created : null;
  const bt = typeof b.info.time?.created === 'number' ? b.info.time.created : null;
  // Two untimed stubs are a TIE, so the stable sort keeps the order the host
  // handed them over in. That is the only signal left about which came first,
  // and an id tiebreak here would reorder `groupMessagesIntoTurns`' own
  // sequential fallback (`u1`, `a1`, `a2` regrouped as `a1`, `a2`, `u1`).
  if (at === null && bt === null) return 0;
  if (at === null) return 1;
  if (bt === null) return -1;
  if (at !== bt) return at < bt ? -1 : 1;
  return compareIds(a.info.id, b.info.id);
}

// ============================================================================
// Session list helpers (sidebar / tabs)
// ============================================================================

/**
 * Build a map from parent session ID → array of child session IDs.
 * Used to aggregate child session status (permissions, busy) in the sidebar.
 * Matches SolidJS reference `childMapByParent()` in helpers.ts.
 */
export function childMapByParent(
  sessions: ReadonlyArray<{ id: string; parentID?: string }>,
): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const session of sessions) {
    if (!session.parentID) continue;
    const existing = map.get(session.parentID);
    if (existing) {
      existing.push(session.id);
    } else {
      map.set(session.parentID, [session.id]);
    }
  }
  return map;
}

/**
 * Sort comparator for sessions.
 * Two tiers:
 *  1. Sessions updated within `now - 60s` are pinned to top, sorted by ID (stable).
 *  2. Older sessions sorted by `updated` time descending.
 * Matches SolidJS reference `sortSessions()` in helpers.ts.
 */
export function sortSessions(now: number) {
  const oneMinuteAgo = now - 60 * 1000;
  return (
    a: { id: string; time: { updated?: number; created: number } },
    b: { id: string; time: { updated?: number; created: number } },
  ) => {
    const aUpdated = a.time.updated ?? a.time.created;
    const bUpdated = b.time.updated ?? b.time.created;
    const aRecent = aUpdated > oneMinuteAgo;
    const bRecent = bUpdated > oneMinuteAgo;
    if (aRecent && bRecent) return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    if (aRecent && !bRecent) return -1;
    if (!aRecent && bRecent) return 1;
    return bUpdated - aUpdated;
  };
}

/**
 * Recursively collect ALL descendant session IDs for a given parent.
 * Walks the full tree so deeply nested sub-agents are included.
 */
export function allDescendantIds(childMap: Map<string, string[]>, sessionId: string): string[] {
  const directChildren = childMap.get(sessionId);
  if (!directChildren || directChildren.length === 0) return [];
  const result: string[] = [];
  for (const childId of directChildren) {
    result.push(childId);
    result.push(...allDescendantIds(childMap, childId));
  }
  return result;
}
