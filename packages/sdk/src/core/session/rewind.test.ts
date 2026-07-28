import { describe, expect, test } from 'bun:test';

import {
  commitSessionRewind,
  messagesBeforeRewind,
  reconcileCommittedSessionRewind,
} from './rewind';

describe('session rewind projection', () => {
  const messages = [
    { info: { id: 'msg_1' }, parts: [] },
    { info: { id: 'msg_2' }, parts: [] },
    { info: { id: 'msg_3' }, parts: [] },
  ];

  test('hides the target message and every later message while rewind is staged', () => {
    expect(messagesBeforeRewind(messages, 'msg_2')).toEqual([messages[0]]);
  });

  test('keeps the transcript unchanged when the boundary is not loaded', () => {
    expect(messagesBeforeRewind(messages, 'msg_missing')).toBe(messages);
  });

  test('keeps the removed path hidden until sync confirms prompt cleanup', () => {
    const staged = { messageId: 'msg_2', staged: true };
    const committed = commitSessionRewind(staged);

    expect(committed).toEqual({ messageId: 'msg_2', staged: false });
    expect(reconcileCommittedSessionRewind(messages, committed)).toBe(committed);
    expect(reconcileCommittedSessionRewind([messages[0]], committed)).toBeNull();
  });
});
