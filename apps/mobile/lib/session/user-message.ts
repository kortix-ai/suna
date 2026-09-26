/**
 * Pure logic behind `components/session/turn/user-message.tsx`: parsing the
 * visible text out of a user message, its meta line, the queued/interrupted
 * state, and which messages an edit rewinds. Ported from apps/web
 * `features/session/message-parsing.tsx`, `turn/user-message.tsx`,
 * `turn/queued-prompt-bubbles.tsx`, and `session-chat.tsx`.
 */

import { formatMessageDay, isAbortError } from '@kortix/sdk';
import {
  fileTagBlocks,
  referenceHeaders,
  removeSpans,
  replaceSpans,
  selfClosingTags,
  tagBlocks,
  type TagBlock,
} from '@kortix/shared';

// ─── Web metrics ─────────────────────────────────────────────────────────────

/**
 * apps/web sets `--spacing: 0.23rem`, so one Tailwind step renders at 3.68px
 * there, not 4px. The user message mirrors web's rendered pixels; this is the
 * one place that conversion lives.
 */
export const WEB_SPACING_PX = 0.23 * 16;

/** Rendered pixels of `n` web spacing steps (`px-3.5` → `webSpace(3.5)`). */
export function webSpace(steps: number): number {
  return steps * WEB_SPACING_PX;
}

// ─── Text parsing ────────────────────────────────────────────────────────────

export interface ParsedFileRef {
  path: string;
  mime: string;
  filename: string;
}

export interface ParsedSessionRef {
  id: string;
  title: string;
}

export interface ParsedUserMessageText {
  /** The text the bubble shows. */
  text: string;
  /** Every `<reply_context>` block's quoted text, in document order. */
  quotes: string[];
  /** Uploaded files referenced by `<file>` tags. */
  files: ParsedFileRef[];
  /** `<session_ref>` mentions. */
  sessions: ParsedSessionRef[];
}

const XML_ATTR_ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '"': '&quot;',
  "'": '&#39;',
  '<': '&lt;',
  '>': '&gt;',
};

