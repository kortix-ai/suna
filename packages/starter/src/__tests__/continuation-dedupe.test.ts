import { describe, expect, test } from 'bun:test';

import {
  continuationMessageId,
  countPassiveContinuationsAfter,
  hasContinuationMessageId,
} from '../../templates/base/.kortix/opencode/continuation/dedupe';

function userMessage(id: string, text: string) {
  return {
    info: { id, role: 'user', time: { created: 1 } },
    parts: [{ type: 'text', text }],
  };
}

function assistantMessage(id: string, text: string) {
  return {
    info: { id, role: 'assistant', time: { created: 2 } },
    parts: [{ type: 'text', text }],
  };
}

const passiveContinuation = `<kortix_system type="passive-continuation" source="kortix-continuation">
[SYSTEM REMINDER - TODO CONTINUATION]
Continue.
<!-- KORTIX_INTERNAL -->
</kortix_system>`;

describe('kortix continuation dedupe helpers', () => {
  test('uses stable ids for the same session, user message, and continuation index', () => {
    const first = continuationMessageId('ses_123', 'msg_user', 0);
    const second = continuationMessageId('ses_123', 'msg_user', 0);

    expect(first).toBe(second);
    expect(first.startsWith('msg_kxcont_')).toBe(true);
    expect(continuationMessageId('ses_123', 'msg_user', 1)).not.toBe(first);
  });

  test('finds an existing continuation message id', () => {
    const messageID = continuationMessageId('ses_123', 'msg_user', 0);
    const messages = [
      userMessage('msg_user', 'do the thing'),
      userMessage(messageID, passiveContinuation),
    ];

    expect(hasContinuationMessageId(messages, messageID)).toBe(true);
    expect(hasContinuationMessageId(messages, continuationMessageId('ses_123', 'msg_user', 1))).toBe(false);
  });

  test('counts only passive continuation messages after the current real user prompt', () => {
    const messages = [
      userMessage('msg_old', 'old task'),
      userMessage(continuationMessageId('ses_123', 'msg_old', 0), passiveContinuation),
      assistantMessage('msg_asst_old', 'done'),
      userMessage('msg_user', 'new task'),
      assistantMessage('msg_asst', 'working'),
      userMessage(continuationMessageId('ses_123', 'msg_user', 0), passiveContinuation),
      userMessage('msg_regular', 'ordinary user text'),
    ];

    expect(countPassiveContinuationsAfter(messages, 'msg_user')).toBe(1);
    expect(countPassiveContinuationsAfter(messages, 'msg_old')).toBe(2);
    expect(countPassiveContinuationsAfter(messages, null)).toBe(0);
  });
});
