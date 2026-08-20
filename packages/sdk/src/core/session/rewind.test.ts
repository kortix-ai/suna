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
      hiddenIds: ['msg_2', 'msg_3'],
      staged: true,
    });
  });

  test('falls back to the boundary id itself when nothing is known locally yet', () => {
    expect(stageSessionRewind([], 'msg_2')).toEqual({
      messageId: 'msg_2',
      watermark: 'msg_2',
      hiddenIds: ['msg_2'],
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

// ============================================================================
// Membership, not a lexical id range.
//
// OpenCode 1.18.15 retired the invariant that message ids ascend with time
// (turn exit now reads `lastAssistant.parentID === lastUser.id`, and
// `MessageV2.latest()` orders by `time.created`). A `[messageId, watermark]`
// string range is therefore not a chronological window at all, and it failed
// in both directions. These two tests are those failures.
// ============================================================================

describe('the rewind window is a captured SET, not a string range', () => {
  test('under-delete: a reverted message whose id sorts BELOW the boundary is still hidden', () => {
    // Server page order (time-ordered) — ids do NOT ascend with it.
    const messages = [
      { info: { id: 'msg_c' } },
      { info: { id: 'msg_b' } }, // the boundary the user reverted to
      { info: { id: 'msg_a' } }, // its answer — a LOWER id, minted later
    ];
    const rewind = stageSessionRewind(messages, 'msg_b');

    // A lexical [msg_b, msg_b] range keeps `msg_a` — it would be orphaned and
    // reappear at the top of the chat. Membership hides it.
    expect(messagesBeforeRewind(messages, rewind)).toEqual([{ info: { id: 'msg_c' } }]);
    expect(isWithinRewindWindow('msg_a', rewind)).toBe(true);
    expect(isWithinRewindWindow('msg_c', rewind)).toBe(false);
  });

  test('over-delete: an in-flight optimistic id must not push the window over the replacement prompt', () => {
    // `ascendingId` stubs sit ~2.8e13 above every real id, so one optimistic
    // message in the list made the lexical watermark effectively infinite and
    // the window swallowed everything minted afterwards.
    const messages = [
      { info: { id: 'msg_0000000000010000000000' } },
      { info: { id: 'msg_0000000000020000000000' } }, // boundary
      { info: { id: 'msg_zzzzzzzzzzzzzzzzzzzzzz' } }, // optimistic, still in flight
    ];
    const rewind = stageSessionRewind(messages, 'msg_0000000000020000000000');

    // The replacement prompt and its answer are minted AFTER staging.
    const withReplacement = [
      ...messages,
      { info: { id: 'msg_0000000000030000000000' } },
      { info: { id: 'msg_0000000000040000000000' } },
    ];
    expect(messagesBeforeRewind(withReplacement, rewind).map((m) => m.info.id)).toEqual([
      'msg_0000000000010000000000',
      'msg_0000000000030000000000',
      'msg_0000000000040000000000',
    ]);
  });

  test('a state with no captured set still answers on the legacy range', () => {
    const legacy: SessionRewindState = { messageId: 'msg_2', watermark: 'msg_3', staged: true };
    expect(isWithinRewindWindow('msg_2', legacy)).toBe(true);
    expect(isWithinRewindWindow('msg_4', legacy)).toBe(false);
  });
});

describe('newestMessageId orders by time, id only as tie-break', () => {
  test('the newest by `time.created` wins even when its id sorts lowest', () => {
    const messages = [
      { info: { id: 'msg_z', time: { created: 10 } } },
      { info: { id: 'msg_a', time: { created: 20 } } },
    ];
    expect(newestMessageId(messages)).toBe('msg_a');
  });

  test('equal timestamps fall back to the higher id', () => {
    const messages = [
      { info: { id: 'msg_a', time: { created: 5 } } },
      { info: { id: 'msg_b', time: { created: 5 } } },
    ];
    expect(newestMessageId(messages)).toBe('msg_b');
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
