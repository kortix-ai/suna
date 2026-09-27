import { describe, expect, test } from 'bun:test';

import {
  AT_END_PX,
  BOTTOM_GAP_PX,
  CHEVRON_PX,
  GLIDE_MIN_PX,
  QUEUED_TURN_GAP_PX,
  TURN_GAP_PX,
  TURN_TOP_OFFSET,
  anchorSpan,
  chevronVisible,
  distanceFromEnd,
  isAtEnd,
  momentumFollows,
  nextFollow,
  pickAnchorIndex,
  roomUnderNewestTurn,
  scrollEnd,
  settleMotion,
  turnTopGap,
} from './auto-scroll';

describe('constants mirror apps/web use-auto-scroll.ts and session-chat.tsx', () => {
  test('scroll physics values', () => {
    expect(TURN_TOP_OFFSET).toBe(24);
    expect(BOTTOM_GAP_PX).toBe(24);
    expect(AT_END_PX).toBe(4);
    expect(CHEVRON_PX).toBe(120);
    expect(GLIDE_MIN_PX).toBe(80);
  });

  test('turn gaps are web mt-12 / mt-3 at --spacing 0.23rem, rounded to whole points', () => {
    expect(TURN_GAP_PX).toBe(44);
    expect(QUEUED_TURN_GAP_PX).toBe(11);
  });
});

describe('distanceFromEnd / scrollEnd / isAtEnd', () => {
  test('distance is content minus offset minus viewport', () => {
    expect(distanceFromEnd({ offset: 100, contentHeight: 1000, viewportHeight: 800 })).toBe(100);
  });

  test('scrollEnd never goes below zero for short content', () => {
    expect(scrollEnd(500, 800)).toBe(0);
    expect(scrollEnd(1000, 800)).toBe(200);
  });

  test('within 4px counts as at the end, 5px does not', () => {
    expect(isAtEnd(0)).toBe(true);
    expect(isAtEnd(4)).toBe(true);
    expect(isAtEnd(5)).toBe(false);
  });

  test('an iOS overscroll past the end (negative distance) is at the end', () => {
    expect(isAtEnd(-30)).toBe(true);
  });
});

describe('roomUnderNewestTurn — the spacer below the last turn', () => {
  test('max(24, viewport − span − 24)', () => {
    expect(roomUnderNewestTurn(800, 200)).toBe(576);
  });

  test('a turn taller than the viewport keeps the 24px floor', () => {
    expect(roomUnderNewestTurn(800, 2000)).toBe(24);
    expect(roomUnderNewestTurn(800, 760)).toBe(24);
  });

  test('no anchor turn: the room is the whole viewport', () => {
    expect(roomUnderNewestTurn(800, null)).toBe(800);
  });

  test('a larger top offset (floating chrome) pins the turn lower', () => {
    expect(roomUnderNewestTurn(800, 200, 120)).toBe(480);
  });
});

describe('pickAnchorIndex — same contract as web', () => {
  const none = () => false;

  test('empty transcript has no anchor', () => {
    expect(pickAnchorIndex(0, none, null)).toBe(-1);
  });

  test('the last turn when nothing is pending', () => {
    expect(pickAnchorIndex(3, none, null)).toBe(2);
  });

  test('the newest reached turn, skipping pending turns below it', () => {
    expect(pickAnchorIndex(4, (i) => i >= 2, null)).toBe(1);
  });

  test('every turn pending falls back to the last turn', () => {
    expect(pickAnchorIndex(2, () => true, null)).toBe(1);
  });

  test('a reached anchor never falls back to an older turn', () => {
    expect(pickAnchorIndex(3, (i) => i === 2, { index: 2, reached: true })).toBe(2);
  });

  test('a fallback anchor yields once a turn above it is reached', () => {
    expect(pickAnchorIndex(3, (i) => i === 2, { index: 2, reached: false })).toBe(1);
  });

  test('an anchor that left the transcript holds nothing', () => {
    expect(pickAnchorIndex(2, none, { index: 5, reached: true })).toBe(1);
  });
});

