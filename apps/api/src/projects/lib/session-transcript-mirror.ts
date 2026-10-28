/**
 * The v1 transcript row projections, pure.
 *
 * The v1 mirror tables (`session_transcript_mirrors`, `session_transcript_messages`) were the
 * server-side copy of a session's transcript until the session log replaced them (P8). Nothing
 * reads or writes them through this module any more (P8.2): the conversion of an old mirror into
 * the log is `writeSessionLogFromMirror` (`../session-log-capture.ts`). What stays here is the row
 * shape both paths share:
 *
 * - `mirrorRowsFromOpencodePayload` / `sanitizeParts`: a box's `GET /session/:id/message` payload
 *   as v1 rows. A message with no id is dropped, never synthesized. Every part is kept 1:1 except
 *   attachment bytes: a file part's `url` goes unless it is a private attachment reference (base64
 *   data URLs made transcript bodies 7-19 MB), and so does any `data:` URL in a tool payload.
 *   Strings are bounded only against pathological sizes (`MIRROR_MAX_PART_CHARS`).
 * - `restoreStrippedToolParts`: a tool call an old mirror row stored without its input (before
 *   2026-09-28) gets back the input its title and metadata prove.
 * - The sub-agent walk (`readChildTranscripts`) and the v1 window shape (`MirrorSnapshot`,
 *   `boundMirrorWindow`, `UnknownTranscriptCursorError`) the log reads answer in.
 */

import { parseSessionAttachmentRef } from '@kortix/shared';
import { isRecord } from '@kortix/shared/guards';
import { jsonbSafeValue } from '../../shared/jsonb-safe';
import { TranscriptReadError, isRuntimeUnavailableError } from './runtime-read-failure';

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

/** A tool call that has ended. OpenCode's schema gives both a required `input`. */
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
  // settled call WITHOUT one is a row an old mirror stripped.
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
 * Nothing is invented: a call that proves no input is served as stored.
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
    if (tool === 'task' && state?.status === 'error') {
      // An errored task names its child only in the error text (the SDK's
      // rule); the legacy title/output fallbacks never apply once it errored.
      return typeof state.error === 'string'
        ? state.error.match(/\btask_id:\s*(ses_[A-Za-z0-9]+)/)?.[1]
        : undefined;
    }
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
 * Pure: which sub-agent transcripts a capture reads.
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
}): string[] {
  return input.references
    .filter((reference) => {
      const saved = input.stored.get(reference.id);
      return !saved || !reference.settled || !saved.settled;
    })
    .map((reference) => reference.id);
}

/** Only an OpenCode session id may reach a URL or a row. */
const CHILD_SESSION_ID = /^ses_[A-Za-z0-9]{1,124}$/;

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * How one capture's sub-agent reads failed, classified.
 *
 * The classes are the expected states a fail-open capture tolerates — a
 * stopped box (502/503/504 through the proxy, a transport timeout) and a
 * runtime that no longer serves a referenced transcript (404, a box that
 * came back without its sub-agent sessions) — plus everything else.
 * `readInboxTranscriptState` and the capture share
 * `isRuntimeUnavailableError` for the same distinction.
 */
export interface ChildReadFailures {
  /** The runtime answers 404 for this transcript: re-reading changes nothing. */
  missing: number;
  /** The runtime stopped serving transcripts mid-walk. Every further read
   *  would fail the same way, so the walk stops at the first one. */
  unavailable: number;
  /** Anything else — the only class a capture still warns about. */
  other: number;
  /** The first failure of the expected classes, for the info line. */
  first?: string;
  /** The first unexpected failure, for the warn line. */
  firstOther?: string;
}

/**
 * The one log line a capture's failed sub-agent reads earn.
 *
 * Expected states (a stopped box, gone transcripts) log info — warning on
 * them was a 637-line spike over four days, every line an expected fail-open
 * degrade. Only an unexpected failure warns, with the count of unexpected
 * ones. Null when nothing failed.
 */
