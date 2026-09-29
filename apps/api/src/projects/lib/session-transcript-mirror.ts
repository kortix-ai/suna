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
 * `turn-stream` `end`/`turn_end` relay in `routes/turn-stream.ts`, fire-and-forget,
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
 * EVERY PART IS KEPT 1:1, EXCEPT BYTES. Saved history is what a client renders
 * while the computer is off, and what every client (web, mobile, CLI, SDK)
 * pages through, so a row must draw exactly what the live transcript draws:
 * text, reasoning, and every tool call with its input, output, error and
 * metadata. Tool cards draw from their input (the command, the path, the
 * pattern) and most from their output; an earlier mirror dropped both and saved
 * history drew empty cards.
 *
 * ATTACHMENT BYTES NEVER ENTER TRANSCRIPT ROWS. `sanitizeParts` removes a file
 * part's `url` unless it is a private attachment reference (base64 data URLs
 * are what made those bodies 7-19 MB), the same from a tool call's
 * `attachments`, and any `data:` URL anywhere in a tool payload. Strings are
 * bounded only against pathological sizes (see MIRROR_MAX_PART_CHARS).
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

/** Per string: a text-like part, or one string in a tool call's payload. Real
 *  messages are 2-10 KB and OpenCode cuts a tool's output at 50 KB, so this
 *  only stops one pathological string from becoming a pathological row. */
export const MIRROR_MAX_PART_CHARS = 200_000;

/** Per message, twice: once across its text-like parts, once across its tool
 *  payloads. Separate budgets, so a message's tool output can never cut its
 *  reply text, and the reverse. */
export const MIRROR_MAX_MESSAGE_CHARS = 1_000_000;

/** One sync window, serialized. A cold open waits for the first window, and
 *  1:1 tool payloads make 40 messages of a tool-heavy thread megabytes. The
 *  window keeps its NEWEST messages that fit; the rest is one cursor away. */
export const MIRROR_WINDOW_MAX_CHARS = 1_000_000;

/** A file part's mention `source` (`@path` plus its offsets in the prompt) is
 *  small by construction. One larger than this is not a mention: dropped, not
 *  cut, because cut offsets would highlight the wrong characters. */
const MIRROR_MAX_SOURCE_CHARS = 4_096;

/** Nesting a tool payload is walked to. Real payloads nest a handful of
 *  levels; a deeper value is dropped rather than stored unscanned. */
const MAX_PAYLOAD_DEPTH = 64;

/** One mirrored message in the shape the sync store hydrates from. */
export interface MirrorMessage {
  /** OpenCode's message envelope, verbatim (`Message` in @opencode-ai/sdk). */
  info: Record<string, unknown>;
  /** The part array 1:1, minus attachment bytes (see `sanitizeParts`). */
  parts: Array<Record<string, unknown>>;
}

