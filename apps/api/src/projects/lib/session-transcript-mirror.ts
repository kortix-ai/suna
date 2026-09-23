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
 * ATTACHMENT BYTES NEVER ENTER TRANSCRIPT ROWS. `sanitizeParts` strips a file part's
 * `url` (base64 data URLs are what made those bodies 7-19 MB) and a tool part's
 * `state.input`/`state.output` — except the bounded input of a `show` card,
 * which is what that card is drawn from. A `data:` URL is refused there too.
 *
 * THIS MODULE IS THE READ SIDE plus the pure projections. The WRITE side lives
 * in `session-transcript-capture.ts`, because it needs the session-lifecycle
 * engine's endpoint resolver and the digest must not carry that import graph.
 */

import { sessionTranscriptMessages, sessionTranscriptMirrors } from '@kortix/db';
import { parseSessionAttachmentRef } from '@kortix/shared';
import { and, count, eq, sql } from 'drizzle-orm';

import { db } from '../../shared/db';

/** Messages read from the box per capture. A turn adds one user message and a
 *  handful of assistant steps, so this is many turns of headroom; everything
 *  older is already mirrored by the captures that preceded it. */
export const MIRROR_CAPTURE_LIMIT = 80;

/** Legacy retained rows per session. Opted-in history is retained without this cap.
 *  The legacy limit matches the transcript route's own `limit`
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
  /** The part array, minus tool inputs/outputs and file urls (a `show`
   *  card keeps its bounded input — see INPUT_RENDERED_TOOLS). */
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
  /**
   * The message id to pass as `before` to read the page OLDER than this one,
   * or null when this window already reaches the oldest row the mirror holds.
   *
   * A window without this is a dead end: the mirror retains a flagged
   * project's whole history and every reader asks for a tail (the startup
   * view asks for 40), so without a cursor everything before that tail is
   * stored and unreachable. 25 of 375 mirrored dev sessions already hold more
   * than 40 messages.
   */
  next_cursor: string | null;
}

/** Fields whose size is unbounded and whose content is already represented by
 *  a sibling the transcript renders (a tool's name + status, a file's name +
 *  mime). Removing them is what keeps a mirrored row small. */
const TOOL_STATE_KEEP = new Set(['status', 'title', 'time', 'metadata']);

/**
 * Tools whose card is DRAWN FROM ITS INPUT.
 *
 * The rule above holds for almost every tool: a `bash` or `read` input/output
 * is a payload the transcript never draws. `show` is the exception, and it is
 * the tool that matters most in saved history — it is how an agent hands the
 * user a result (an image, a file, a chart, a page). Its renderer reads
 * `state.input` and nothing else, and the SDK's `isEmptyShowPart` DROPS a
 * completed `show` whose input is empty. Stripping it made every result an
 * agent had shown vanish from the saved transcript — present live, silently
 * gone while the sandbox was off.
 *
 * Same normalization as the SDK's `normalizeActivityToolName`, so the mirror
 * keeps exactly the parts the renderer treats as `show`.
 */
const INPUT_RENDERED_TOOLS = new Set(['show', 'show_user']);
const normalizeToolName = (name: unknown) =>
  (typeof name === 'string' ? name : '').replace(/^oc-/, '').replace(/-/g, '_');

/** `show` fields that are small by construction and needed to draw the card.
 *  `content` and `items` are handled separately because they are not. */
const SHOW_SCALAR_FIELDS = [
  'type',
  'title',
  'description',
  'variant',
  'aspect_ratio',
  'theme',
  'language',
] as const;
/** References, not prose: a truncated path or URL is a WRONG one, so an
 *  over-long value is dropped rather than cut. */
const SHOW_REFERENCE_FIELDS = ['path', 'url', 'attachment'] as const;
const SHOW_SCALAR_MAX_CHARS = 4_000;
const SHOW_REFERENCE_MAX_CHARS = 4_096;
/** A carousel is a handful of results, never an archive. */
const SHOW_MAX_ITEMS = 50;

