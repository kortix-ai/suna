/**
 * The plain-text transcript that "Share transcript" hands to the native share
 * sheet (KRTX-248). Built from session-log messages (`SessionLogMessage`): the
 * thread's, or the whole history read for the share — no fetch here.
 *
 * Shape: the session title, then one block per speaker turn, "You:" or
 * "Kortix:" on its own line and the visible text under it. Consecutive
 * messages of one role share one label. A tool call is one line, "Tool:
 * <name>" — never its input or output. Reasoning, synthetic and ignored text,
 * system and context messages, and file contents (`<file>` tags in a user
 * message) are dropped. The result is capped at `TRANSCRIPT_MAX_CHARS`, with
 * `TRANSCRIPT_TRUNCATED_LINE` after the cut; the cut never splits a surrogate
 * pair. `incomplete` (older history could not be loaded) puts
 * `TRANSCRIPT_INCOMPLETE_LINE` right under the title.
 */
import type { SessionLogBlock, SessionLogMessage } from '@kortix/sdk';
import { parseUserMessageText, userMessageCopyText } from '@/lib/session/user-message';

/** The share sheet's practical ceiling: messaging apps choke far above this. */
export const TRANSCRIPT_MAX_CHARS = 100_000;
export const TRANSCRIPT_TRUNCATED_LINE = '…truncated';
export const TRANSCRIPT_INCOMPLETE_LINE = 'Earlier messages may not be included.';

export interface TranscriptTextOptions {
  /** Default `TRANSCRIPT_MAX_CHARS`. */
  maxChars?: number;
  /** Older history is missing: adds `TRANSCRIPT_INCOMPLETE_LINE`. */
  incomplete?: boolean;
}

/** `text` cut to at most `max` UTF-16 units, backing off one unit rather than split a surrogate pair. */
function cutAt(text: string, max: number): string {
  const code = text.charCodeAt(max - 1);
  const endsOnHighSurrogate = code >= 0xd800 && code <= 0xdbff;
  return text.slice(0, endsOnHighSurrogate ? max - 1 : max);
}

const ROLE_LABEL = { user: 'You:', assistant: 'Kortix:' } as const;

/** A text block the harness did not write (ignored text is a harness block), trimmed; null when blank. */
function visibleText(block: SessionLogBlock): string | null {
  if (block.type !== 'text' || block.synthetic) return null;
  const value = block.text.trim();
  return value ? value : null;
}

/** The lines one message contributes, in block order. Empty when it shows nothing. */
function messageLines(message: SessionLogMessage): string[] {
  if (message.role === 'user') {
    // A user message's text parts are one prompt: parse them together, as the
    // thread does, so `<file>` bodies and system blocks never leak out.
    const raw = message.blocks.map(visibleText).filter((t): t is string => t !== null).join('\n');
    const parsed = parseUserMessageText(raw);
    // A paste is the user's words: its text goes in, as Copy writes it.
    const shown = userMessageCopyText(parsed.text, parsed.pasted).trim();
    return shown ? [shown] : [];
  }
  const lines: string[] = [];
  for (const block of message.blocks) {
    if (block.type === 'tool_call') {
      lines.push(`Tool: ${block.name}`);
      continue;
    }
    const value = visibleText(block);
    if (value) lines.push(value);
  }
  return lines;
}

/**
 * The transcript for `messages` (store order), or null when no message
 * has anything to show. A blank `title` drops the header line.
 */
export function buildTranscriptText(
  title: string | null | undefined,
  messages: readonly SessionLogMessage[],
  { maxChars = TRANSCRIPT_MAX_CHARS, incomplete = false }: TranscriptTextOptions = {}
): string | null {
  const blocks: { role: 'user' | 'assistant'; lines: string[] }[] = [];
  for (const message of messages) {
    // A system or context message is not the user's or the agent's words.
    if (message.role === 'system' || message.kind === 'context') continue;
    const role = message.role;
    const lines = messageLines(message);
    if (lines.length === 0) continue;
    const last = blocks[blocks.length - 1];
    if (last && last.role === role) last.lines.push(...lines);
    else blocks.push({ role, lines });
  }
  if (blocks.length === 0) return null;

  const sections = blocks.map((block) => `${ROLE_LABEL[block.role]}\n${block.lines.join('\n')}`);
  const heading = title?.trim();
  const head = [heading, incomplete ? TRANSCRIPT_INCOMPLETE_LINE : null].filter((l): l is string => !!l);
  const text = [...head, ...sections].join('\n\n');
  if (text.length <= maxChars) return text;
  return `${cutAt(text, maxChars).trimEnd()}\n\n${TRANSCRIPT_TRUNCATED_LINE}`;
}