export function childReadFailureLog(
  failures: ChildReadFailures,
): { level: 'warn' | 'info'; message: string; context: Record<string, unknown> } | null {
  if (failures.missing + failures.unavailable + failures.other === 0) return null;
  if (failures.other > 0) {
    return {
      level: 'warn',
      message: '[transcript-mirror] sub-agent reads failed',
      context: { count: failures.other, first: failures.firstOther ?? failures.first },
    };
  }
  return {
    level: 'info',
    message: '[transcript-mirror] sub-agent reads deferred',
    context: { missing: failures.missing, unavailable: failures.unavailable, first: failures.first },
  };
}

/**
 * The sub-agent transcripts one capture saves, read through `read`, and whether
 * another capture saves more.
 *
 * Breadth-first from `references`, following each read's own sub-agents. At most
 * `cap` reads that return rows: a failed read and an empty one take no slot (the
 * capture's deadline bounds them), so neither starves the sub-agents after it;
 * only a runtime that cannot serve any transcript stops the walk early.
 *
 * `more`: sub-agents are left unread AND this capture read rows of one never saved
 * before. A sub-agent that reads empty, fails, or was saved already (an unsettled
 * one read again) is no progress, so a run of captures ends.
 */
export async function readChildTranscripts(input: {
  references: ReadonlyArray<ChildSessionReference>;
  stored: ReadonlyMap<string, { settled: boolean }>;
  cap: number;
  /** The root: never read as a sub-agent. */
  root?: string;
  read: (id: string) => Promise<{ rows: unknown[]; complete: boolean }>;
}): Promise<{
  children: Array<{ opencodeSessionId: string; payload: unknown[]; complete: boolean }>;
  more: boolean;
  failures: ChildReadFailures;
}> {
  const children: Array<{ opencodeSessionId: string; payload: unknown[]; complete: boolean }> = [];
  const failures: ChildReadFailures = { missing: 0, unavailable: 0, other: 0 };
  const seen = new Set(input.root ? [input.root] : []);
  const queue = childSessionsToCapture(input);
  let savedNew = false;
  while (queue.length > 0 && children.length < input.cap) {
    const child = queue.shift()!;
    if (seen.has(child) || !CHILD_SESSION_ID.test(child)) continue;
    seen.add(child);
    try {
      const walk = await input.read(child);
      queue.push(...childSessionsToCapture({ references: childSessionReferences(walk.rows as Array<{ parts: unknown }>), stored: input.stored }));
      if (mirrorRowsFromOpencodePayload(walk.rows).length === 0) continue;
      children.push({ opencodeSessionId: child, payload: walk.rows, complete: walk.complete });
      savedNew ||= walk.complete && !input.stored.has(child);
    } catch (error) {
      // 404 is its own class: re-reading a transcript the runtime no longer
      // serves changes nothing, while a stopped box may come back.
      const kind = error instanceof TranscriptReadError && error.status === 404
        ? 'missing'
        : isRuntimeUnavailableError(error)
          ? 'unavailable'
          : 'other';
      failures[kind] += 1;
      if (kind === 'other') failures.firstOther ??= messageOf(error);
      else failures.first ??= messageOf(error);
      // A runtime that cannot serve ANY transcript repeats the same failure
      // for every sibling — walking on pays it per child (one prod capture
      // failed 60 reads in a row against a dying box). Stop only for that
      // class and let the next capture, or the unread chain, take the rest;
      // a missing transcript 404s per child, instantly, and one gone child
      // must not starve the siblings after it.
      if (kind === 'unavailable') break;
    }
  }
  const unread = queue.some((child) => !seen.has(child) && CHILD_SESSION_ID.test(child));
  return { children, more: unread && savedNew, failures };
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
    rows.push({ info: jsonbSafeValue(info), parts: jsonbSafeValue(sanitizeParts(msg.parts)) });
  }
  return rows;
}

/**
 * A `before` cursor that names no message this session has stored.
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
