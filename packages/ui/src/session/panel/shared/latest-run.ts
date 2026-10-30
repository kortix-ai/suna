/**
 * "The latest run" = everything at and after the LAST user message. Every card
 * in the panel derives from the whole thread's calls; this slice is what lets
 * them say which of it is fresh — new outputs first, honest per-run duration —
 * without changing what they include.
 */

import type { SessionLogMessage } from '@kortix/sdk';
import { collectAllToolCalls } from './collect-tool-parts';

export function latestRunMessages(messages: SessionLogMessage[] | undefined): SessionLogMessage[] {
  if (!messages || messages.length === 0) return [];
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') return messages.slice(i);
  }
  return messages;
}

export function latestRunCallIds(messages: SessionLogMessage[] | undefined): Set<string> {
  const ids = new Set<string>();
  for (const call of collectAllToolCalls(latestRunMessages(messages))) ids.add(call.call_id);
  return ids;
}
