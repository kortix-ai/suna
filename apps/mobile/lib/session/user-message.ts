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
  /** Quoted `<reply_context>` text, or null. */
  replyContext: string | null;
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
 * Strip every structured block a user message carries and keep what the user
 * typed. Order matches web's pipeline: kortix_system, reply context, uploads,
 * project refs, file refs, agent refs, session refs.
 */
export function parseUserMessageText(raw: string): ParsedUserMessageText {
  let text = (raw ?? '').replace(/<kortix_system[^>]*>[\s\S]*?<\/kortix_system>/gi, '');
  text = text.replace(/\n{3,}/g, '\n\n').trim();

  let replyContext: string | null = null;
  const reply = text.match(/<reply_context>([\s\S]*?)<\/reply_context>/);
  if (reply) {
    replyContext = reply[1]!.trim();
    text = text.replace(/<reply_context>[\s\S]*?<\/reply_context>\s*/, '').trim();
  }

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

  return { text, replyContext, files, sessions };
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
