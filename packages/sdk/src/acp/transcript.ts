import type { AcpEnvelope, AcpStreamEvent } from './types';

export type AcpStoredEnvelope = {
  ordinal: number;
  direction: 'client_to_agent' | 'agent_to_client' | string;
  streamEventId?: number | null;
  envelope: AcpEnvelope | Record<string, unknown>;
  createdAt?: string;
};

export type AcpTranscriptMessage = {
  role: 'user' | 'assistant';
  created: string | null;
  completed: string | null;
  text: string;
  tools: Array<{ tool: string; status: string | null }>;
  files: Array<{ filename: string | null; mime: string | null }>;
  reasoning_omitted: boolean;
  error: null;
};

function contentText(value: unknown): string {
  if (!Array.isArray(value)) return '';
  return value.flatMap((item) => textFromContent(item)).join('\n');
}

/** Canonical, provider-neutral projection for persisted ACP envelopes. */
export function projectAcpTranscript(
  rows: readonly AcpStoredEnvelope[],
  options: { limit?: number; maxChars?: number } = {},
): AcpTranscriptMessage[] {
  const messages: AcpTranscriptMessage[] = [];
  const maxChars = options.maxChars ?? 4_000;
  for (const row of rows) {
    const envelope = row.envelope;
    if (!('method' in envelope)) continue;
    if (row.direction === 'client_to_agent' && envelope.method === 'session/prompt') {
      const params = envelope.params as Record<string, unknown> | undefined;
      const text = contentText(params?.prompt).trim();
      if (text) messages.push(acpMessage('user', text, row.createdAt, maxChars));
      continue;
    }
    if (row.direction !== 'agent_to_client' || envelope.method !== 'session/update') continue;
    const params = envelope.params as Record<string, unknown> | undefined;
    const update = params?.update as Record<string, unknown> | undefined;
    if (!update) continue;
    const kind = String(update.sessionUpdate ?? update.type ?? '');
    if (kind === 'agent_message_chunk') {
      const text = textFromContent(update.content).join('\n');
      if (!text) continue;
      const previous = messages.at(-1);
      if (previous?.role === 'assistant') previous.text = truncate(previous.text + text, maxChars);
      else messages.push(acpMessage('assistant', text, row.createdAt, maxChars));
    } else if (kind === 'agent_thought_chunk') {
      const previous = messages.at(-1);
      if (previous?.role === 'assistant') previous.reasoning_omitted = true;
    } else if (kind === 'tool_call' || kind === 'tool_call_update') {
      const previous = messages.at(-1);
      if (previous?.role === 'assistant') {
        previous.tools.push({
          tool: String(update.title ?? update.toolCallId ?? 'tool'),
          status: typeof update.status === 'string' ? update.status : null,
        });
      }
    }
  }
  return messages.slice(-(options.limit ?? 200));
}

function acpMessage(role: 'user' | 'assistant', text: string, createdAt: string | undefined, maxChars: number): AcpTranscriptMessage {
  return {
    role,
    created: createdAt ?? null,
    completed: null,
    text: truncate(text.replace(/\s+/g, ' ').trim(), maxChars),
    tools: [],
    files: [],
    reasoning_omitted: false,
    error: null,
  };
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1))}…`;
}

export function acpTranscriptJsonl(events: readonly AcpStreamEvent[]): string {
  return events.map((event) => JSON.stringify({ sequence: event.id, envelope: event.envelope })).join('\n') + (events.length ? '\n' : '');
}

function textFromContent(value: unknown): string[] {
  if (!value || typeof value !== 'object') return [];
  const block = value as Record<string, unknown>;
  if (block.type === 'text' && typeof block.text === 'string') return [block.text];
  return [];
}

export function acpTranscriptMarkdown(events: readonly AcpStreamEvent[]): string {
  const lines = ['# Agent transcript', ''];
  for (const { envelope } of events) {
    if (!('method' in envelope) || envelope.method !== 'session/update') continue;
    const params = envelope.params as Record<string, unknown> | undefined;
    const update = params?.update as Record<string, unknown> | undefined;
    if (!update) continue;
    const kind = String(update.sessionUpdate ?? update.type ?? 'update');
    const content = textFromContent(update.content);
    if (content.length) lines.push(`## ${kind}`, '', ...content, '');
    else if (kind === 'tool_call' || kind === 'tool_call_update') {
      lines.push(`## ${kind}`, '', '```json', JSON.stringify(update, null, 2), '```', '');
    }
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

export function acpTranscriptHtml(events: readonly AcpStreamEvent[]): string {
  const escaped = acpTranscriptMarkdown(events)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return `<!doctype html><meta charset="utf-8"><title>Agent transcript</title><pre>${escaped}</pre>`;
}

export type { AcpEnvelope };
