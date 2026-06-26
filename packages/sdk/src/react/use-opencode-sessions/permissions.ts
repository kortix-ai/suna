import { getClient } from '../../opencode/client';
import { unwrap } from './shared';

// ============================================================================
// Permission & Question Reply (direct SDK calls, not hooks)
// ============================================================================

export async function replyToPermission(
  requestId: string,
  reply: 'once' | 'always' | 'reject',
  message?: string,
): Promise<void> {
  const client = getClient();
  const result = await client.permission.reply({ requestID: requestId, reply, message });
  unwrap(result);
}

export async function replyToQuestion(
  requestId: string,
  answers: string[][],
): Promise<void> {
  const client = getClient();
  const result = await client.question.reply({ requestID: requestId, answers });
  unwrap(result);
}

export async function rejectQuestion(requestId: string): Promise<void> {
  const client = getClient();
  const result = await client.question.reject({ requestID: requestId });
  unwrap(result);
}

// useSessionPolling was removed — SSE reconnects within <3s making 2s HTTP
// polling redundant. All session status + message updates are driven by SSE
// events via the sync store. See SSE-FIRST-MIGRATION-PLAN.md Phase 1d.