/** A base64 `data:` URL is the 7-19 MB incident, wherever it turns up. */
const isDataUrl = (value: string) => /^\s*data:/i.test(value);

/**
 * Pure: the part of a `show` input the card is drawn from, bounded.
 *
 * `spend` debits the message's shared character budget for `content`, the one
 * field that can legitimately be large (a markdown report, a code listing).
 * Returns null when nothing drawable survives, so an empty object never stands
 * in for "had an input".
 */
function sanitizeShowPayload(
  raw: unknown,
  spend: (text: string) => string,
): Record<string, unknown> | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const input = raw as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of SHOW_SCALAR_FIELDS) {
    const value = input[key];
    if (typeof value === 'string' && !isDataUrl(value)) {
      out[key] = value.slice(0, SHOW_SCALAR_MAX_CHARS);
    }
  }
  for (const key of SHOW_REFERENCE_FIELDS) {
    const value = input[key];
    if (
      typeof value === 'string' &&
      value.length <= SHOW_REFERENCE_MAX_CHARS &&
      !isDataUrl(value)
    ) {
      out[key] = value;
    }
  }
  if (typeof input.content === 'string' && !isDataUrl(input.content)) {
    const content = spend(input.content);
    if (content.length > 0) out.content = content;
  }
  // `items` reaches the runtime as EITHER an array or a JSON string (see the
  // SDK's `parseShowItemsPayload`). It is parsed here — not stored verbatim —
  // because a string would carry any `data:` URL inside it past every check
  // above. A malformed string is dropped: there is nothing safe to keep.
  let items: unknown = input.items;
  if (typeof items === 'string') {
    try {
      items = JSON.parse(items);
    } catch {
      items = undefined;
    }
  }
  if (Array.isArray(items)) {
    const kept = items
      .slice(0, SHOW_MAX_ITEMS)
      .map((item) => sanitizeShowPayload(item, spend))
      .filter((item): item is Record<string, unknown> => item !== null);
    if (kept.length > 0) out.items = kept;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * Pure: strip the unbounded fields out of a part array and bound what is left.
 *
 * Everything a transcript needs to render survives — text, reasoning, tool
 * names and statuses, file names and types, step boundaries, and the bounded
 * input a `show` card is drawn from (see INPUT_RENDERED_TOOLS).
 */
export function sanitizeParts(raw: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(raw)) return [];
  let budget = MIRROR_MAX_MESSAGE_CHARS;
  /** Cut `text` to what the message may still spend, and debit it. */
  const spend = (text: string): string => {
    const cap = Math.max(0, Math.min(MIRROR_MAX_PART_CHARS, budget));
    const kept = text.length > cap ? text.slice(0, cap) : text;
    budget -= kept.length;
    return kept;
  };
  const out: Array<Record<string, unknown>> = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) continue;
    const part = { ...(item as Record<string, unknown>) };
    const type = typeof part.type === 'string' ? part.type : '';

    if (type === 'file') {
      // A base64 `data:` url here is the entire 7-19 MB transcript incident.
      if (!parseSessionAttachmentRef(part.url)) delete part.url;
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
        // renderer does not need them. EXCEPT for a tool drawn from its input:
        // see INPUT_RENDERED_TOOLS. Its `output` is still dropped.
        if (INPUT_RENDERED_TOOLS.has(normalizeToolName(part.tool))) {
          const input = sanitizeShowPayload((state as Record<string, unknown>).input, spend);
          if (input) kept.input = input;
        }
        part.state = kept;
      }
    }

    if (typeof part.text === 'string') part.text = spend(part.text);

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
 * The "have I already got this page?" test a full-history walk stops on, or
 * `undefined` when stopping would be unsound.
 *
 * TWO CONDITIONS, both load-bearing.
 *
 * 1. THE PREVIOUS CAPTURE REACHED THE HEAD (`headComplete`). Pages run
 *    newest-first, so "I hold this page" only implies "I hold everything below
 *    it" when a previous walk actually got to the session's first message.
 *    Without the gate, a mirror that never got past page three would catch up
 *    on page three forever and the head would never be captured at all.
 * 2. THE MESSAGE IS COMPLETED, and its completion time matches what is stored.
 *    An uncompleted message can still grow, so it is never evidence of
 *    anything; `time.completed` is the field OpenCode stamps when the turn
 *    ends, which is why the mirror denormalizes it.
 */
