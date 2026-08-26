/**
 * The durable server-side transcript mirror.
 *
 * WHY IT EXISTS. `buildSessionTranscriptDigest` proxies the sandbox's OpenCode
 * endpoint, so it can only answer for a RUNNING session. Every other session —
 * stopped, hibernated, still waking — got `unavailable`, and the web route then
 * painted a full-screen "Connecting…" with no transcript for the whole wake
 * (measured 5-240 s) although every message existed. There was no server-side
 * copy to serve, and the browser-side IndexedDB mirror that used to cover the
 * gap was deleted because its freshness test could not observe a turn ENDING.
 *
 * WHERE IT IS WRITTEN, AND WHY THERE. Capture runs at TURN END — the
 * `turn-stream` `end`/`turn_end` relay in `routes/r4.ts`, fire-and-forget,
 * beside the `reconcileForwardedTurnsAtEnd` box read that already happens in
 * that branch. That instant is precisely the one the deleted client mirror
 * could not see, so writing the mirror BECAUSE a turn ended inverts its failure
 * mode: a mirrored thread is never a mid-turn snapshot. The box is definitionally
 * reachable (it just relayed), and both halves of the turn are final.
 *
 * Rejected write paths, and why:
 *  - Tapping the sandbox proxy's `/session/:id/message` responses is the most
 *    complete source, but it puts a parse of a body measured at 7-19 MB on the
 *    hot proxy path of every transcript read. Tapping the SSE `/event` stream
 *    instead would mean reassembling part deltas server-side — a second sync
 *    store, in a second language of bugs.
 *  - Writing at prompt-accept captures only the user half of a turn, keyed by a
 *    client-minted wire id rather than the ids the runtime finally persists.
 *
 * KNOWN GAP, stated rather than papered over: a turn whose `turn_end` never
 * arrives (the box is killed mid-turn) leaves its messages unmirrored until the
 * next successful capture. The read path reports exactly what it holds and
 * never claims a completeness it cannot prove.
 *
 * IDENTITY IS THE POINT. Rows are keyed by the OpenCode message id — the same
 * id the live sync store sees when the box answers — so a client hydrates with
 * `source: 'cache'` and the live read SETTLES each message by id instead of
 * duplicating it. A mirror without ids reproduces the ghost messages that got
 * the last one deleted.
 *
 * TURN-ENDEDNESS IS STORED, NEVER INFERRED. `info` is kept VERBATIM, so
 * `time.completed` and `error` — the only two things that end a turn — travel
 * with the message. The deleted mirror's freshness test read the transcript's
 * SHAPE (message count, part count, tail id) and a STOP moves none of them, so
 * a stopped thread cold-painted as still running with everything under it
 * dimmed to "Queued". `use-session-sync.ts` states the acceptance criterion for
 * any replacement: it must read the MESSAGE, not its shape. This does.
 *
 * ATTACHMENT BYTES NEVER LEAVE THE BOX. `sanitizeParts` strips a file part's
 * `url` (base64 data URLs are what made those bodies 7-19 MB) and a tool part's
 * `state.input`/`state.output`.
 *
 * THIS MODULE IS THE READ SIDE plus the pure projections. The WRITE side lives
 * in `session-transcript-capture.ts`, because it needs the session-lifecycle
 * engine's endpoint resolver and the digest must not carry that import graph.
 */

import { sessionTranscriptMessages, sessionTranscriptMirrors } from '@kortix/db';
import { count, eq, sql } from 'drizzle-orm';

import { db } from '../../shared/db';

/** Messages read from the box per capture. A turn adds one user message and a
 *  handful of assistant steps, so this is many turns of headroom; everything
 *  older is already mirrored by the captures that preceded it. */
export const MIRROR_CAPTURE_LIMIT = 80;

/** Retained rows per session, matching the transcript route's own `limit`
 *  ceiling (500) — the mirror can never be asked for more than it keeps.
 *  Pruning clears `head_complete`: losing the head is what that bit records. */
export const MIRROR_MAX_MESSAGES = 500;

/** Per text-like part. Real messages are 2-10 KB; this only stops one
 *  pathological part from becoming a pathological row. */
export const MIRROR_MAX_PART_CHARS = 200_000;

/** Per message, across all text-like parts, spent in order. */
export const MIRROR_MAX_MESSAGE_CHARS = 1_000_000;

/** One mirrored message in the shape the sync store hydrates from. */
export interface MirrorMessage {
  /** OpenCode's message envelope, verbatim (`Message` in @opencode-ai/sdk). */
  info: Record<string, unknown>;
  /** The part array, minus tool inputs/outputs and file urls. */
  parts: Array<Record<string, unknown>>;
}

export interface MirrorSnapshot {
  opencode_session_id: string | null;
  captured_at: string;
  /** Every message the mirror holds for this session, not just this window. */
  total: number;
  /** The mirror has PROVEN it holds the session's first message. */
  head_complete: boolean;
  messages: MirrorMessage[];
}

/** Fields whose size is unbounded and whose content is already represented by
 *  a sibling the transcript renders (a tool's name + status, a file's name +
 *  mime). Removing them is what keeps a mirrored row small. */
const TOOL_STATE_KEEP = new Set(['status', 'title', 'time', 'metadata']);