describe('anchorSpan — anchor top to content end (spacer excluded)', () => {
  test('a single anchor turn is its own height plus the footer', () => {
    expect(
      anchorSpan({ anchorIndex: 1, count: 2, heightAt: () => 300, gapAt: () => 44, footerHeight: 0 }),
    ).toBe(300);
  });

  test('turns below the anchor add their height and their top gap', () => {
    const heights = [500, 300, 60, 60];
    const gaps = [0, 44, 44, 11];
    expect(
      anchorSpan({
        anchorIndex: 1,
        count: 4,
        heightAt: (i) => heights[i],
        gapAt: (i) => gaps[i],
        footerHeight: 50,
      }),
    ).toBe(300 + 44 + 60 + 11 + 60 + 50);
  });

  test('null while any turn from the anchor down is unmeasured', () => {
    expect(
      anchorSpan({
        anchorIndex: 0,
        count: 2,
        heightAt: (i) => (i === 0 ? 100 : undefined),
        gapAt: () => 44,
        footerHeight: 0,
      }),
    ).toBeNull();
  });

  test('null with no anchor', () => {
    expect(
      anchorSpan({ anchorIndex: -1, count: 0, heightAt: () => 1, gapAt: () => 0, footerHeight: 0 }),
    ).toBeNull();
  });
});

describe('turnTopGap — web session-chat.tsx TurnViewport className', () => {
  test('the first turn has no gap', () => {
    expect(turnTopGap({ index: 0, working: true, pending: true, previousPending: true })).toBe(0);
  });

  test('mt-12 between ordinary turns', () => {
    expect(turnTopGap({ index: 3, working: false, pending: false, previousPending: false })).toBe(44);
  });

  test('mt-3 between back-to-back pending turns while working', () => {
    expect(turnTopGap({ index: 3, working: true, pending: true, previousPending: true })).toBe(11);
  });

  test('the first pending turn after the working turn keeps mt-12', () => {
    expect(turnTopGap({ index: 3, working: true, pending: true, previousPending: false })).toBe(44);
  });

  test('pending ids are ignored when the session is not working', () => {
    expect(turnTopGap({ index: 3, working: false, pending: true, previousPending: true })).toBe(44);
  });
});

describe('chevronVisible — scroll-to-bottom button', () => {
  test('hidden while following, whatever the distance', () => {
    expect(chevronVisible({ following: true, distanceFromEnd: 5000, room: 0 })).toBe(false);
  });

  test('shows past 120px of content from the end (room excluded)', () => {
    expect(chevronVisible({ following: false, distanceFromEnd: 121, room: 0 })).toBe(true);
    expect(chevronVisible({ following: false, distanceFromEnd: 120, room: 0 })).toBe(false);
  });

  test('the spacer does not count toward the distance', () => {
    expect(chevronVisible({ following: false, distanceFromEnd: 600, room: 500 })).toBe(false);
    expect(chevronVisible({ following: false, distanceFromEnd: 621, room: 500 })).toBe(true);
  });
});

