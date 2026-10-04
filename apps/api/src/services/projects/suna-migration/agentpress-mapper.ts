export interface AgentpressMessageRow {
  message_id: string;
  type: string;
  is_llm_message: boolean;
  content: unknown;
  created_at: string;
}

export interface NormalizedToolPart {
  type: 'tool';
  callId: string;
  name: string;
  input: unknown;          
  output: string | null;  
}

export interface NormalizedTextPart {
  type: 'text';
  text: string;
}

export type NormalizedPart = NormalizedTextPart | NormalizedToolPart;

export interface NormalizedMessage {
  role: 'user' | 'assistant';
  parts: NormalizedPart[];
  createdAt: string;
  sourceMessageId: string;
}

const KEPT_TYPES = new Set(['user', 'assistant', 'tool', 'summary']);

function asObject(content: unknown): any {
  if (content == null) return {};
  if (typeof content === 'string') {
    try { return JSON.parse(content); } catch { return { content }; }
  }
  return content;
}

function asText(content: unknown): string {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((p: any) => (typeof p === 'string' ? p : p?.text ?? '')).join('');
  }
  return String(content);
}

export function normalizeAgentpressThread(rows: AgentpressMessageRow[]): NormalizedMessage[] {
  const ordered = [...rows]
    .filter((r) => r.is_llm_message && KEPT_TYPES.has(r.type))
    .sort((a, b) => a.created_at.localeCompare(b.created_at));

  const out: NormalizedMessage[] = [];
  const toolPartByCallId = new Map<string, NormalizedToolPart>();

  for (const row of ordered) {
    const obj = asObject(row.content);

    if (row.type === 'tool') {
      const callId = obj.tool_call_id ?? obj.toolCallId;
      const part = callId ? toolPartByCallId.get(callId) : undefined;
      if (part) part.output = asText(obj.content);
      continue;
    }

    const role: 'user' | 'assistant' = row.type === 'user' ? 'user' : 'assistant';
    const parts: NormalizedPart[] = [];

    const text = asText(obj.content);
    if (text.trim()) parts.push({ type: 'text', text });

    const toolCalls = Array.isArray(obj.tool_calls) ? obj.tool_calls : [];
    for (const tc of toolCalls) {
      const fn = tc?.function ?? {};
      let input: unknown = fn.arguments;
      if (typeof input === 'string') { try { input = JSON.parse(input); } catch { /* keep raw */ } }
      const part: NormalizedToolPart = {
        type: 'tool',
        callId: tc?.id ?? `${row.message_id}:${parts.length}`,
        name: fn.name ?? 'unknown',
        input,
        output: null,
      };
      parts.push(part);
      toolPartByCallId.set(part.callId, part);
    }

    if (parts.length === 0) continue;
    out.push({ role, parts, createdAt: row.created_at, sourceMessageId: row.message_id });
  }

  return out;
}
