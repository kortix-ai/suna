/**
 * Pending-question self-heal policy for the session thread.
 *
 * The event stream delivers `question.asked`. The poll only recovers a
 * question whose event was missed: a question tool part is running in the
 * newest assistant message, but the store holds no pending question.
 */

import type { MessageWithParts } from '@/lib/opencode/types';

export const QUESTION_POLL_INTERVAL_MS = 3000;
/** Longest wait between polls while `/question` keeps failing. */
export const QUESTION_POLL_MAX_INTERVAL_MS = 30_000;

export function shouldPollQuestions({
  hasRunningQuestionTool,
  pendingCount,
  hasSandboxUrl,
}: {
  hasRunningQuestionTool: boolean;
  pendingCount: number;
  hasSandboxUrl: boolean;
}): boolean {
  return hasRunningQuestionTool && pendingCount === 0 && hasSandboxUrl;
}

/**
 * Delay before the next poll, or null to stop.
 * `status` is the HTTP status of the last response, or null for a network
 * error. `consecutiveFailures` counts the last response when it failed.
 * 401 and 403 stop: a retry with the same token cannot succeed. Every other
 * failure backs off (6 s, 12 s, 24 s, then 30 s) and never stops, so a
 * sandbox outage cannot end the self-heal for good.
 */
export function nextQuestionPollDelay(status: number | null, consecutiveFailures: number): number | null {
  if (status === 401 || status === 403) return null;
  if (consecutiveFailures <= 0) return QUESTION_POLL_INTERVAL_MS;
  return Math.min(QUESTION_POLL_INTERVAL_MS * 2 ** Math.min(consecutiveFailures, 16), QUESTION_POLL_MAX_INTERVAL_MS);
}

/**
 * True when the newest assistant message has a question tool part that is
 * pending or running. A running question tool always belongs to the newest
 * turn, so older messages are not scanned.
 */
export function hasRunningQuestionTool(messages: readonly MessageWithParts[]): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.info.role !== 'assistant') continue;
    return message.parts.some((part) => {
      if (part.type !== 'tool') return false;
      const tool = part as { tool?: string; state?: { status?: string } };
      const status = tool.state?.status;
      return tool.tool === 'question' && (status === 'running' || status === 'pending');
    });
  }
  return false;
}
