import { voiceCallReadCursors } from '@kortix/db';
/**
 * `read_transcript` — the Kortix agent reading a live call, cheaply.
 *
 * THE PROBLEM THIS SOLVES. The transcript was always cursor-paged, so the read
 * was already incremental — but only for an agent that threaded the returned
 * cursor back on every single call. An agent that forgot, or that simply began a
 * fresh turn without it, passed 0 and got the entire conversation again. On a
 * long call that is the same thousands of tokens re-read every turn for zero new
 * information, and it is the default failure because remembering a number across
 * turns is exactly the thing a model is worst at.
 *
 * So the position moves to the server. A bare `read_transcript {}` now means
 * "only what I have not been shown", the agent carries nothing, and the cheap
 * behaviour is the one you get by doing nothing. `kortix.voice_call_read_cursors`
 * holds it — one row per call, keyed by call id, which is also the session id.
 * See that migration for why it is its own table and not a column on
 * project_sessions.
 *
 * THE MODES, and why there are exactly four.
 *   unread (default)  what you have not seen. Advances your position.
 *   last              the newest N turns, ignoring your position. Re-orienting
 *                     mid-call ("what was just said?") without replaying an hour.
 *   full              the whole call, asked for explicitly. Advances.
 *   cursor            an explicit floor, for a caller doing its own bookkeeping.
 *                     Never advances, and `{"cursor":0}` still means the whole
 *                     call. The SEMANTICS are the pre-existing contract; the
 *                     wire shape is not, and saying "unchanged" here would be a
 *                     lie a future reader would act on. Two things did change,
 *                     for every mode alike: the turn shape lost its per-turn
 *                     `cursor` (see AgentTranscriptTurn), and the default page
 *                     is 100 rather than readTurns' 200 — a clip now reports
 *                     `truncated` so the caller pages on. Nothing in-repo read
 *                     this path (r7.ts and public-join-routes.ts call readTurns
 *                     directly with their own limits), so nothing broke.
 *
 * ADVANCING IS MUTATION, AND MUTATION CAN LOSE THINGS. If the position moves and
 * the agent's turn then dies before it does anything with what it read, those
 * turns are gone from `unread` forever. Three deliberate choices bound that:
 *
 *   1. The position advances ONLY to the highest cursor actually RETURNED, never
 *      to the head of the transcript. A page clipped by `limit` therefore leaves
 *      everything it did not hand over still unread. Nothing is ever marked read
 *      because it existed — only because it was delivered.
 *   2. Nothing is deleted, ever. `last` and `full` and an explicit `cursor` all
 *      still see every turn regardless of the position, so a turn that dies
 *      mid-read is recoverable in one call: `{"mode":"last","limit":20}`. That
 *      is the documented recovery, and it is why `last` exists at all rather
 *      than being a nicety.
 *   3. `peek: true` reads unread WITHOUT advancing, for a caller that wants to
 *      look before it commits.
 *
 * We do NOT ack-on-next-read or keep a two-phase delivered/confirmed pointer:
 * the agent has no ack to give, so a second pointer would only move the same
 * loss one turn later while doubling the state anyone has to reason about. A
 * duplicated read costs tokens; the recovery costs one call. Losing the turns
 * outright is the only unacceptable outcome, and (2) rules it out.
 *
 * WHY THE ACTION IS STILL `risk: 'read'`. It mutates, but only the caller's own
 * read position — bookkeeping about the reader, not about the call. Nothing
 * about the room, the conversation or the transcript changes; no other reader
 * observes it (the call page polls with its own explicit cursor and never
 * touches this row); and it is recoverable by (2). Grading it `write` would put
 * the agent's cheapest and most-encouraged action — read at the top of every
 * turn — behind approval in stricter policy modes, which would cost far more
 * than the honesty is worth. The honest escape hatch is `peek`.
 */
import { eq, lt } from 'drizzle-orm';
import { db } from '../../shared/db';
import { type TranscriptPage, countTurnsAfter, readLastTurns, readTurns } from './runtime';

export type ReadMode = 'unread' | 'last' | 'full' | 'cursor';

/** Modes whose page is contiguous up to the newest turn it returned, so
 *  recording "I have been shown everything up to here" is true. `last` is a
 *  window that can leave older unread turns BEHIND it, and an explicit `cursor`
 *  is a caller keeping its own books — neither may move the position. */
const ADVANCING: ReadonlySet<ReadMode> = new Set<ReadMode>(['unread', 'full']);

/**
 * Per-mode page sizes. `unread` is generous because a backlog is normally tiny
 * and a truncated backlog costs another round trip; `last` is small because its
 * whole purpose is a glance; `full` is capped at the same ceiling as everything
 * else because "the whole call" must still not be able to blow up a context
 * window in one tool result — a clipped `full` says so and can be continued.
 */
const DEFAULT_LIMIT: Record<ReadMode, number> = { unread: 100, last: 10, full: 500, cursor: 100 };
const MAX_LIMIT = 500;