export interface MirrorSnapshot {
  /** The OpenCode session whose messages this window holds: the root, or
   *  the sub-agent session a child read asked for. */
  opencode_session_id: string | null;
  /** The OpenCode root the mirror was captured from. Equal to
   *  `opencode_session_id` for a root read. */
  root_opencode_session_id?: string | null;
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

/**
 * Tools whose input is a CARD PAYLOAD that can carry bytes inside a string.
 *
 * `show` is how an agent hands the user a result (an image, a file, a chart, a
 * page). Its renderer reads `state.input` and nothing else, and the SDK's
 * `isEmptyShowPart` DROPS a completed `show` whose input draws nothing. Its
 * input is kept field by field (`sanitizeShowPayload`) rather than walked like
 * any other payload, because `items` arrives as a JSON STRING that can carry a
 * `data:` URL inside it, past a check that only looks at whole strings.
 *
 * Same normalization as the SDK's `normalizeActivityToolName`, so the mirror
 * treats exactly the parts the renderer treats as `show` this way.
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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** A tool call that has ended. OpenCode's schema gives both a required
 *  `input`, which is what `mirrorPartsAreStripped` relies on. */
const isSettledToolStatus = (status: unknown) => status === 'completed' || status === 'error';

/** A string budget: every string is cut to the per-string cap, and `spend`
 *  also cuts to what is left of the message's budget. `count` debits the
 *  budget and never cuts — for the strings that identify a call. */
function stringBudget(total: number) {
  let left = total;
  return {
    spend(text: string): string {
      const cap = Math.max(0, Math.min(MIRROR_MAX_PART_CHARS, left));
      const kept = text.length > cap ? text.slice(0, cap) : text;
      left -= kept.length;
      return kept;
    },
    count(text: string): string {
      const kept = text.length > MIRROR_MAX_PART_CHARS ? text.slice(0, MIRROR_MAX_PART_CHARS) : text;
      left -= kept.length;
      return kept;
    },
  };
}

/**
 * Pure: a JSON value with every `data:` URL string removed, and every other
 * string passed through `bound`. A removed array element is dropped, a removed
 * object field is deleted, and `undefined` means the value itself was bytes.
 */
function withoutBytes(
  value: unknown,
  bound: ((text: string) => string) | null,
  depth = 0,
): unknown {
  if (typeof value === 'string') {
    if (isDataUrl(value)) return undefined;
    return bound ? bound(value) : value;
  }
  if (typeof value !== 'object' || value === null) return value;
  if (depth >= MAX_PAYLOAD_DEPTH) return undefined;
  if (Array.isArray(value)) {
    const kept: unknown[] = [];
    for (const item of value) {
      const next = withoutBytes(item, bound, depth + 1);
      if (next !== undefined) kept.push(next);
    }
    return kept;
  }
  const kept: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    const next = withoutBytes(item, bound, depth + 1);
    if (next !== undefined) kept[key] = next;
  }
  return kept;
}

/**
 * Pure: a file part (a prompt attachment, or one of a tool call's
 * `attachments`) without its bytes. A private attachment reference is the
 * one `url` kept: it names bytes already copied to the attachment store.
 */
function sanitizeFilePart(raw: Record<string, unknown>): Record<string, unknown> {
  const part = { ...raw };
  // A base64 `data:` url here is the entire 7-19 MB transcript incident.
  if (!parseSessionAttachmentRef(part.url)) delete part.url;
  if ('source' in part) {
    let size = Number.POSITIVE_INFINITY;
    try {
      size = JSON.stringify(part.source)?.length ?? Number.POSITIVE_INFINITY;
    } catch {
      // Not JSON: not a mention.
    }
    if (!isRecord(part.source) || size > MIRROR_MAX_SOURCE_CHARS) delete part.source;
  }
  return part;
}

/**
 * Pure: a tool call's `state`, 1:1 except for bytes.
 *
 * `input` identifies the call (the command, the path, the pattern), so its
 * strings are counted against the budget but never cut by it. `output`,
 * `error` and a pending call's streamed `raw` are the payload, and are cut
 * when the message's tool budget runs out. `metadata` is stored as OpenCode
 * wrote it (an edit's diff is drawn from it), minus `data:` URLs.
 */
function sanitizeToolState(
  tool: unknown,
  raw: Record<string, unknown>,
  budget: ReturnType<typeof stringBudget>,
): Record<string, unknown> {
  const show = INPUT_RENDERED_TOOLS.has(normalizeToolName(tool));
  const state: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (key === 'input' && show) {
      state.input = sanitizeShowPayload(value, budget.spend) ?? {};
      continue;
    }
    if (key === 'attachments') {
      if (Array.isArray(value)) state.attachments = value.filter(isRecord).map(sanitizeFilePart);
      continue;
    }
    const bound =
      key === 'metadata' ? null : key === 'input' || key === 'title' ? budget.count : budget.spend;
    const kept = withoutBytes(value, bound);
    if (kept !== undefined) state[key] = kept;
  }
  // Every settled call carries an input, as OpenCode's schema requires. A
  // settled call WITHOUT one is therefore a row the old mirror stripped, which
  // is how `mirrorPartsAreStripped` finds the rows to capture again.
  if (isSettledToolStatus(state.status) && !('input' in state)) state.input = {};
  return state;
}