describe('nextFollow — follow on/off transitions', () => {
  const scroll = {
    type: 'scroll' as const,
    ours: false,
    geometryChanged: false,
    movedTowardEnd: false,
    dragging: false,
    distanceFromEnd: 0,
  };

  test('a user drag turns follow off', () => {
    expect(nextFollow(true, { type: 'drag-begin' })).toBe(false);
  });

  test('a send turns follow on', () => {
    expect(nextFollow(false, { type: 'send' })).toBe(true);
  });

  test('the scroll-to-bottom button turns follow on', () => {
    expect(nextFollow(false, { type: 'jump-to-end' })).toBe(true);
  });

  test('a scroll we made never releases follow', () => {
    expect(nextFollow(true, { ...scroll, ours: true, distanceFromEnd: 900 })).toBe(true);
  });

  test('a clamp (content or viewport changed) never releases follow', () => {
    expect(nextFollow(true, { ...scroll, geometryChanged: true, distanceFromEnd: 900 })).toBe(true);
  });

  test('a foreign scroll away from the end releases follow (iOS status-bar tap)', () => {
    expect(nextFollow(true, { ...scroll, distanceFromEnd: 900 })).toBe(false);
  });

  test('a foreign scroll still within 4px keeps follow', () => {
    expect(nextFollow(true, { ...scroll, distanceFromEnd: 3 })).toBe(true);
  });

  test('momentum arriving at the end while moving toward it resumes follow', () => {
    expect(nextFollow(false, { ...scroll, movedTowardEnd: true, distanceFromEnd: 2 })).toBe(true);
  });

  test('moving away from the end never resumes, even inside 4px', () => {
    expect(nextFollow(false, { ...scroll, movedTowardEnd: false, distanceFromEnd: 2 })).toBe(false);
  });

  test('a finger still on the list never resumes follow mid-drag', () => {
    expect(
      nextFollow(false, { ...scroll, dragging: true, movedTowardEnd: true, distanceFromEnd: 0 }),
    ).toBe(false);
  });

  test('a scroll that is not at the end keeps follow off', () => {
    expect(nextFollow(false, { ...scroll, movedTowardEnd: true, distanceFromEnd: 40 })).toBe(false);
  });

  test('a scroll that came to rest at the end resumes follow', () => {
    expect(nextFollow(false, { type: 'rest', distanceFromEnd: 4 })).toBe(true);
    expect(nextFollow(false, { type: 'rest', distanceFromEnd: 10 })).toBe(false);
  });

  test('coming to rest away from the end does not release an active follow', () => {
    expect(nextFollow(true, { type: 'rest', distanceFromEnd: 10 })).toBe(true);
  });
});

describe('settleMotion — how a following viewport reaches the end', () => {
  const base = {
    distance: 0,
    end: 1000,
    anchorChanged: false,
    glideArmed: false,
    glideTarget: null as number | null,
    reduceMotion: false,
  };

  test('already at the end: none', () => {
    expect(settleMotion({ ...base, distance: 0.4 })).toBe('none');
  });

  test('streaming growth under the anchor: instant', () => {
    expect(settleMotion({ ...base, distance: 300 })).toBe('instant');
  });

  test('a send moves a whole turn in one glide', () => {
    expect(settleMotion({ ...base, distance: 400, glideArmed: true })).toBe('glide');
  });

  test('a new anchor turn glides', () => {
    expect(settleMotion({ ...base, distance: 400, anchorChanged: true })).toBe('glide');
  });

  test('a turn-sized move shorter than 80px is a cut, not a glide', () => {
    expect(settleMotion({ ...base, distance: 80, glideArmed: true })).toBe('instant');
  });

  test('reduced motion makes the glide instant', () => {
    expect(settleMotion({ ...base, distance: 400, glideArmed: true, reduceMotion: true })).toBe(
      'instant',
    );
  });

  test('a glide in flight is re-aimed when the end moved', () => {
    expect(settleMotion({ ...base, distance: 10, glideTarget: 900 })).toBe('glide');
  });

  test('a glide in flight with an unchanged end waits instead of cutting it short', () => {
    expect(settleMotion({ ...base, distance: 300, glideTarget: 1000.5 })).toBe('wait');
  });
});

describe('momentumFollows — does a fling continue after the finger lifts?', () => {
  test('no velocity: the scroll is at rest now', () => {
    expect(momentumFollows({ offset: 100, velocityY: 0, targetOffsetY: undefined })).toBe(false);
  });

  test('velocity with no iOS target: momentum follows', () => {
    expect(momentumFollows({ offset: 100, velocityY: 1.2, targetOffsetY: undefined })).toBe(true);
  });

  test('iOS target equal to the offset: at rest whatever the velocity', () => {
    expect(momentumFollows({ offset: 100, velocityY: 1.2, targetOffsetY: 100 })).toBe(false);
  });

  test('a lift reports no velocity (onMomentumScrollEnd): at rest', () => {
    expect(momentumFollows({ offset: 100, velocityY: undefined, targetOffsetY: undefined })).toBe(false);
  });
});
