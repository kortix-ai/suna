import { describe, expect, test } from 'bun:test';

import { shouldResumeFollow } from './use-auto-scroll';

describe('shouldResumeFollow', () => {
  test('does not re-arm follow within the FAB-visibility threshold (80px) but outside the resume threshold', () => {
    // This is the exact teleport scenario: during phase-1 streaming the
    // spacer keeps the viewport within BOTTOM_THRESHOLD (80px) of the end
    // even while the reader is meaningfully scrolled up. A single jittery
    // wheel/touch tick toward the bottom must not re-arm follow at 80px.
    expect(shouldResumeFollow({ distanceFromEnd: 80 })).toBe(false);
    expect(shouldResumeFollow({ distanceFromEnd: 50 })).toBe(false);
    expect(shouldResumeFollow({ distanceFromEnd: 13 })).toBe(false);
  });

  test('re-arms follow once the reader has actually reached the resume threshold (12px)', () => {
    expect(shouldResumeFollow({ distanceFromEnd: 11 })).toBe(true);
    expect(shouldResumeFollow({ distanceFromEnd: 0 })).toBe(true);
  });

  test('boundary is exclusive at exactly the resume threshold', () => {
    expect(shouldResumeFollow({ distanceFromEnd: 12 })).toBe(false);
  });

  test('a negative distance (overscroll past the end) still resumes', () => {
    expect(shouldResumeFollow({ distanceFromEnd: -5 })).toBe(true);
  });
});
