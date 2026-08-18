/**
 * Re-export of the SDK's shared open-turn predicate.
 *
 * This file used to carry its own copy, and the copy drifted: it ended the turn
 * on ANY `info.error`, while the sandbox daemon
 * (apps/kortix-sandbox-agent-server/src/opencode-turn-state.ts) keeps a turn
 * open through a RETRYABLE error. During a provider 429 backoff the web
 * therefore opened the queue's drain gate and sent the next message into a turn
 * that was still running. One predicate now, in @kortix/sdk — per the repo rule
 * that logic lives in the SDK and hosts are thin.
 */
export {
  hasOpenAssistantTurn,
  hasRetryingAssistantTurn,
  isRetryableTurnError,
} from '@kortix/sdk';
export type { OpenTurnMessageLike, OpenTurnMessageLike as AssistantTurnMessage } from '@kortix/sdk';
