/**
 * "The latest run" = everything at and after the LAST user message. Every card
 * in the panel derives from the whole session's parts; this slice is what lets
 * them say which of it is fresh — new outputs first, honest per-run duration —
 * without changing what they include.
 */

import type { MessageWithParts } from '@/ui';
import { collectAllToolParts } from './collect-tool-parts';

export function latestRunMessages(
  messages: MessageWithParts[] | undefined,
): MessageWithParts[] {
  if (!messages || messages.length === 0) return [];
  for (let i = messages.length - 1; i >= 0; i--) {
    if ((messages[i].info as { role?: string }).role === 'user') {
      return messages.slice(i);
    }
  }
  return messages;
}

export function latestRunCallIds(messages: MessageWithParts[] | undefined): Set<string> {
  const ids = new Set<string>();
  for (const part of collectAllToolParts(latestRunMessages(messages))) {
    ids.add(part.callID);
  }
  return ids;
}