export function capturedPageGate(input: {
  fullHistory: boolean;
  headComplete: boolean;
  /** message id -> stored `message_completed_at` in epoch ms, null when the
   *  message is stored but not completed. */
  completedById: ReadonlyMap<string, number | null>;
}): ((rows: Array<{ info: Record<string, unknown> }>) => boolean) | undefined {
  if (!input.fullHistory || !input.headComplete) return undefined;
  return (rows) =>
    rows.every((row) => {
      const id = String(row.info.id);
      if (!input.completedById.has(id)) return false;
      const time = row.info.time;
      const completed =
        time && typeof time === 'object' && !Array.isArray(time)
          ? (time as Record<string, unknown>).completed
          : undefined;
      if (typeof completed !== 'number' || !Number.isFinite(completed) || completed <= 0) {
        return false;
      }
      return input.completedById.get(id) === completed;
    });
}

/**
 * What ONE capture reads, and what it may prune.
 *
 * `fullHistory` decides whether the read paginates the whole session or takes
 * one bounded page. It is the project flag — EXCEPT when the caller asks for a
 * tail, which manual stop does: stop AWAITS this read before powering the box
 * off, and a full-history read there is a 60s pagination with three retries
 * standing between the user and a Stop button. The full copy is already
 * maintained at every turn end (fire-and-forget, box definitionally up), so
 * the only gap a stop can close is the turn that just ended — one page.
 *
 * `retainHistory` is NEVER derived from `fullHistory`. If it were, a forced
 * tail would re-enable pruning and a single Stop would cut a retained history
 * down to {@link MIRROR_MAX_MESSAGES} — the feature deleting exactly what it
 * exists to keep. It follows the flag and the project's sticky marker, both of
 * which say "this project keeps its history", whatever this one read does.
 */
export function captureScope(input: {
  flagEnabled: boolean;
  everRetained: boolean;
  requested?: 'auto' | 'tail';
}): { fullHistory: boolean; retainHistory: boolean } {
  return {
    fullHistory: input.requested === 'tail' ? false : input.flagEnabled,
    retainHistory: input.flagEnabled || input.everRetained,
  };
}

/**
 * A `before` cursor that names no message this session has mirrored.
 *
 * Distinct from "no mirror" on purpose. Serving the newest window instead
 * would answer a question the caller did not ask, and a client paging older
 * would ask again with the same rejected cursor and loop forever on page one.
 */
export class UnknownTranscriptCursorError extends Error {
  constructor(public readonly cursor: string) {
    super('Unknown transcript cursor');
    this.name = 'UnknownTranscriptCursorError';
  }
}

/**
 * Serve the mirror. Returns null when nothing was ever captured — the caller
 * must then say "unavailable" rather than paint an empty thread as a complete
 * one.
 *
 * `before` walks BACKWARDS by keyset on the stored order
 * (`message_created_at`, `message_id`) — the same order OpenCode's own
 * `MessageV2.page()` uses, so a mirrored page and a live read never disagree
 * about sequence. Never OFFSET: capture rewrites rows under the reader, and an
 * offset page would skip and repeat across requests.
 */
