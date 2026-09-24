/**
 * A channel prompt with the pre-2026 header — `[Slack · #general · message from
 * <user>]` — as the user message shows it: who wrote it, on which platform, and
 * the words before the scaffold's instructions. Pure, so
 * `channel-message.test.ts` can pin it.
 *
 * Linear in the prompt, which anyone who can post in the channel writes. The
 * regex version froze the JS thread: 240k characters took 22 s in its header
 * and 42 s in its instruction search, with Bun on a laptop.
 */

import { readLegacyChannelHeader } from '@kortix/shared';

export interface LegacyChannelMessage {
  platform: 'Telegram' | 'Slack';
  userName: string;
  messageText: string;
}

export function parseLegacyChannelMessage(rawText: string): LegacyChannelMessage | undefined {
  if (!rawText) return undefined;
  const header = readLegacyChannelHeader(rawText);
  if (!header) return undefined;
  const afterHeader = rawText.slice(header.length);
  const instrStart = instructionsStart(afterHeader);
  const messageText = instrStart >= 0 ? afterHeader.slice(0, instrStart).trim() : afterHeader.trim();
  return { platform: header.platform as LegacyChannelMessage['platform'], userName: header.userName, messageText };
}

const INSTRUCTION_MARKERS = ['Chat ID:', '── Telegram instructions', '── Slack instructions'];
/** A regex `\s`, so whitespace means exactly what it meant to the old pattern. */
const WHITESPACE = /\s/;

/**
 * Where the scaffold's instructions begin in the text after the header: the
 * first newline that whitespace alone separates from a marker — what
 * `text.search(/\n\s*(Chat ID:|── Telegram instructions|── Slack instructions)/)`
 * returned — or -1.
 *
 * The regex retried every newline of a blank run and re-read the run each time.
 * Here each run is read once: every marker starts with a non-space, so it can
 * only follow the whole run, and every newline inside the run reaches the same
 * place.
 */
export function instructionsStart(text: string): number {
  let from = 0;
  for (;;) {
    const newline = text.indexOf('\n', from);
    if (newline === -1) return -1;
    let end = newline + 1;
    while (end < text.length && WHITESPACE.test(text[end]!)) end++;
    if (INSTRUCTION_MARKERS.some((marker) => text.startsWith(marker, end))) return newline;
    from = end;
  }
}
