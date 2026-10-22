/**
 * The ONE projection from an OpenCode message envelope to the compact
 * transcript row the API returns.
 *
 * It lives in its own module because two sources now feed it — the live
 * sandbox read (`session-transcript.ts`) and the durable mirror
 * (`session-transcript-mirror.ts`). Two copies of this function would let the
 * mirror and the live read disagree about what a message IS, which is exactly
 * the class of drift that produces a "ghost" when a client settles one against
 * the other.
 */

/** The compact row and its tool calls are wire shapes: `@kortix/api-contract`. */
export type {
  SessionTranscriptMessage as CompactMessage,
} from '@kortix/api-contract';
import type { SessionTranscriptMessage as CompactMessage } from '@kortix/api-contract';

export type RawOpencodePart = {
  type?: string;
  text?: string;
  synthetic?: boolean;
  tool?: string;
  state?: { status?: string; input?: unknown; output?: unknown; error?: unknown };
  filename?: string;
  mime?: string;
};

export type RawOpencodeMessage = {
  info?: {
    id?: string;
    parentID?: string | null;
    role?: string;
    time?: { created?: number; completed?: number };
    error?: { name?: string; message?: string } | null;
  };
  id?: string;
  parentID?: string | null;
  role?: string;
  time?: { created?: number; completed?: number };
  error?: { name?: string; message?: string } | null;
  parts?: RawOpencodePart[];
};

export function normalizeMessageList(payload: unknown): RawOpencodeMessage[] {
  const list = Array.isArray(payload)
    ? payload
    : typeof payload === 'object' &&
        payload &&
        'messages' in payload &&
        Array.isArray((payload as { messages?: unknown }).messages)
      ? (payload as { messages: unknown[] }).messages
      : [];
  return list.filter((m): m is RawOpencodeMessage => typeof m === 'object' && m !== null);
}

/**
 * `full` is the reader-facing variant (the MCP `read_session` tool): line breaks
 * survive, so code and command output stay legible, and each tool call carries
 * its input and output. The default stays the one-line digest the CLI prints.
 */
export function compactMessage(msg: RawOpencodeMessage, maxChars: number, full = false): CompactMessage {
  const info = msg.info ?? msg;
  const parts = Array.isArray(msg.parts) ? msg.parts : [];
  const text = parts
    .filter((p) => p.type === 'text' && !p.synthetic && typeof p.text === 'string')
    .map((p) => p.text as string)
    .filter(Boolean)
    .join('\n');
  const tools = parts
    .filter((p) => p.type === 'tool')
    .map((p) => ({
      tool: p.tool ?? 'tool',
      status: p.state?.status ?? null,
      ...(full
        ? {
            input: truncateMarked(JSON.stringify(p.state?.input ?? {}), maxChars),
            output: truncateMarked(stringify(p.state?.output ?? p.state?.error ?? ''), maxChars),
          }
        : {}),
    }));
  const files = parts
    .filter((p) => p.type === 'file')
    .map((p) => ({
      filename: p.filename ?? null,
      mime: p.mime ?? null,
    }));
  return {
    id: typeof info.id === 'string' && info.id ? info.id : null,
    parent_id: typeof info.parentID === 'string' && info.parentID ? info.parentID : null,
    role: info.role ?? 'unknown',
    created: info.time?.created ? new Date(info.time.created).toISOString() : null,
    completed: info.time?.completed ? new Date(info.time.completed).toISOString() : null,
    // `full` readers get the whole answer (up to FULL_TEXT_CHARS); `maxChars`
    // bounds the digest and each tool call's input and output.
    text: full ? truncateMarked(text.trim(), FULL_TEXT_CHARS) : truncate(normalizeWhitespace(text), maxChars),
    tools,
    files,
    reasoning_omitted: parts.some((p) => p.type === 'reasoning'),
    error: info.error ?? null,
  };
}

/** The final answer of a `detail: 'full'` read is cut here, not at `chars`. */
const FULL_TEXT_CHARS = 16_000;

/** Like `truncate`, but says how much was kept and how long the whole was. */
function truncateMarked(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}…[truncated: ${max} of ${s.length} chars]`;
}

function stringify(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function normalizeWhitespace(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, Math.max(0, max - 1))}…`;
}