export interface ReadPlan {
  mode: ReadMode;
  limit: number;
  /** Read without advancing the saved position. */
  peek: boolean;
  /** The floor for `mode: 'cursor'`; meaningless otherwise. */
  cursor: number;
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function asBoolean(value: unknown): boolean {
  return value === true || value === 'true';
}

/**
 * Args → plan. Pure, so the whole precedence question is testable without a
 * database.
 *
 * A bad `mode` falls back to the default rather than erroring: a typo costing
 * the agent an entire turn is a worse outcome than reading the unread, and the
 * response echoes the mode that actually ran so the mistake is visible.
 */
export function resolveReadPlan(args: Record<string, unknown>): ReadPlan {
  const rawMode = typeof args.mode === 'string' ? args.mode.trim().toLowerCase() : '';
  const explicitCursor = asNumber(args.cursor);

  // An explicit `mode` wins. With no mode, a `cursor` argument selects the old
  // stateless contract — `{"cursor":0}` still means "the whole call from the
  // start", exactly as it did before the position existed.
  const mode: ReadMode =
    rawMode === 'unread' || rawMode === 'last' || rawMode === 'full' || rawMode === 'cursor'
      ? rawMode
      : explicitCursor !== null
        ? 'cursor'
        : 'unread';

  const rawLimit = asNumber(args.limit);
  const limit =
    rawLimit === null
      ? DEFAULT_LIMIT[mode]
      : Math.min(MAX_LIMIT, Math.max(1, Math.trunc(rawLimit)));

  return {
    mode,
    limit,
    peek: asBoolean(args.peek),
    cursor: explicitCursor === null ? 0 : Math.max(0, Math.trunc(explicitCursor)),
  };
}

/**
 * One turn as the AGENT sees it.
 *
 * Deliberately thinner than `TranscriptPage`'s row. The per-turn `cursor` is
 * gone: the page-level cursor is the only one anybody resumes from, and no
 * action addresses an individual turn, so it was ~5 tokens of noise on every
 * line of every read. `at` was never here — a wall-clock stamp per line buys
 * nothing an ordered list does not already say. `speaker` stays, because `role`
 * alone cannot answer "who said this" (role 'agent' covers both the voice and
 * this agent's own send_prompt lines), but it is OMITTED when null rather than
 * serialized as `"speaker":null`.
 */
export interface AgentTranscriptTurn {
  role: string;
  speaker?: string;
  text: string;
}

export interface AgentTranscriptRead {
  /** The mode that actually ran — not necessarily the one that was asked for. */
  mode: ReadMode;
  turns: AgentTranscriptTurn[];
  /** Resume point: the highest cursor in this page. */
  cursor: number;
  /** Turns still unread AFTER this call. The "is it worth reading again" signal. */
  unread: number;
  /** Present only when `limit` clipped a forward page — call again for the rest. */
  truncated?: true;
}

function shape(page: TranscriptPage): AgentTranscriptTurn[] {
  return page.turns.map((t) => ({
    role: t.role,
    ...(t.speaker ? { speaker: t.speaker } : {}),
    text: t.text,
  }));
}

/** The saved position, or 0 for a call this agent has never read. */
export async function getReadCursor(callId: string): Promise<number> {
  const [row] = await db
    .select({ cursor: voiceCallReadCursors.cursor })
    .from(voiceCallReadCursors)
    .where(eq(voiceCallReadCursors.callId, callId))
    .limit(1);
  return row ? Number(row.cursor) : 0;
}

/**
 * Move the position forward. `setWhere` makes it monotonic in SQL rather than in
 * a read-modify-write here: two reads racing inside one call (a turn and a
 * watcher, say) must never let the slower one rewind the position and re-serve
 * turns the agent has already paid for.
 */
export async function advanceReadCursor(
  callId: string,
  workspaceId: string,
  cursor: number,
): Promise<void> {
  await db
    .insert(voiceCallReadCursors)
    .values({ callId, workspaceId, cursor })
    .onConflictDoUpdate({
      target: voiceCallReadCursors.callId,
      set: { cursor, updatedAt: new Date() },
      setWhere: lt(voiceCallReadCursors.cursor, cursor),
    });
}

/**
 * The whole action, minus liveness (which the caller adds — see db-deps.ts).
 *
 * Four small indexed statements at worst, run in a fixed order: position → page
 * → maybe advance → count. Deliberately sequential rather than overlapped; the
 * count has to reflect the position AFTER any advance, or a fully drained read
 * would report its own turns as still unread.
 */
export async function readTranscriptForAgent(input: {
  callId: string;
  workspaceId: string;
  args: Record<string, unknown>;
}): Promise<AgentTranscriptRead> {
  const { callId, workspaceId } = input;
  const plan = resolveReadPlan(input.args);

  const position = await getReadCursor(callId);

  const page =
    plan.mode === 'unread'
      ? await readTurns(callId, position, plan.limit)
      : plan.mode === 'last'
        ? await readLastTurns(callId, plan.limit)
        : plan.mode === 'full'
          ? await readTurns(callId, 0, plan.limit)
          : await readTurns(callId, plan.cursor, plan.limit);

  // Only meaningful for a forward page, where a clip means "there is more AFTER
  // this — call again". A clipped `last` means there is more BEFORE it, which is
  // the normal state of every call and would be pure noise to report.
  const truncated = plan.mode !== 'last' && page.turns.length >= plan.limit;

  let position2 = position;
  if (ADVANCING.has(plan.mode) && !plan.peek && page.turns.length > 0) {
    // `page.cursor` is the highest cursor RETURNED, not the head of the
    // transcript. Math.max is belt-and-braces for a clipped `full` on a call the
    // agent had already read further into: never move backwards.
    position2 = Math.max(position, page.cursor);
    await advanceReadCursor(callId, workspaceId, position2);
  }

  const unread = await countTurnsAfter(callId, position2);

  return {
    mode: plan.mode,
    turns: shape(page),
    cursor: page.cursor,
    unread,
    ...(truncated ? { truncated: true as const } : {}),
  };
}
