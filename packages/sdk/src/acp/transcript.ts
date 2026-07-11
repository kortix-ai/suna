import type { AcpEnvelope, AcpStreamEvent } from './types';

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