/**
 * Pure: a part array as the mirror stores it — every part 1:1, except bytes.
 *
 * Text, reasoning, step boundaries, file names and mention sources, and every
 * tool call's input, output, error, title, metadata and time are kept. Only
 * attachment bytes are removed (see the module header), and strings are
 * bounded against pathological sizes: MIRROR_MAX_PART_CHARS per string, and
 * MIRROR_MAX_MESSAGE_CHARS per message, once for text and once for tool
 * payloads.
 */
export function sanitizeParts(raw: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(raw)) return [];
  const text = stringBudget(MIRROR_MAX_MESSAGE_CHARS);
  const tools = stringBudget(MIRROR_MAX_MESSAGE_CHARS);
  const out: Array<Record<string, unknown>> = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const type = typeof item.type === 'string' ? item.type : '';
    const part = type === 'file' ? sanitizeFilePart(item) : { ...item };

    if (type === 'tool' && isRecord(part.state)) {
      part.state = sanitizeToolState(part.tool, part.state, tools);
    }

    if (typeof part.text === 'string') part.text = text.spend(part.text);

    out.push(part);
  }
  return out;
}

/**
 * Pure: does this stored part array carry a settled tool call without its
 * input? Only the old mirror wrote that shape (it stripped every tool call's
 * input, output and error); `sanitizeParts` never does. Such a row is
 * complete by every other test, so without this a walk would stop on it and
 * the history would stay stripped forever.
 */
export function mirrorPartsAreStripped(parts: unknown): boolean {
  if (!Array.isArray(parts)) return false;
  return parts.some(
    (part) =>
      isRecord(part) &&
      part.type === 'tool' &&
      isRecord(part.state) &&
      isSettledToolStatus(part.state.status) &&
      !('input' in part.state),
  );
}

const SKILL_TITLE = 'Loaded skill: ';
const isUrl = (value: string) => /^https?:\/\//.test(value) && !/\s/.test(value);
const filePathInput = (absolute: unknown, title: string) =>
  typeof absolute === 'string' && absolute ? { filePath: absolute } : title ? { filePath: title } : null;

/**
 * The input a stripped call's kept `title` and `metadata` prove, per tool, as
 * OpenCode 1.17.11 to 1.18.23 writes them (`packages/opencode/src/tool/*.ts`).
 * The old mirror ran against no other version, so this table never changes.
 */
const STRIPPED_CALL_INPUT = new Map<
  string,
  (title: string, metadata: Record<string, unknown>) => Record<string, unknown> | null
>([
  // shell.ts: `title: input.command`.
  ['bash', (title) => (title ? { command: title } : null)],
  // read.ts: the title is the path relative to the worktree; `display.path` is absolute.
  ['read', (title, metadata) => filePathInput(isRecord(metadata.display) ? metadata.display.path : undefined, title)],
  // edit.ts: `filediff.file` is the absolute path.
  ['edit', (title, metadata) => filePathInput(isRecord(metadata.filediff) ? metadata.filediff.file : undefined, title)],
  // write.ts: `metadata.filepath` is the absolute path.
  ['write', (title, metadata) => filePathInput(metadata.filepath, title)],
  // grep.ts: `title: params.pattern`.
  ['grep', (title) => (title ? { pattern: title } : null)],
  // glob.ts: the title is the searched directory, relative to the worktree.
  ['glob', (title) => (title ? { path: title } : null)],
  // task.ts: `title: params.description`.
  ['task', (title) => (title ? { description: title } : null)],
  // webfetch.ts: `title: `${params.url} (${contentType})``.
  [
    'webfetch',
    (title) => {
      const cut = title.lastIndexOf(' (');
      const url = cut > 0 && title.endsWith(')') ? title.slice(0, cut) : '';
      return isUrl(url) ? { url } : null;
    },
  ],
  // todo.ts: `metadata.todos` is `params.todos`.
  ['todowrite', (_title, metadata) => (Array.isArray(metadata.todos) ? { todos: metadata.todos } : null)],
  // skill.ts: `title: `Loaded skill: ${info.name}``.
  [
    'skill',
    (title) =>
      title.startsWith(SKILL_TITLE) && title.length > SKILL_TITLE.length
        ? { name: title.slice(SKILL_TITLE.length) }
        : null,
  ],
]);