/**
 * Pure: strip the unbounded fields out of a part array and bound what is left.
 *
 * Everything a transcript needs to render survives — text, reasoning, tool
 * names and statuses, file names and types, step boundaries.
 */
export function sanitizeParts(raw: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(raw)) return [];
  let budget = MIRROR_MAX_MESSAGE_CHARS;
  const out: Array<Record<string, unknown>> = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) continue;
    const part = { ...(item as Record<string, unknown>) };
    const type = typeof part.type === 'string' ? part.type : '';

    if (type === 'file') {
      // A base64 `data:` url here is the entire 7-19 MB transcript incident.
      delete part.url;
      delete part.source;
    }

    if (type === 'tool') {
      const state = part.state;
      if (state && typeof state === 'object' && !Array.isArray(state)) {
        const kept: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(state as Record<string, unknown>)) {
          if (TOOL_STATE_KEEP.has(k)) kept[k] = v;
        }
        // `input`/`output` are the tool's whole payload — a file read, a build
        // log, a page of HTML. The compact projection never showed them and the
        // renderer does not need them.
        part.state = kept;
      }
    }

    if (typeof part.text === 'string') {
      const cap = Math.max(0, Math.min(MIRROR_MAX_PART_CHARS, budget));
      if (part.text.length > cap) part.text = part.text.slice(0, cap);
      budget -= (part.text as string).length;
    }

    out.push(part);
  }
  return out;
}

type RawMessage = {
  info?: Record<string, unknown>;
  parts?: unknown;
} & Record<string, unknown>;

/**
 * Pure projection: OpenCode's `GET /session/:id/message` payload -> mirror rows.
 *
 * A message with no `id` is DROPPED, never synthesized. An id the live sync
 * store will not also produce is precisely the ghost this mirror exists to
 * avoid, so "no identity" means "not mirrorable".
 */
export function mirrorRowsFromOpencodePayload(payload: unknown): MirrorMessage[] {
  const list = Array.isArray(payload)
    ? payload
    : typeof payload === 'object' &&
        payload &&
        'messages' in payload &&
        Array.isArray((payload as { messages?: unknown }).messages)
      ? (payload as { messages: unknown[] }).messages
      : [];
  const rows: MirrorMessage[] = [];
  for (const raw of list) {
    if (typeof raw !== 'object' || raw === null) continue;
    const msg = raw as RawMessage;
    const info =
      msg.info && typeof msg.info === 'object' && !Array.isArray(msg.info)
        ? (msg.info as Record<string, unknown>)
        : null;
    if (!info) continue;
    const id = typeof info.id === 'string' ? info.id.trim() : '';
    if (!id) continue;
    rows.push({ info, parts: sanitizeParts(msg.parts) });
  }
  return rows;
}

/**
 * The head bit, decided from evidence and nothing else.
 *
 * The box was asked for the last `limit` messages. Fewer than `limit` came back
 * => that IS the whole thread and the mirror now holds its first message.
 * Exactly `limit` => there may be more above, so the previously proven value
 * stands. Nothing here guesses.
 */
export function headCompleteAfterCapture(input: {
  returned: number;
  limit: number;
  previous: boolean;
}): boolean {
  if (input.returned < input.limit) return true;
  return input.previous;
}

/**
 * Serve the mirror. Returns null when nothing was ever captured — the caller
 * must then say "unavailable" rather than paint an empty thread as a complete
 * one.
 */
export async function readSessionTranscriptMirror(input: {
  sessionId: string;
  limit: number;
}): Promise<MirrorSnapshot | null> {
  const [state] = await db
    .select({
      opencodeSessionId: sessionTranscriptMirrors.opencodeSessionId,
      headComplete: sessionTranscriptMirrors.headComplete,
      capturedAt: sessionTranscriptMirrors.capturedAt,
    })
    .from(sessionTranscriptMirrors)
    .where(eq(sessionTranscriptMirrors.sessionId, input.sessionId))
    .limit(1);
  if (!state) return null;

  const [totals] = await db
    .select({ total: count() })
    .from(sessionTranscriptMessages)
    .where(eq(sessionTranscriptMessages.sessionId, input.sessionId));
  const total = totals?.total ?? 0;
  if (total === 0) return null;

  // Newest `limit` rows, then flipped back into transcript order. Ordering is
  // (message_created_at, message_id) — the order OpenCode's own
  // `MessageV2.page()` uses, so the mirror and the live read never disagree.
  const tail = await db
    .select({
      info: sessionTranscriptMessages.info,
      parts: sessionTranscriptMessages.parts,
    })
    .from(sessionTranscriptMessages)
    .where(eq(sessionTranscriptMessages.sessionId, input.sessionId))
    .orderBy(
      sql`${sessionTranscriptMessages.messageCreatedAt} DESC NULLS LAST`,
      sql`${sessionTranscriptMessages.messageId} DESC`,
    )
    .limit(input.limit);

  return {
    opencode_session_id: state.opencodeSessionId ?? null,
    captured_at: new Date(state.capturedAt).toISOString(),
    total,
    head_complete: state.headComplete,
    messages: tail.reverse().map((row) => ({
      info: (row.info ?? {}) as Record<string, unknown>,
      parts: (Array.isArray(row.parts) ? row.parts : []) as Array<Record<string, unknown>>,
    })),
  };
}
