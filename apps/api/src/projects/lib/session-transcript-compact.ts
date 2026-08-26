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

export interface CompactToolCall {
  tool: string;
  status: string | null;
}

export interface CompactMessage {
  /** The OpenCode message id, verbatim. This is the identity a client settles
   *  a mirror-sourced message against when the runtime finally answers. */
  id: string | null;
  /** `info.parentID` — which user message a step was parented on. */
  parent_id: string | null;
  role: string;
  created: string | null;
  completed: string | null;
  text: string;
  tools: CompactToolCall[];
  files: Array<{ filename: string | null; mime: string | null }>;
  reasoning_omitted: boolean;
  error: { name?: string; message?: string } | null;
}

export type RawOpencodePart = {
  type?: string;
  text?: string;
  synthetic?: boolean;
  tool?: string;
  state?: { status?: string };
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

export function compactMessage(msg: RawOpencodeMessage, maxChars: number): CompactMessage {
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
    text: truncate(normalizeWhitespace(text), maxChars),
    tools,
    files,
    reasoning_omitted: parts.some((p) => p.type === 'reasoning'),
    error: info.error ?? null,
  };
}

function normalizeWhitespace(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, Math.max(0, max - 1))}…`;
}
