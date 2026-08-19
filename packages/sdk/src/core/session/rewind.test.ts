import { describe, expect, test } from 'bun:test';

import {
  commitSessionRewind,
  isWithinRewindWindow,
  messagesBeforeRewind,
  newestMessageId,
  stageSessionRewind,
  type SessionRewindState,
} from './rewind';

describe('newestMessageId', () => {
  test('null for an empty list', () => {
    expect(newestMessageId([])).toBeNull();
  });

  test('the highest id by VALUE, not position — an out-of-order append must not win by luck', () => {
    const messages = [
      { info: { id: 'msg_3' } },
      { info: { id: 'msg_1' } },
      { info: { id: 'msg_2' } },
    ];
    expect(newestMessageId(messages)).toBe('msg_3');
  });
});

describe('stageSessionRewind', () => {
  test('captures the watermark from the CURRENT message list at stage time', () => {
    const messages = [
      { info: { id: 'msg_1' } },
      { info: { id: 'msg_2' } },
      { info: { id: 'msg_3' } },
    ];
    expect(stageSessionRewind(messages, 'msg_2')).toEqual({
      messageId: 'msg_2',
      watermark: 'msg_3',
      staged: true,
    });
  });

  test('falls back to the boundary id itself when nothing is known locally yet', () => {
    expect(stageSessionRewind([], 'msg_2')).toEqual({
      messageId: 'msg_2',
      watermark: 'msg_2',
      staged: true,
    });
  });
});

describe('isWithinRewindWindow', () => {
  const rewind: SessionRewindState = { messageId: 'msg_2', watermark: 'msg_3', staged: true };

  test('the boundary itself is inside the window', () => {
    expect(isWithinRewindWindow('msg_2', rewind)).toBe(true);
  });

  test('the watermark itself is inside the window (inclusive upper bound)', () => {
    expect(isWithinRewindWindow('msg_3', rewind)).toBe(true);
  });

  test('below the boundary is outside', () => {
    expect(isWithinRewindWindow('msg_1', rewind)).toBe(false);
  });

  test('above the watermark is outside', () => {
    expect(isWithinRewindWindow('msg_4', rewind)).toBe(false);
  });
});

describe('messagesBeforeRewind', () => {
  const messages = [
    { info: { id: 'msg_1' } },
    { info: { id: 'msg_2' } },
    { info: { id: 'msg_3' } },
  ];

  test('hides the boundary message and everything up to the watermark', () => {
    const rewind = stageSessionRewind(messages, 'msg_2');
    expect(messagesBeforeRewind(messages, rewind)).toEqual([messages[0]]);
  });

  test('a message minted AFTER the watermark always renders — the bug this module fixes', () => {
    // Stage against the 3-message list (watermark frozen at msg_3), THEN the
    // user's replacement prompt and its answer land — ids msg_4/msg_5, both
    // newer than the watermark. The old boundary-only filter re-hid these
    // because they sort above msg_2 exactly like msg_3 does.
    const rewind = stageSessionRewind(messages, 'msg_2');
    const withReplacement = [
      ...messages,
      { info: { id: 'msg_4' } },
      { info: { id: 'msg_5' } },
    ];
    expect(messagesBeforeRewind(withReplacement, rewind)).toEqual([
      { info: { id: 'msg_1' } },
      { info: { id: 'msg_4' } },
      { info: { id: 'msg_5' } },
    ]);
  });

  test('no rewind staged — the transcript is returned unchanged (same reference)', () => {
    expect(messagesBeforeRewind(messages, null)).toBe(messages);
  });

  test('nothing in range — same reference, no needless new array', () => {
    const rewind: SessionRewindState = { messageId: 'msg_9', watermark: 'msg_9', staged: true };
    expect(messagesBeforeRewind(messages, rewind)).toBe(messages);
  });
});

describe('commitSessionRewind', () => {
  test('flips staged to false, keeps the hide window', () => {
    const staged: SessionRewindState = { messageId: 'msg_2', watermark: 'msg_3', staged: true };
    expect(commitSessionRewind(staged)).toEqual({
      messageId: 'msg_2',
      watermark: 'msg_3',
      staged: false,
    });
  });

  test('already committed — returns the same reference (idempotent)', () => {
    const committed: SessionRewindState = {
      messageId: 'msg_2',
      watermark: 'msg_3',
      staged: false,
    };
    expect(commitSessionRewind(committed)).toBe(committed);
  });

  test('null in, null out', () => {
    expect(commitSessionRewind(null)).toBeNull();
  });
});
