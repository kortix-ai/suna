import { describe, expect, test } from 'bun:test';
import type { SessionPrompt } from '@kortix/sdk';

import { inboxHoldsLivePrompt } from './inbox-live-prompt';

function row(clientMessageId: string, state: SessionPrompt['state']): SessionPrompt {
  return {
    prompt_id: `prompt-${clientMessageId}-${state}`,
    client_message_id: clientMessageId,
    state,
  } as SessionPrompt;
}

describe('inboxHoldsLivePrompt', () => {
  test('a queued, delivering, or waiting row with the send key holds the prompt', () => {
    expect(inboxHoldsLivePrompt([row('send-1', 'queued')], 'send-1')).toBe(true);
    expect(inboxHoldsLivePrompt([row('send-1', 'delivering')], 'send-1')).toBe(true);
    expect(inboxHoldsLivePrompt([row('send-1', 'waiting')], 'send-1')).toBe(true);
  });

  test('a failed row with the send key does not: the send was refused', () => {
    // A re-POST of a dead-lettered `client_message_id` dedupes into that failed row.
    expect(inboxHoldsLivePrompt([row('send-1', 'failed')], 'send-1')).toBe(false);
  });

  test('a row of another send does not hold this prompt', () => {
    expect(inboxHoldsLivePrompt([row('send-2', 'queued')], 'send-1')).toBe(false);
    expect(inboxHoldsLivePrompt([], 'send-1')).toBe(false);
  });
});
