/**
 * What a transcript shows about a session's history (P5.6), read from the session log:
 * - `isSessionLogRestoreNote`: the note a partial restore leaves for the agent (D3). Not a
 *   person's prompt: render it as a notice.
 * - `sessionLogHarnessSwitches`: where `harness.history` records a switch to another harness.
 * - `sessionLogRestoreNotice`: what a partial restore could not bring back, for the person (D3).
 * - `sessionLogReferencedTexts` / `sessionLogWithFullTexts`: texts the API stored by reference
 *   (F3: a 16 kB preview in the record, the whole text behind `ref`), and the thread with the
 *   ones a host loaded put back.
 * `sessionLogTurns({ hideOutOfContext })` hides the messages the model does not see.
 */
import type { SessionLog, SessionLogBlock, SessionLogMessage, SessionLogThread, ToolResultContent } from '../types';
import type { SessionLogTurn } from './turn';

/** The block id prefix of the D3 restore note (`RESTORE_NOTE_BLOCK_PREFIX` in kortixd's `session-log-boot.ts`). */
const RESTORE_NOTE = 'prt_kortix_restore_g';

/**
 * The note a partial restore leaves for the agent (D3): a user message with one text block whose
 * id starts with `prt_kortix_restore_g`. On v2 it also carries `origin: 'notification'`; the v1
 * transcript has no origin, so the block id is the one test that holds on both. Not a person's
 * prompt: render it as a notice. (Other `origin: 'notification'` messages, such as a sub-agent's
 * completion, carry their own markup, and the agent replies to them: they stay ordinary turns.)
 */
export function isSessionLogRestoreNote(message: Pick<SessionLogMessage, 'role' | 'blocks'>): boolean {
  return message.role === 'user' && message.blocks.some((b) => b.type === 'text' && b.id.startsWith(RESTORE_NOTE));
}

/** A switch to another harness, drawn before the turn it lands on. */
export interface SessionLogHarnessSwitch {
  /** The harness the session continued with. */
  harness: string;
  /** The harness before the switch. */
  previous: string;
  version: string;
  at: string;
}

/**
 * The switches `harness.history` records, by the id of the turn each lands on: the first turn
 * whose prompt `seq` is at or above the entry's `from_seq`. An entry with the same harness as
 * the one before it (a new version) is no switch. A switch whose turn is the first loaded one
 * lands there only when that turn starts at `from_seq` exactly: below it, the switch is in a
 * page not loaded yet.
 */
export function sessionLogHarnessSwitches(
  history: SessionLog['harness']['history'] | undefined,
  turns: ReadonlyArray<Pick<SessionLogTurn, 'id'> & { user: Pick<SessionLogMessage, 'seq'> }>,
): Map<string, SessionLogHarnessSwitch> {
  const out = new Map<string, SessionLogHarnessSwitch>();
  const entries = [...(history ?? [])].sort((a, b) => a.from_seq - b.from_seq);
  for (let i = 1; i < entries.length; i++) {
    const entry = entries[i]!;
    const previous = entries[i - 1]!.harness;
    if (entry.harness === previous) continue;
    const at = turns.findIndex((t) => t.user.seq >= entry.from_seq);
    if (at < 0 || (at === 0 && turns[0]!.user.seq !== entry.from_seq)) continue;
    out.set(turns[at]!.id, { harness: entry.harness, previous, version: entry.version, at: entry.at });
  }
  return out;
}

/** What a partial restore could not bring back. `missing` lists only kinds with a count above zero. */
export interface SessionLogRestoreNotice {
  /** The session generation the restore claimed. */
  generation: number;
  /** `message`: the log was over the API's restore cap, so the agent got none of these earlier messages. */
  missing: Array<{ kind: 'message' | 'attachment' | 'text' | 'tool_input' | 'tool_result' | 'cut_point' | 'other'; count: number }>;
}

type J = Record<string, unknown>;
const isObj = (v: unknown): v is J => typeof v === 'object' && v !== null && !Array.isArray(v);
const count = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);
/** The dropped kinds the grade counts already hold (`layout` counts as `cut_point`), and the two named on their own. */
const COUNTED = new Set(['message', 'attachment', 'tool_input', 'cut_point', 'layout', 'text', 'tool_result']);

/**
 * The D3 notice for the person: the session record a partial restore patched
 * (`restore_grade: 'partial'`, `grade_counts`, `ext.kortix.data.restore`
 * `{ generation, dropped, truncated }`). Null when the grade is not partial, or no restore wrote
 * the record (a log converted from v1 can be partial without a restore). Counts: the grade
 * counts (missing attachments, tool inputs, compaction cut points, the dropped ones included),
 * the messages a log over the restore cap left out (`dropped.message`),
 * the texts dropped or cut to their preview, the dropped tool results, and any other dropped kind.
 */
export function sessionLogRestoreNotice(session: Partial<Pick<SessionLog, 'restore_grade' | 'grade_counts' | 'ext'>> | null | undefined): SessionLogRestoreNotice | null {
  if (session?.restore_grade !== 'partial') return null;
  const data = session.ext?.kortix?.data;
  const restore = isObj(data) ? data.restore : undefined;
  if (!isObj(restore)) return null;
  const dropped = isObj(restore.dropped) ? restore.dropped : {};
  const grade = session.grade_counts;
  const missing: SessionLogRestoreNotice['missing'] = [
    { kind: 'message', count: count(dropped.message) },
    { kind: 'attachment', count: count(grade?.attachment) },
    { kind: 'text', count: count(dropped.text) + count(restore.truncated) },
    { kind: 'tool_input', count: count(grade?.tool_input) },
    { kind: 'tool_result', count: count(dropped.tool_result) },
    { kind: 'cut_point', count: count(grade?.cut_point) },
    { kind: 'other', count: Object.entries(dropped).reduce((n, [k, v]) => (COUNTED.has(k) ? n : n + count(v)), 0) },
  ];
  return { generation: count(restore.generation), missing: missing.filter((m) => m.count > 0) };
}

