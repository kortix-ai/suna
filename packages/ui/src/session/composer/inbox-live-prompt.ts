import type { SessionPrompt } from '@kortix/sdk';

/**
 * Whether the inbox holds this send's prompt in a row that can still run.
 *
 * `client_message_id` is the POST's idempotency key, so it names the row. A `failed` row with
 * that key is a refusal, not a delivery: a re-POST of a dead-lettered key dedupes into that row.
 * A send that finds only a failed row did not reach the server.
 */
export function inboxHoldsLivePrompt(
  prompts: readonly Pick<SessionPrompt, 'client_message_id' | 'state'>[],
  clientMessageId: string,
): boolean {
  return prompts.some(
    (prompt) => prompt.client_message_id === clientMessageId && prompt.state !== 'failed',
  );
}
