import type { SessionLogMessage } from '@kortix/sdk';

import { stripKortixSystemTags } from '../../internal/lib/utils/kortix-system-tags';
import { stripSystemPtyText } from '../thread/message-parsing';
import { cleanPromptText } from './queue-projection';

/**
 * Prompt history: Up in an empty composer recalls the session's earlier
 * prompts, newest first; Down walks back toward the empty draft.
 *
 * Text only. File, image, paste, reply and mention markup is stripped
 * (`cleanPromptText`); a prompt with no typed words is not an entry.
 */

/** Origins a person typed. Automations, sub-agents and notifications are not history. */
const TYPED_ORIGINS = new Set<SessionLogMessage['origin']>([undefined, 'prompt', 'steer']);

/** The session's typed prompts as composer text, oldest first. */
export function promptHistoryEntries(messages: readonly SessionLogMessage[] | undefined): string[] {
  if (!messages) return [];
  const entries: string[] = [];
  for (const message of messages) {
    if (message.role !== 'user' || message.kind !== 'turn') continue;
    if (!TYPED_ORIGINS.has(message.origin)) continue;
    const raw = message.blocks
      .flatMap((b) => (b.type === 'text' && !b.synthetic ? [b.text] : []))
      .join('\n');
    const text = stripKortixSystemTags(stripSystemPtyText(cleanPromptText(raw).text)).trim();
    if (text) entries.push(text);
  }
  return entries;
}

/**
 * One Up or Down. `index` is the entry on screen (`null`: the draft).
 * Returns the next index, or `undefined` when the key is not history's
 * (Down from the draft), so the caret keeps its ordinary job.
 */
export function stepPromptHistory(
  index: number | null,
  direction: 'up' | 'down',
  total: number,
): number | null | undefined {
  if (total === 0) return undefined;
  if (direction === 'up') return index === null ? total - 1 : Math.max(0, index - 1);
  if (index === null) return undefined;
  return index + 1 < total ? index + 1 : null;
}