/** One-pass attribute escape; same table as the web composer (project-preamble.ts). */
function escapeAttr(value: string): string {
  return value.replace(/[&"'<>]/g, (ch) => XML_ATTR_ESCAPES[ch]!);
}

/**
 * The `Referenced sessions` block the composer appends for session mentions.
 * Same wire shape as the web composer (`buildSessionRefsBlock` in
 * apps/web/src/lib/project-preamble.ts): ids and titles are attribute-escaped,
 * so a title with a quote cannot break the tag.
 */
export function buildSessionRefsBlock(sessions: readonly { id: string; title: string }[]): string {
  if (!sessions.length) return '';
  const refs = sessions
    .map((s) => `<session_ref id="${escapeAttr(s.id)}" title="${escapeAttr(s.title)}" />`)
    .join('\n');
  return `Referenced sessions (${SESSION_REFERENCE_HINT}):\n${refs}`;
}

function unescapeAttr(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/** Pass every `<file …>…</file>` block through `replace(whole, attrs)`. */
function replaceFileTags(text: string, replace: (whole: string, attrs: string) => string): string {
  return replaceSpans(text, fileTagBlocks(text), (block) => replace(text.slice(block.index, block.end), block.attrs));
}

/** Remove every `<tag …/>` and then every `Referenced <noun> (…):` header line. */
function stripReferences(text: string, tag: string, noun: string): string {
  const withoutTags = removeSpans(text, selfClosingTags(text, tag));
  return removeSpans(withoutTags, referenceHeaders(withoutTags, noun));
}

/** The parenthesised text of the `Referenced sessions (…):` header. */
const SESSION_REFERENCE_HINT = 'use the session_context tool to fetch details when needed';

const REPLY_CONTEXT_OPEN = '<reply_context';
const REPLY_CONTEXT_CLOSE = '</reply_context>';
const NEWLINE = 10;
/** A regex `\w` without the `u` flag: `[A-Za-z0-9_]`. */
const WORD_CHAR = /\w/;

/**
 * Every `<reply_context …>…</reply_context>` block, as web's
 * `replyContextBlocks` (`apps/web/src/features/session/reply-context.ts`) and
 * the regex `/<reply_context\b[^>]*>([\s\S]*?)<\/reply_context>\n?/g` found
 * them — the same spans at the same indices — in linear time:
 * - the open tag tolerates attributes, but the name must end there
 *   (`<reply_contextx>` is not a block);
 * - each block ends at the first `</reply_context>` after its open tag;
 * - at most ONE `\n` after the close tag goes with the block, so a block on
 *   its own line does not leave a blank line behind; a leading newline stays;
 * - an unclosed block matches nothing and stays in the text.
 *
 * The regex re-scanned the rest of the message for every opener that never
 * closed: 240k characters took ~1 s with Bun, more with Hermes, on the JS
 * thread on every mount. `tagBlocks` cannot stand in: its `attributes: 'any'`
 * accepts `<reply_contextx>` as an opener. Every search here starts where the
 * previous one stopped, and the scan stops once a `>` or a closer is absent.
 */
function replyContextBlocks(text: string): TagBlock[] {
  const blocks: TagBlock[] = [];
  let from = 0;
  for (;;) {
    const index = text.indexOf(REPLY_CONTEXT_OPEN, from);
    if (index === -1) return blocks;
    const after = index + REPLY_CONTEXT_OPEN.length;
    // `\b`: the name ends in a word character, so the next one must not be.
    if (after < text.length && WORD_CHAR.test(text[after]!)) {
      from = after;
      continue;
    }
    const gt = text.indexOf('>', after);
    if (gt === -1) return blocks;
    const closeAt = text.indexOf(REPLY_CONTEXT_CLOSE, gt + 1);
    if (closeAt === -1) return blocks;
    let end = closeAt + REPLY_CONTEXT_CLOSE.length;
    if (text.charCodeAt(end) === NEWLINE) end += 1;
    blocks.push({ index, end, attrs: text.slice(after, gt), body: text.slice(gt + 1, closeAt) });
    from = end;
  }
}

/** Undo the one escape `serializeReplyContext` applies on the wire (web `reply-context.ts`). */
function decodeReplyContextBody(body: string): string {
  return body.trim().split('&lt;/reply_context&gt;').join('</reply_context>');
}

/**
 * Every `<reply_context>` block in `text`, in order, with all of them
 * removed from the returned text. Blank-line runs left behind by removal are
 * collapsed and the result is trimmed. An unclosed `<reply_context>` (no
 * matching close tag) does not match and is left in the text untouched.
 * Mirrors web's `stripReplyContexts`, but also returns the quotes (web keeps
 * that in `parseReplyContexts`) since mobile has one call site for both.
 */
export function extractReplyContexts(text: string): { text: string; quotes: string[] } {
  const blocks = replyContextBlocks(text);
  const quotes = blocks.map((block) => decodeReplyContextBody(block.body));
  return { text: removeSpans(text, blocks).replace(/\n{3,}/g, '\n\n').trim(), quotes };
}

/**
 * Strip every structured block a user message carries and keep what the user
 * typed. Order matches web's pipeline: kortix_system, reply context, uploads,
 * project refs, file refs, agent refs, session refs.
 *
 * Every tag is found with a scanner from `@kortix/shared/tag-blocks`, never a
 * lazy regex. The regexes re-scanned the rest of the message for each tag that
 * never closed: a 240k-character message took ~1 s per tag kind with Bun on a
 * laptop, more with Hermes on a phone, on every mount of the message.
 */
export function parseUserMessageText(raw: string): ParsedUserMessageText {
  let text = raw ?? '';
  text = removeSpans(text, tagBlocks(text, 'kortix_system', { attributes: 'any', ignoreCase: true }));
  text = text.replace(/\n{3,}/g, '\n\n').trim();

  const { text: withoutQuotes, quotes } = extractReplyContexts(text);
  text = withoutQuotes;

  const files: ParsedFileRef[] = [];
  text = replaceFileTags(text, (whole, attrs) => {
    const pick = (key: string): string | undefined => {
      const m = attrs.match(new RegExp(`\\b${key}="([^"]*?)"`));
      return m ? unescapeAttr(m[1]!) : undefined;
    };
    const path = pick('path');
    const filename = pick('filename');
    if (path === undefined && filename === undefined) return whole;
    files.push({ path: path ?? '', mime: pick('mime') ?? '', filename: filename ?? '' });
    return '';
  }).trim();

  text = stripReferences(text, 'project_ref', 'projects');
  text = stripReferences(text, 'file_ref', 'files');
  text = stripReferences(text, 'agent_ref', 'agents').trim();

  const sessions: ParsedSessionRef[] = [];
  text = text.replace(/<session_ref\s+id="([^"]*?)"\s+title="([^"]*?)"\s*\/>/g, (_, id: string, title: string) => {
    // `buildSessionRefsBlock` (and the web composer) escape both attributes.
    sessions.push({ id: unescapeAttr(id), title: unescapeAttr(title) });
    return '';
  });
  text = removeSpans(text, referenceHeaders(text, 'sessions', SESSION_REFERENCE_HINT)).trim();

  return { text, quotes, files, sessions };
}

/**
 * What a `/command` bubble shows (`body`) and what Copy/Edit use (`prompt`).
 *
 * `detectCommandFromText` returns the args raw, and a quote the user replied
 * with sits in them as a `<reply_context>` block — so the body drew the raw
 * XML under the quote the bubble already draws from `quotes`. Stripping here
 * draws the quote once and keeps the XML out of the copied/edited text.
 */
export function commandMessageText(
  name: string,
  args: string | undefined,
): { body: string; prompt: string } {
  const body = extractReplyContexts(args ?? '').text;
  return { body, prompt: body ? `/${name} ${body}` : `/${name}` };
}

/**
 * Bottom margin under quote `index` of `count` in a bubble: the `mb-2` gap to
 * whatever follows, and none under the last quote when no text follows —
 * otherwise a quote-only bubble ends on an empty band.
 */
export function quoteMarginBottom(index: number, count: number, hasText: boolean): number {
  return index < count - 1 || hasText ? webSpace(2) : 0;
}

interface PartLike {
  type: string;
  text?: string;
  synthetic?: boolean;
  ignored?: boolean;
  metadata?: { edited?: boolean } | Record<string, unknown>;
}

/** Web's rule: any visible (non-synthetic, non-ignored, non-empty) text part with `metadata.edited`. */
export function isUserMessageEdited(parts: readonly PartLike[]): boolean {
  return parts.some(
    (part) =>
      part.type === 'text' &&
      Boolean(part.text?.trim()) &&
      !part.synthetic &&
      !part.ignored &&
      Boolean((part.metadata as { edited?: boolean } | undefined)?.edited),
  );
}

// ─── Meta line ───────────────────────────────────────────────────────────────

/** The items of the meta line under a bubble: relative time, then "edited". */
export function userMessageMetaItems({
  timestamp,
  edited,
  now,
}: {
  timestamp: number | null;
  edited: boolean;
  now: number;
}): string[] {
  const items: string[] = [];
  const label = timestamp !== null ? formatMessageDay(timestamp, now) : '';
  if (label) items.push(label);
  if (edited) items.push('edited');
  return items;
}

// ─── Queued prompt state ─────────────────────────────────────────────────────

/** `interrupted`: a Stop ended the turn before a step opened under this message; it runs with the next send. */
export type QueuedPromptState = 'queued' | 'interrupted';

/** A plainly queued bubble says nothing — the dim is the state. */
export function queuedPromptStatusLabel(state: QueuedPromptState): string | null {
  return state === 'interrupted' ? 'Queued — runs with your next message' : null;
}

interface TurnLike {
  userMessage: { info: { id: string } };
  assistantMessages: ReadonlyArray<{ info: unknown }>;
}

/**
 * User messages a Stop stranded: the session is idle, the newest turn with
 * assistant content ended by abort, and these turns came after it with
 * nothing under them. Port of `interruptedTurnIds` in web `session-chat.tsx`.
 */
export function interruptedTurnIds(turns: readonly TurnLike[], sessionWorking: boolean): Set<string> {
  if (sessionWorking) return new Set();
  let newestWithContent = -1;
  for (let i = turns.length - 1; i >= 0; i--) {
    if (turns[i]!.assistantMessages.length > 0) {
      newestWithContent = i;
      break;
    }
  }
  if (newestWithContent < 0 || newestWithContent === turns.length - 1) return new Set();
  const last = turns[newestWithContent]!.assistantMessages.at(-1);
  if (!last || !isAbortError((last.info as { error?: unknown }).error)) return new Set();
  return new Set(turns.slice(newestWithContent + 1).map((t) => t.userMessage.info.id));
}

// ─── Edit (rewind) ───────────────────────────────────────────────────────────

interface MessageLike {
  info: { id: string; time?: { created?: number } };
}

/**
 * The messages an edit at `messageId` abandons: the boundary and every message
 * after it, ordered by `time.created` with the id as the tie-break (the order
 * the server's `MessageV2.latest()` uses). Empty when the boundary is unknown.
 */
export function rewindHiddenMessageIds(messages: readonly MessageLike[], messageId: string): string[] {
  const sorted = [...messages].sort((a, b) => {
    const ca = a.info.time?.created ?? 0;
    const cb = b.info.time?.created ?? 0;
    if (ca !== cb) return ca - cb;
    return a.info.id < b.info.id ? -1 : a.info.id > b.info.id ? 1 : 0;
  });
  const index = sorted.findIndex((m) => m.info.id === messageId);
  if (index < 0) return [];
  return sorted.slice(index).map((m) => m.info.id);
}