export async function readSessionTranscriptMirror(input: {
  sessionId: string;
  limit: number;
  /** A message id from a previous window's `next_cursor`. Rows STRICTLY older
   *  than it are returned. */
  before?: string | null;
}): Promise<MirrorSnapshot | null> {
  return db.transaction(
    async (tx) => {
      const [state] = await tx
        .select({
          opencodeSessionId: sessionTranscriptMirrors.opencodeSessionId,
          headComplete: sessionTranscriptMirrors.headComplete,
          capturedAt: sessionTranscriptMirrors.capturedAt,
        })
        .from(sessionTranscriptMirrors)
        .where(eq(sessionTranscriptMirrors.sessionId, input.sessionId))
        .limit(1);
      if (!state) return null;

      const [totals] = await tx
        .select({ total: count() })
        .from(sessionTranscriptMessages)
        .where(eq(sessionTranscriptMessages.sessionId, input.sessionId));
      const total = totals?.total ?? 0;
      if (total === 0) return null;

      let anchor: { messageCreatedAt: Date | null; messageId: string } | null = null;
      if (input.before) {
        const [row] = await tx
          .select({
            messageCreatedAt: sessionTranscriptMessages.messageCreatedAt,
            messageId: sessionTranscriptMessages.messageId,
          })
          .from(sessionTranscriptMessages)
          .where(
            and(
              eq(sessionTranscriptMessages.sessionId, input.sessionId),
              eq(sessionTranscriptMessages.messageId, input.before),
            ),
          )
          .limit(1);
        // The cursor is a message id this session mirrored, so a miss means the
        // row was pruned or the caller invented it. Both are the caller's to
        // handle; neither may be answered with the newest page.
        if (!row) throw new UnknownTranscriptCursorError(input.before);
        anchor = row;
      }

      // Written out rather than as a row comparison `(a, b) < (c, d)`: the
      // expanded form takes the (session_id, message_created_at, message_id)
      // index without depending on how the driver types a Date inside a row
      // constructor. NULL `message_created_at` sorts last under DESC NULLS
      // LAST — i.e. oldest — so it is older than any timestamped row.
      // `::timestamptz` on an ISO STRING, never a bound `Date`: inside a raw
      // `sql` fragment the parameter bypasses drizzle's column typing and
      // postgres.js rejects a Date outright ("The \"string\" argument must be of
      // type string ... Received an instance of Date"). Caught against the real
      // dev mirror, not by a test with an injected reader.
      const anchorCreatedAt = anchor?.messageCreatedAt
        ? new Date(anchor.messageCreatedAt).toISOString()
        : null;
      const older = anchor
        ? anchorCreatedAt === null
          ? sql`${sessionTranscriptMessages.messageCreatedAt} IS NULL AND ${sessionTranscriptMessages.messageId} < ${anchor.messageId}`
          : sql`(${sessionTranscriptMessages.messageCreatedAt} IS NULL OR ${sessionTranscriptMessages.messageCreatedAt} < ${anchorCreatedAt}::timestamptz OR (${sessionTranscriptMessages.messageCreatedAt} = ${anchorCreatedAt}::timestamptz AND ${sessionTranscriptMessages.messageId} < ${anchor.messageId}))`
        : undefined;

      // `limit + 1` is the has-older probe: one extra row costs one row and
      // answers "is there a page behind this one" without a second query.
      const window = await tx
        .select({
          messageId: sessionTranscriptMessages.messageId,
          info: sessionTranscriptMessages.info,
          parts: sessionTranscriptMessages.parts,
        })
        .from(sessionTranscriptMessages)
        .where(
          older
            ? and(eq(sessionTranscriptMessages.sessionId, input.sessionId), older)
            : eq(sessionTranscriptMessages.sessionId, input.sessionId),
        )
        .orderBy(
          sql`${sessionTranscriptMessages.messageCreatedAt} DESC NULLS LAST`,
          sql`${sessionTranscriptMessages.messageId} DESC`,
        )
        .limit(input.limit + 1);

      const hasOlder = window.length > input.limit;
      const kept = hasOlder ? window.slice(0, input.limit) : window;

      return {
        opencode_session_id: state.opencodeSessionId ?? null,
        captured_at: new Date(state.capturedAt).toISOString(),
        total,
        head_complete: state.headComplete,
        // The oldest row IN this window, so the next request starts strictly
        // behind it. Null when this window already reaches the oldest row.
        next_cursor: hasOlder ? (kept.at(-1)?.messageId ?? null) : null,
        messages: kept.reverse().map((row) => ({
          info: (row.info ?? {}) as Record<string, unknown>,
          parts: (Array.isArray(row.parts) ? row.parts : []) as Array<Record<string, unknown>>,
        })),
      };
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  );
}