/**
 * Pure: a part array as a read serves it. Each tool call the old mirror
 * stripped gets back the input its kept `title` and `metadata` prove (see
 * `STRIPPED_CALL_INPUT`), and a completed command gets back its output from
 * `metadata.output` (shell.ts: the output's last 30,000 characters). A client
 * then draws the call with its own renderer instead of an empty row.
 *
 * Nothing is invented: a call that proves no input is served as stored. The
 * stored row is never changed, so `mirrorPartsAreStripped` still finds it and
 * a wake still captures it again 1:1.
 */
export function restoreStrippedToolParts(
  parts: ReadonlyArray<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  return parts.map((part) => {
    if (!isRecord(part) || part.type !== 'tool' || !isRecord(part.state)) return part;
    const state = part.state;
    if (!isSettledToolStatus(state.status) || 'input' in state) return part;
    const tool = normalizeToolName(part.tool);
    const metadata = isRecord(state.metadata) ? state.metadata : {};
    const title = typeof state.title === 'string' ? state.title : '';
    const input = STRIPPED_CALL_INPUT.get(tool)?.(title, metadata);
    if (!input) return part;
    // An `error` state carries an error, never an output, and this row lost it.
    const output =
      tool === 'bash' && state.status === 'completed' && typeof metadata.output === 'string'
        ? { output: metadata.output }
        : {};
    return { ...part, state: { ...state, input, ...output } };
  });
}

/**
 * Pure: the index the capture's early stop reads (see `capturedPageGate`):
 * message id -> stored `message_completed_at` in epoch ms, null when stored
 * but not completed. A row in the old stripped format is left OUT, so a walk
 * reads past it and the capture writes it again, 1:1.
 */
export function capturedMessageIndex(
  rows: ReadonlyArray<{ messageId: string; parts: unknown; messageCompletedAt: Date | null }>,
): Map<string, number | null> {
  const index = new Map<string, number | null>();
  for (const row of rows) {
    if (mirrorPartsAreStripped(row.parts)) continue;
    index.set(row.messageId, row.messageCompletedAt?.getTime() ?? null);
  }
  return index;
}

// ── Sub-agent sessions ──────────────────────────────────────────────────────
//
// A sub-agent runs in its OWN OpenCode session, and its row in the parent opens
// that session's transcript. The mirror keeps those transcripts under the same
// Kortix session (rows carry their own `opencode_session_id`), so the row opens
// onto its steps while the computer is off too.

/** Tools that dispatch a sub-agent: the SDK's `getChildSessionId` list. */
const SUBAGENT_TOOLS = new Set([
  'task',
  'agent_spawn',
  'agent-spawn',
  'agent_message',
  'agent-message',
  'agent_task',
  'agent-task',
  'agent_task_update',
  'agent-task-update',
  'agent_task_message',
  'agent-task-message',
  'agent_task_start',
  'agent-task-start',
  'task_create',
  'task-create',
  'task_start',
  'task-start',
  'task_update',
  'task-update',
  'task_message',
  'task-message',
]);
const SESSION_ID_IN_TEXT = /\bses_[a-zA-Z0-9]+/;
const SPAWNED_SESSION_IN_OUTPUT = /\*?\*?Session:?\*?\*?\s*(ses_[a-zA-Z0-9]+)/;

