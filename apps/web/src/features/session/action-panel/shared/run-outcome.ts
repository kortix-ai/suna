/**
 * Did the run end well? The session's own status can't say — the SDK's
 * `SessionStatus` union is only idle|retry|busy, so success and failure both
 * settle to `idle`. The truth lives on the LAST assistant message: the SDK's
 * event handler patches `session.error` onto it (see handle-event.ts
 * "Patch the error onto the last assistant message"), and an abort error is
 * how a user-stop arrives. This file is the panel's single reader of that.
 */

import type { MessageWithParts } from '@/ui';
import type { Step } from './group-steps';

export type RunOutcome = 'succeeded' | 'failed' | 'stopped';

interface AssistantError {
  name?: string;
  data?: { message?: unknown };
}

function lastAssistantError(messages: MessageWithParts[] | undefined): AssistantError | null {
  if (!messages) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const info = messages[i].info as { role?: string; error?: AssistantError };
    if (info.role !== 'assistant') continue;
    return info.error ?? null;
  }
  return null;
}

/** Mirrors the SDK's abort heuristic without importing SDK internals. */
function isAbortErrorLike(error: AssistantError): boolean {
  if (/abort/i.test(error.name ?? '')) return true;
  const message = error.data?.message;
  return typeof message === 'string' && /abort/i.test(message);
}

export function deriveRunOutcome(
  messages: MessageWithParts[] | undefined,
  lastStepStatus?: Step['status'],
): RunOutcome {
  const error = lastAssistantError(messages);
  if (error) return isAbortErrorLike(error) ? 'stopped' : 'failed';
  if (lastStepStatus === 'error') return 'failed';
  return 'succeeded';
}