/** A text the API stored by reference: `ref` names its object, `bytes` is the whole text's UTF-8 length. */
export interface SessionLogReferencedText {
  ref: string;
  bytes: number;
}

type TextItem = { text: string; ref?: string; bytes?: number };
/** The F3 texts a transcript renders: a text block, or a tool result's display text items (`content`; `model_content` is not drawn). */
const textsOf = (b: SessionLogBlock): TextItem[] =>
  b.type === 'text'
    ? [b]
    : b.type === 'tool_call'
      ? (b.result?.content ?? []).filter((c): c is Extract<ToolResultContent, { type: 'text' }> => c.type === 'text')
      : [];

/**
 * Every text in `messages` the API stored by reference (`ref` and `bytes`: the record holds a
 * 16 kB preview) that a transcript renders (text blocks, tool results' `content`), once per
 * `ref`, in record order. Read the whole text with `fetchSessionAttachment(ref)`.
 */
export function sessionLogReferencedTexts(messages: readonly SessionLogMessage[]): SessionLogReferencedText[] {
  const out = new Map<string, number>();
  for (const m of messages) for (const b of m.blocks) for (const t of textsOf(b)) if (t.ref && t.bytes !== undefined && !out.has(t.ref)) out.set(t.ref, t.bytes);
  return [...out].map(([ref, bytes]) => ({ ref, bytes }));
}

const swap = <T extends TextItem>(item: T, texts: ReadonlyMap<string, string>): T => {
  const text = item.ref === undefined ? undefined : texts.get(item.ref);
  if (text === undefined) return item;
  const { ref: _ref, bytes: _bytes, ...rest } = item;
  return { ...rest, text } as T;
};
const swapAll = (items: ToolResultContent[], texts: ReadonlyMap<string, string>) =>
  items.map((c) => (c.type === 'text' ? swap(c, texts) : c));

const filled = new WeakMap<SessionLogMessage, { texts: ReadonlyMap<string, string>; out: SessionLogMessage }>();

/** One message with its loaded texts; the answer is kept per message and `texts` map, unchanged messages included, so each message is read once per map. */
function withTexts(m: SessionLogMessage, texts: ReadonlyMap<string, string>): SessionLogMessage {
  const cached = filled.get(m);
  if (cached?.texts === texts) return cached.out;
  const out = !m.blocks.some((b) => textsOf(b).some((t) => t.ref !== undefined && texts.has(t.ref)))
    ? m
    : {
        ...m,
        blocks: m.blocks.map((b): SessionLogBlock =>
          b.type === 'text' ? swap(b, texts) : b.type === 'tool_call' && b.result ? { ...b, result: { ...b.result, content: swapAll(b.result.content, texts) } } : b,
        ),
      };
  filled.set(m, { texts, out });
  return out;
}

/** Above this many bytes in all, a host offers the texts as a download instead of rendering them inline (a multi-MB text in markdown stalls the page). */
export const SESSION_LOG_FULL_TEXT_INLINE_MAX_BYTES = 1024 * 1024;

/** How a host offers the whole of `refs`: `'inline'` up to {@link SESSION_LOG_FULL_TEXT_INLINE_MAX_BYTES} in all, else `'download'`. */
export function sessionLogFullTextAction(refs: readonly SessionLogReferencedText[]): 'inline' | 'download' {
  return refs.reduce((n, r) => n + r.bytes, 0) > SESSION_LOG_FULL_TEXT_INLINE_MAX_BYTES ? 'download' : 'inline';
}

/**
 * Which of `refs` a host shows inline and which it downloads: the smallest texts fill the inline
 * budget ({@link SESSION_LOG_FULL_TEXT_INLINE_MAX_BYTES} in all) first, the rest download. Both
 * lists keep record order. Nothing downloads exactly when {@link sessionLogFullTextAction} says
 * `'inline'`.
 */
export function sessionLogFullTextPlan(refs: readonly SessionLogReferencedText[]): { inline: SessionLogReferencedText[]; download: SessionLogReferencedText[] } {
  const fits = new Set<SessionLogReferencedText>();
  let total = 0;
  for (const r of [...refs].sort((a, b) => a.bytes - b.bytes)) {
    if (total + r.bytes > SESSION_LOG_FULL_TEXT_INLINE_MAX_BYTES) break;
    total += r.bytes;
    fits.add(r);
  }
  return { inline: refs.filter((r) => fits.has(r)), download: refs.filter((r) => !fits.has(r)) };
}

/**
 * `thread` with each text whose `ref` is in `texts` replaced by the whole text, without its
 * `ref` and `bytes`. A message with no such text keeps its identity, and so does the thread when
 * no message changes; the same message and the same `texts` map give the same object.
 */
export function sessionLogWithFullTexts(thread: SessionLogThread, texts: ReadonlyMap<string, string>): SessionLogThread {
  if (texts.size === 0) return thread;
  const messages = thread.messages.map((m) => withTexts(m, texts));
  return messages.every((m, i) => m === thread.messages[i]) ? thread : { ...thread, messages };
}
