/**
 * Did the run end well? The session's own status can't say — the SDK's
 * `SessionStatus` union is only idle|retry|busy, so success and failure both
 * settle to `idle`. The truth lives on the LAST reply: the session log marks
 * a reply the user stopped `aborted` and a failed one `error` (`fromV1` reads
 * the error the SDK's event handler patched onto the assistant message; a
 * compaction message carries its summary reply's verdict). This file is the
 * panel's single reader of that.
 */

import { isAbortError, type SessionLogMessage } from '@kortix/sdk';
import type { Step } from '@kortix/sdk';

export type RunOutcome = 'succeeded' | 'failed' | 'stopped';

/** The last reply: an assistant message, or a compaction (its summary is the reply). */
function lastReply(messages: SessionLogMessage[] | undefined): SessionLogMessage | null {
  if (!messages) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === 'assistant' || m.kind === 'compaction') return m;
  }
  return null;
}

export function deriveRunOutcome(
  messages: SessionLogMessage[] | undefined,
  lastStepStatus?: Step['status'],
): RunOutcome {
  const reply = lastReply(messages);
  if (reply?.status === 'aborted') return 'stopped';
  if (reply?.status === 'error') {
    // An error whose text says a human stopped it (`isAbortError`): the v1 class name is its code.
    const e = reply.error;
    return e && isAbortError({ name: e.code, data: { message: e.message } }) ? 'stopped' : 'failed';
  }
  if (lastStepStatus === 'error') return 'failed';
  return 'succeeded';
}
