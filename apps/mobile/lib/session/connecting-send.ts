/**
 * connecting-send — a message sent while the session's computer wakes.
 *
 * The connecting view's composer was disabled: nothing could be sent until the
 * thread replaced it, although the server's prompt inbox holds a prompt
 * durably and delivers it once the computer is ready (the web sends there the
 * same way; `SESSION_NOTICE.waking` promises it). The message shows at once,
 * under the session's runtime root, and the delivered echo replaces it (same
 * message id). A refused send stays in the thread as a failed send the thread
 * offers to try again (`failed-sends.ts`), never dropped.
 *
 * Pure data and the stores: `bun test` loads this module.
 */

import { createSessionPrompt } from '@kortix/sdk';

import {
  addOptimisticMessage,
  markOptimisticAccepted,
  removeOptimisticMessage,
  sessionMessageIds,
} from './session-store';
import type { MessageWithParts } from './types';
import { useFailedSendStore } from './failed-sends';
import { optimisticUserParts } from './optimistic-parts';
import { promptParts } from './prompt-parts';
import { mintWireMessageId } from './wire-message-id';

/** Queue `text` for the session. Answers whether the inbox accepted it. */
export async function queuePromptWhileWaking(input: {
  projectId: string;
  projectSessionId: string;
  /** The session's runtime root session: the thread the message shows in. */
  rootId: string;
  text: string;
  /** `expo-crypto`'s `randomUUID` in the app. */
  randomUUID: () => string;
}): Promise<boolean> {
  const text = input.text.trim();
  if (!text) return false;
  const nowMs = Date.now();
  const clientMessageId = input.randomUUID();
  const messageId = mintWireMessageId({ nowMs, knownMessageIds: sessionMessageIds(input.rootId) });
  addOptimisticMessage(input.rootId, {
    info: { id: messageId, role: 'user', sessionID: input.rootId, time: { created: nowMs } },
    parts: optimisticUserParts(text, [], nowMs),
  } as unknown as MessageWithParts);
  try {
    await createSessionPrompt(input.projectId, input.projectSessionId, {
      clientMessageId,
      messageId,
      parts: promptParts(text, []),
      clientSentAtMs: nowMs,
    });
    // The inbox holds it: the bubble stays until the delivered echo replaces it.
    markOptimisticAccepted(input.rootId, messageId);
    return true;
  } catch {
    // It leaves the transcript and stays in the thread as a failed send:
    // dimmed, with "Not sent · Try again" once the thread opens.
    removeOptimisticMessage(input.rootId, messageId);
    useFailedSendStore
      .getState()
      .markFailed(input.rootId, messageId, { text, options: {}, clientMessageId, messageId, failedAtMs: nowMs });
    return false;
  }
}
