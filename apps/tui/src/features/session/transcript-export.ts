/**
 * The open conversation as plain text: the newest reply for `/copy`, the whole
 * thread as Markdown for `/export`. Pure, so both are asserted directly.
 */

import { type SessionLogMessage, classifySessionLogMessage } from '@kortix/sdk';

/** The text of the newest assistant turn: what `/copy` puts on the clipboard. */
export function lastReplyText(messages: readonly SessionLogMessage[]): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || message.role !== 'assistant') continue;
    const text = classifySessionLogMessage(message)
      .parts.filter((part) => part.kind === 'text')
      .map((part) => (part.kind === 'text' ? part.text : ''))
      .join('\n\n')
      .trim();
    if (text) return text;
  }
  return null;
}

/** The conversation as Markdown, for `/export`: each turn's role and its text. */
export function transcriptMarkdown(messages: readonly SessionLogMessage[], title: string): string {
  const out: string[] = [`# ${title}`, ''];
  for (const message of messages) {
    if (message.role !== 'user' && message.role !== 'assistant') continue;
    const text = classifySessionLogMessage(message)
      .parts.filter((part) => part.kind === 'text')
      .map((part) => (part.kind === 'text' ? part.text : ''))
      .join('\n\n')
      .trim();
    if (!text) continue;
    out.push(`## ${message.role === 'user' ? 'You' : 'Kortix'}`, '', text, '');
  }
  return `${out.join('\n').trim()}\n`;
}
