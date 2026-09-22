/**
 * Pure transcript helpers. No React, no SDK client — just the message shape
 * `useSession().messages` returns, so every rule here is unit-testable.
 */

/** The structural shape of an OpenCode message part this file reads. */
export interface PartLike {
  type: string;
  text?: string;
}

export interface MessageLike {
  info: { id: string; role: string };
  parts: PartLike[];
}

/** Every text part of a message, joined. Empty string when there is none. */
export function messageText(message: MessageLike): string {
  return message.parts
    .filter((part) => part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text as string)
    .join('')
    .trim();
}

/** The newest message that carries text, or null. Streaming updates in place,
 *  so this is the live tail of the current turn while it is being written. */
export function lastTextMessage(messages: MessageLike[]): MessageLike | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message && messageText(message)) return message;
  }
  return null;
}

/** Collapse a message to a single terminal line of at most `width` columns. */
export function oneLine(text: string, width: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (width <= 1 || flat.length <= width) return flat;
  return `${flat.slice(0, Math.max(width - 1, 0))}…`;
}

/** `0s`, `12s`, `3m 04s` — the elapsed readout the status bar prints. */
export function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(Math.floor(ms / 1000), 0);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
}
