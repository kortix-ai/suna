import { describe, expect, test } from 'bun:test';
import { clearSessionFresh, isSessionFresh, markSessionFresh } from './fresh-sessions';

describe('fresh-session registry (04#11)', () => {
  test('is bounded: a long-lived window that creates thousands of sessions forgets the oldest', () => {
    for (let i = 0; i < 5_000; i++) markSessionFresh(`bound-${i}`);
    expect(isSessionFresh('bound-0')).toBe(false);
    expect(isSessionFresh('bound-4999')).toBe(true);
    clearSessionFresh('bound-4999');
    expect(isSessionFresh('bound-4999')).toBe(false);
  });
});
