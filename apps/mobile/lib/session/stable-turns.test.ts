import { describe, expect, test } from 'bun:test';

import type { MessageWithParts, Turn } from '@/lib/opencode/types';
import {
  STICK_RELEASE_DISTANCE,
  findLastUserMessageId,
  isNearEnd,
  reuseStableTurns,
  shouldFollowNewTurn,
  shouldRearmStick,
  shouldReleaseStick,
  shouldReleaseStickOnTouch,
  shouldUpdateSpacer,
} from './stable-turns';

function msg(id: string, role: 'user' | 'assistant', text = ''): MessageWithParts {
  return {
    info: { id, role, sessionID: 's1', time: { created: 1 } } as MessageWithParts['info'],
    parts: text ? [{ type: 'text', id: `${id}-p`, text } as MessageWithParts['parts'][number]] : [],
  };
}

function turn(user: MessageWithParts, ...assistants: MessageWithParts[]): Turn {
  return { userMessage: user, assistantMessages: assistants };
}

describe('reuseStableTurns', () => {
  test('returns next unchanged when there are no previous turns', () => {
    const next = [turn(msg('u1', 'user'))];
    expect(reuseStableTurns([], next)).toBe(next);
  });

  test('keeps untouched turns by reference and replaces the changed last turn', () => {
    const u1 = msg('u1', 'user');
    const a1 = msg('a1', 'assistant', 'done');
    const u2 = msg('u2', 'user');
    const a2 = msg('a2', 'assistant', 'stream');
    const prev = [turn(u1, a1), turn(u2, a2)];

    // A streamed delta replaces only the last assistant message object.
    const a2Next = msg('a2', 'assistant', 'streamed');
    const next = [turn(u1, a1), turn(u2, a2Next)];

    const result = reuseStableTurns(prev, next);
    expect(result).not.toBe(prev);
    expect(result[0]).toBe(prev[0]);
    expect(result[1]).toBe(next[1]);
    expect(result[1]).not.toBe(prev[1]);
  });

  test('does not reuse a turn whose assistant message count changed', () => {
    const u1 = msg('u1', 'user');
    const a1 = msg('a1', 'assistant', 'x');
    const prev = [turn(u1, a1)];
    const next = [turn(u1, a1, msg('a1b', 'assistant', 'y'))];
    expect(reuseStableTurns(prev, next)[0]).toBe(next[0]);
  });

  test('does not reuse a turn whose user message object changed', () => {
    const prev = [turn(msg('u1', 'user', 'a'))];
    const next = [turn(msg('u1', 'user', 'a'))];
    expect(reuseStableTurns(prev, next)[0]).toBe(next[0]);
  });

  test('returns the previous array when every turn is reused and the length matches', () => {
    const u1 = msg('u1', 'user');
    const a1 = msg('a1', 'assistant', 'x');
    const prev = [turn(u1, a1)];
    const next = [turn(u1, a1)];
    expect(reuseStableTurns(prev, next)).toBe(prev);
  });

  test('returns a new array when identical turn objects change order', () => {
    const t1 = turn(msg('u1', 'user'), msg('a1', 'assistant', 'x'));
    const t2 = turn(msg('u2', 'user'), msg('a2', 'assistant', 'y'));
    const prev = [t1, t2];
    const next = [turn(t2.userMessage, ...t2.assistantMessages), turn(t1.userMessage, ...t1.assistantMessages)];
    const result = reuseStableTurns(prev, next);
    expect(result).not.toBe(prev);
    expect(result).toHaveLength(2);
    expect(result[0]).toBe(t2);
    expect(result[1]).toBe(t1);
  });

  test('matches turns by user message id when older history is prepended', () => {
    const u2 = msg('u2', 'user');
    const a2 = msg('a2', 'assistant', 'x');
    const prev = [turn(u2, a2)];
    const next = [turn(msg('u1', 'user')), turn(u2, a2)];
    const result = reuseStableTurns(prev, next);
    expect(result).toHaveLength(2);
    expect(result[0]).toBe(next[0]);
    expect(result[1]).toBe(prev[0]);
  });
});

describe('shouldUpdateSpacer', () => {
  test('updates while the last turn is shorter than the cap', () => {
    expect(shouldUpdateSpacer(100, 140, 600)).toBe(true);
  });

  test('skips when the height did not change', () => {
    expect(shouldUpdateSpacer(140, 140, 600)).toBe(false);
  });

  test('skips when both heights are at or above the cap', () => {
    expect(shouldUpdateSpacer(600, 900, 600)).toBe(false);
    expect(shouldUpdateSpacer(700, 1200, 600)).toBe(false);
  });

  test('updates when the height crosses the cap in either direction', () => {
    expect(shouldUpdateSpacer(500, 800, 600)).toBe(true);
    expect(shouldUpdateSpacer(800, 500, 600)).toBe(true);
  });

  test('treats a negative cap as zero', () => {
    expect(shouldUpdateSpacer(10, 20, -50)).toBe(false);
  });
});

describe('findLastUserMessageId', () => {
  test('returns the id of the last user message in store order', () => {
    const messages = [msg('u1', 'user'), msg('a1', 'assistant'), msg('u2', 'user'), msg('a2', 'assistant')];
    expect(findLastUserMessageId(messages)).toBe('u2');
  });

  test('returns undefined when no user message exists', () => {
    expect(findLastUserMessageId([msg('a1', 'assistant')])).toBeUndefined();
    expect(findLastUserMessageId([])).toBeUndefined();
  });
});

