/**
 * Pure logic behind `components/session/turn/user-message.tsx`: parsing the
 * visible text out of a user message, its meta line, the queued/interrupted
 * state, and which messages an edit rewinds. Ported from apps/web
 * `features/session/message-parsing.tsx`, `turn/user-message.tsx`,
 * `turn/queued-prompt-bubbles.tsx`, and `session-chat.tsx`.
 */

import { formatMessageDay, isAbortError } from '@kortix/sdk';

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

function unescapeAttr(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

const FILE_TAG_REGEX = /<file\s+([^>]*?)>\s*[\s\S]*?<\/file>/g;

/**
 * One `<reply_context>` block, open tag through close tag, tolerating
 * attributes on the open tag. Matches web's `REPLY_CONTEXT_BLOCK_RE`
 * (`apps/web/src/features/session/message-parsing.tsx`) exactly: consumes at
 * most ONE trailing newline with the block, so a block on its own line
 * doesn't leave a blank line behind, but other trailing whitespace (spaces,
 * a second newline) is left alone. A leading newline is left alone too, so it
 * stays as the separator for the text before it.
 */
const REPLY_CONTEXT_REGEX = /<reply_context\b[^>]*>([\s\S]*?)<\/reply_context>\n?/g;

/** Undo the one escape `serializeReplyContext` applies on the wire (web `message-parsing.tsx`). */
function decodeReplyContextBody(body: string): string {
  return body.trim().replace(/&lt;\/reply_context&gt;/g, '</reply_context>');
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
  const quotes: string[] = [];
  const stripped = text.replace(REPLY_CONTEXT_REGEX, (_whole, body: string) => {
    quotes.push(decodeReplyContextBody(body));
    return '';
  });
  return { text: stripped.replace(/\n{3,}/g, '\n\n').trim(), quotes };
}

/**
 * Strip every structured block a user message carries and keep what the user
 * typed. Order matches web's pipeline: kortix_system, reply context, uploads,
 * project refs, file refs, agent refs, session refs.
 */
export function parseUserMessageText(raw: string): ParsedUserMessageText {
  let text = (raw ?? '').replace(/<kortix_system[^>]*>[\s\S]*?<\/kortix_system>/gi, '');
  text = text.replace(/\n{3,}/g, '\n\n').trim();

  const { text: withoutQuotes, quotes } = extractReplyContexts(text);
  text = withoutQuotes;

  const files: ParsedFileRef[] = [];
  text = text
    .replace(FILE_TAG_REGEX, (whole, attrs: string) => {
      const pick = (key: string): string | undefined => {
        const m = attrs.match(new RegExp(`\\b${key}="([^"]*?)"`));
        return m ? unescapeAttr(m[1]!) : undefined;
      };
      const path = pick('path');
      const filename = pick('filename');
      if (path === undefined && filename === undefined) return whole;
      files.push({ path: path ?? '', mime: pick('mime') ?? '', filename: filename ?? '' });
      return '';
    })
    .trim();

  text = text
    .replace(/<project_ref\b[\s\S]*?\/>/g, '')
    .replace(/\n*Referenced projects \([^)]*\):\n?/g, '')
    .replace(/<file_ref\b[\s\S]*?\/>/g, '')
    .replace(/\n*Referenced files \([^)]*\):\n?/g, '')
    .replace(/<agent_ref\b[\s\S]*?\/>/g, '')
    .replace(/\n*Referenced agents \([^)]*\):\n?/g, '')
    .trim();

  const sessions: ParsedSessionRef[] = [];
  text = text
    .replace(/<session_ref\s+id="([^"]*?)"\s+title="([^"]*?)"\s*\/>/g, (_, id: string, title: string) => {
      sessions.push({ id, title });
      return '';
    })
    .replace(/\n*Referenced sessions \(use the session_context tool to fetch details when needed\):\n?/g, '')
    .trim();

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