/**
 * Pure: the OpenCode session a tool call dispatched, by the renderer's own
 * rule (the SDK's `getChildSessionId`; `session-transcript-children.test.ts`
 * holds the two equal). A copy rather than an import: the SDK's root barrel
 * is not loaded into the API for one function.
 */
export function childSessionIdOf(part: unknown): string | undefined {
  if (!isRecord(part)) return undefined;
  const tool = typeof part.tool === 'string' ? part.tool : '';
  const state = isRecord(part.state) ? part.state : undefined;
  if (SUBAGENT_TOOLS.has(tool)) {
    const fromMetadata = isRecord(state?.metadata) ? state.metadata.sessionId : undefined;
    if (typeof fromMetadata === 'string' && fromMetadata) return fromMetadata;
    if (typeof state?.title === 'string' && state.title) {
      const match = state.title.match(SESSION_ID_IN_TEXT);
      if (match) return match[0];
    }
    if (typeof state?.output === 'string' && state.output) {
      const match = state.output.match(SESSION_ID_IN_TEXT);
      if (match) return match[0];
    }
    return undefined;
  }
  const name = tool.replace(/-/g, '_');
  if ((name === 'session_spawn' || name === 'session_start_background') && typeof state?.output === 'string') {
    return state.output.match(SPAWNED_SESSION_IN_OUTPUT)?.[1];
  }
  return undefined;
}

export interface ChildSessionReference {
  id: string;
  /** Every call that references the session has ended, so the sub-agent has too. */
  settled: boolean;
}

/** Pure: the sub-agent sessions these rows dispatched, in order, each once. */
export function childSessionReferences(
  rows: ReadonlyArray<{ parts: unknown }>,
): ChildSessionReference[] {
  const found = new Map<string, boolean>();
  for (const row of rows) {
    if (!Array.isArray(row.parts)) continue;
    for (const part of row.parts) {
      const id = childSessionIdOf(part);
      if (!id) continue;
      const settled = isRecord(part) && isRecord(part.state) && isSettledToolStatus(part.state.status);
      found.set(id, (found.get(id) ?? true) && settled);
    }
  }
  return [...found].map(([id, settled]) => ({ id, settled }));
}

/**
 * Pure: which sub-agent transcripts one capture reads, at most `limit`.
 *
 * A sub-agent whose dispatching call ended, and whose saved transcript has no
 * open message, is final: it is never read again. One that is new, still
 * running, or saved mid-flight is read. So each finished sub-agent costs one
 * read in its life, not one per turn end.
 */
export function childSessionsToCapture(input: {
  references: ReadonlyArray<ChildSessionReference>;
  /** Sub-agent session id -> every stored message of it has ended. */
  stored: ReadonlyMap<string, { settled: boolean }>;
  limit: number;
}): string[] {
  return input.references
    .filter((reference) => {
      const saved = input.stored.get(reference.id);
      return !saved || !reference.settled || !saved.settled;
    })
    .map((reference) => reference.id)
    .slice(0, Math.max(0, input.limit));
}

/**
 * Does this session's mirror still hold a row in the old stripped format? The
 * same question as `mirrorPartsAreStripped`, asked of the database: the wake
 * backfill reads the box again for such a history, because a mirror that
 * proved its head is otherwise left alone for good.
 */
export async function mirrorHoldsStrippedRows(sessionId: string): Promise<boolean> {
  const result = await db.execute(sql`
    SELECT EXISTS (
      SELECT 1 FROM kortix.session_transcript_messages
       WHERE session_id = ${sessionId}
         AND parts @? '$[*] ? (@.type == "tool" && (@.state.status == "completed" || @.state.status == "error") && !(exists (@.state.input)))'
    ) AS stripped
  `);
  const rows = Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? []);
  return (rows[0] as { stripped?: unknown } | undefined)?.stripped === true;
}

/**
 * Pure: a mirror window bounded by size. Keeps the NEWEST messages whose
 * serialized size fits `maxChars`, and always at least one, so paging older
 * always moves. A cut window points its cursor at the oldest message it kept:
 * the next window starts strictly behind it.
 */