describe('shouldReleaseStick', () => {
  const viewportHeight = 800;
  const contentHeight = 5000;
  const end = contentHeight - viewportHeight; // 4200

  test('keeps the stick for a programmatic scroll event, even far from the end', () => {
    expect(
      shouldReleaseStick({ prevOffset: end, offset: 0, contentHeight, viewportHeight, programmatic: true }),
    ).toBe(false);
  });

  test('releases when a user scroll moves up away from the end past the threshold', () => {
    // iOS status-bar tap: an animated scroll to the top, no drag.
    expect(
      shouldReleaseStick({ prevOffset: end, offset: 0, contentHeight, viewportHeight, programmatic: false }),
    ).toBe(true);
    expect(
      shouldReleaseStick({
        prevOffset: end,
        offset: end - STICK_RELEASE_DISTANCE - 1,
        contentHeight,
        viewportHeight,
        programmatic: false,
      }),
    ).toBe(true);
  });

  test('keeps the stick for a small upward move within the threshold', () => {
    expect(
      shouldReleaseStick({
        prevOffset: end,
        offset: end - STICK_RELEASE_DISTANCE,
        contentHeight,
        viewportHeight,
        programmatic: false,
      }),
    ).toBe(false);
  });

  test('keeps the stick when the offset does not move up', () => {
    // Content grew below a still offset, or the offset moved toward the end.
    expect(
      shouldReleaseStick({ prevOffset: 1000, offset: 1000, contentHeight, viewportHeight, programmatic: false }),
    ).toBe(false);
    expect(
      shouldReleaseStick({ prevOffset: 1000, offset: 1200, contentHeight, viewportHeight, programmatic: false }),
    ).toBe(false);
  });

  test('keeps the stick when content shrank and the offset clamped down to the new end', () => {
    expect(
      shouldReleaseStick({ prevOffset: end, offset: end - 300, contentHeight: contentHeight - 300, viewportHeight, programmatic: false }),
    ).toBe(false);
  });
});

describe('isNearEnd', () => {
  test('true within 80 pt of the end, false beyond', () => {
    expect(isNearEnd(4200, 5000, 800)).toBe(true);
    expect(isNearEnd(4120, 5000, 800)).toBe(true);
    expect(isNearEnd(4119, 5000, 800)).toBe(false);
  });

  test('true when the content is shorter than the viewport', () => {
    expect(isNearEnd(0, 300, 800)).toBe(true);
  });
});

describe('shouldRearmStick', () => {
  const near = { offset: 4150, contentHeight: 5000, viewportHeight: 800 };

  test('re-arms a user scroll that rests near the end with no momentum', () => {
    expect(shouldRearmStick({ ...near, programmatic: false, velocityY: 0 })).toBe(true);
    // Momentum end events carry no drag velocity.
    expect(shouldRearmStick({ ...near, programmatic: false })).toBe(true);
  });

  test('does not re-arm at finger lift when momentum follows (fling)', () => {
    expect(shouldRearmStick({ ...near, programmatic: false, velocityY: -1.8 })).toBe(false);
    expect(shouldRearmStick({ ...near, programmatic: false, velocityY: 0.4 })).toBe(false);
  });

  test('treats a near-zero velocity as no momentum', () => {
    expect(shouldRearmStick({ ...near, programmatic: false, velocityY: 0.001 })).toBe(true);
  });

  test('treats a drag end whose target offset equals its offset as no momentum (iOS)', () => {
    expect(shouldRearmStick({ ...near, programmatic: false, velocityY: 0.3, targetOffsetY: near.offset })).toBe(true);
    expect(shouldRearmStick({ ...near, programmatic: false, velocityY: 0.3, targetOffsetY: 4200 })).toBe(false);
  });

  test('does not re-arm far from the end', () => {
    expect(shouldRearmStick({ offset: 1000, contentHeight: 5000, viewportHeight: 800, programmatic: false, velocityY: 0 })).toBe(false);
  });

  test('does not re-arm for a programmatic scroll', () => {
    expect(shouldRearmStick({ ...near, programmatic: true, velocityY: 0 })).toBe(false);
  });
});

describe('shouldReleaseStickOnTouch', () => {
  test('a touch releases the stick on an idle session', () => {
    expect(shouldReleaseStickOnTouch({ isBusy: false })).toBe(true);
  });

  test('a touch keeps the stick while the session streams', () => {
    expect(shouldReleaseStickOnTouch({ isBusy: true })).toBe(false);
  });
});


describe('shouldFollowNewTurn', () => {
  test('follows a new turn after an idle touch was the only release', () => {
    expect(shouldFollowNewTurn({ grew: true, releasedByTouch: true, settledNearEnd: false })).toBe(true);
  });

  test('follows a new turn when the last settled user scroll rested near the end', () => {
    expect(shouldFollowNewTurn({ grew: true, releasedByTouch: false, settledNearEnd: true })).toBe(true);
  });

  test('does not follow when the user scrolled away from the end', () => {
    expect(shouldFollowNewTurn({ grew: true, releasedByTouch: false, settledNearEnd: false })).toBe(false);
  });

  test('does nothing when the turn count did not grow', () => {
    expect(shouldFollowNewTurn({ grew: false, releasedByTouch: true, settledNearEnd: true })).toBe(false);
  });
});
