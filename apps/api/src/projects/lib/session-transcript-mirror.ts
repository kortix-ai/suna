/**
 * The v1 transcript window shape the session-log reads answer in (`MirrorSnapshot`,
 * `boundMirrorWindow`, `UnknownTranscriptCursorError`), and `restoreStrippedToolParts`: a
 * tool call an old mirror row stored without its input (before 2026-09-28) gets back the
 * input its title and metadata prove.
 */

import { isRecord } from '@kortix/shared/guards';

/** Per string: a text-like part, or one string in a tool call's payload. Real
 *  messages are 2-10 KB and OpenCode cuts a tool's output at 50 KB, so this
 *  only stops one pathological string from becoming a pathological row. */
export const MIRROR_MAX_PART_CHARS = 200_000;

/** One sync window, serialized. A cold open waits for the first window, and
 *  1:1 tool payloads make 40 messages of a tool-heavy thread megabytes. The
 *  window keeps its NEWEST messages that fit; the rest is one cursor away. */
export const MIRROR_WINDOW_MAX_CHARS = 1_000_000;

/** One mirrored message in the shape the sync store hydrates from. */
export interface MirrorMessage {
  /** OpenCode's message envelope, verbatim (`Message` in @opencode-ai/sdk). */
  info: Record<string, unknown>;
  /** The message's parts. */
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

/** Same normalization as the SDK's `normalizeActivityToolName`. */
const normalizeToolName = (name: unknown) =>
  (typeof name === 'string' ? name : '').replace(/^oc-/, '').replace(/-/g, '_');

/** A tool call that has ended. OpenCode's schema gives both a required `input`. */
const isSettledToolStatus = (status: unknown) => status === 'completed' || status === 'error';

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