export function boundMirrorWindow(mirror: MirrorSnapshot, maxChars: number): MirrorSnapshot {
  const { messages } = mirror;
  let start = messages.length;
  let size = 0;
  while (start > 0) {
    const next = JSON.stringify(messages[start - 1]).length;
    if (start < messages.length && size + next > maxChars) break;
    size += next;
    start -= 1;
  }
  if (start === 0) return mirror;
  const kept = messages.slice(start);
  return { ...mirror, messages: kept, next_cursor: String(kept[0].info.id) };
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
 * one. The one empty window it serves is a PROVEN one: a complete read of the
 * runtime that found no messages (`total: 0`, `head_complete: true`).
 *
 * Rows the old mirror stripped are served with what they kept
 * (`restoreStrippedToolParts`).
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
  /**
   * A sub-agent's OpenCode session inside this session. Omitted: the root.
   * A window holds ONE OpenCode session's messages: the mirror also stores
   * the transcripts of the sub-agents the root dispatched, and a root read
   * must never interleave them into the conversation.
   */
  opencodeSessionId?: string | null;
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

      const target = input.opencodeSessionId || state.opencodeSessionId;
      const scope = target
        ? and(
            eq(sessionTranscriptMessages.sessionId, input.sessionId),
            eq(sessionTranscriptMessages.opencodeSessionId, target),
          )
        : eq(sessionTranscriptMessages.sessionId, input.sessionId);

      const [totals] = await tx
        .select({ total: count() })
        .from(sessionTranscriptMessages)
        .where(scope);
      const total = totals?.total ?? 0;
      if (total === 0) {
        // A complete read of the runtime that found no messages is stored as a
        // head-complete mirror with no rows: the proof that the conversation
        // is empty, which lets a client open it without waiting for its
        // computer. Every other empty read is "nothing saved".
        const provenEmpty =
          !input.before && !input.opencodeSessionId && state.headComplete && !!state.opencodeSessionId;
        return provenEmpty
          ? {
              opencode_session_id: state.opencodeSessionId,
              root_opencode_session_id: state.opencodeSessionId,
              captured_at: new Date(state.capturedAt).toISOString(),
              total: 0,
              head_complete: true,
              next_cursor: null,
              messages: [],
            }
          : null;
      }

      let anchor: { messageCreatedAt: Date | null; messageId: string } | null = null;
      if (input.before) {
        const [row] = await tx
          .select({
            messageCreatedAt: sessionTranscriptMessages.messageCreatedAt,
            messageId: sessionTranscriptMessages.messageId,
          })
          .from(sessionTranscriptMessages)
          .where(and(scope, eq(sessionTranscriptMessages.messageId, input.before)))
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
        .where(older ? and(scope, older) : scope)
        .orderBy(
          sql`${sessionTranscriptMessages.messageCreatedAt} DESC NULLS LAST`,
          sql`${sessionTranscriptMessages.messageId} DESC`,
        )
        .limit(input.limit + 1);

      const hasOlder = window.length > input.limit;
      const kept = hasOlder ? window.slice(0, input.limit) : window;

      return {
        opencode_session_id: target ?? null,
        root_opencode_session_id: state.opencodeSessionId ?? null,
        captured_at: new Date(state.capturedAt).toISOString(),
        total,
        // A sub-agent's rows are written only from a read that reached its
        // first message (see the capture), so a stored child is whole.
        head_complete: input.opencodeSessionId ? true : state.headComplete,
        // The oldest row IN this window, so the next request starts strictly
        // behind it. Null when this window already reaches the oldest row.
        next_cursor: hasOlder ? (kept.at(-1)?.messageId ?? null) : null,
        messages: kept.reverse().map((row) => ({
          info: (row.info ?? {}) as Record<string, unknown>,
          parts: restoreStrippedToolParts((Array.isArray(row.parts) ? row.parts : []) as Array<Record<string, unknown>>),
        })),
      };
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  );
}
