import { describe, expect, test } from 'bun:test';

import { classifyWaitPoll, isAuthoritativelySettled } from '../commands/sessions-wait.ts';

describe('classifyWaitPoll', () => {
  test('an empty new session is pending prompt delivery, not settled no-progress', () => {
    expect(classifyWaitPoll({}, 'oc_1', { permissions: 0, questions: 0 }, false)).toBe('working');
  });

  test('an absent status entry means the agent loop is idle', () => {
    expect(classifyWaitPoll({}, 'oc_1', { permissions: 0, questions: 0 })).toBe('idle');
  });

  test('an explicit idle status is idle', () => {
    expect(
      classifyWaitPoll({ oc_1: { type: 'idle' } }, 'oc_1', { permissions: 0, questions: 0 }),
    ).toBe('idle');
  });

  test('any non-idle status means the agent is working', () => {
    expect(
      classifyWaitPoll({ oc_1: { type: 'busy' } }, 'oc_1', { permissions: 0, questions: 0 }),
    ).toBe('working');
    expect(
      classifyWaitPoll({ oc_1: { type: 'retry', attempt: 2 } }, 'oc_1', {
        permissions: 0,
        questions: 0,
      }),
    ).toBe('working');
  });

  test('pending permission or question asks report blocked, even mid-turn', () => {
    expect(
      classifyWaitPoll({ oc_1: { type: 'busy' } }, 'oc_1', { permissions: 1, questions: 0 }),
    ).toBe('blocked');
    expect(classifyWaitPoll({}, 'oc_1', { permissions: 0, questions: 2 })).toBe('blocked');
  });

  test('another session being busy does not affect this one', () => {
    expect(
      classifyWaitPoll({ oc_2: { type: 'busy' } }, 'oc_1', { permissions: 0, questions: 0 }),
    ).toBe('idle');
  });
});

describe('isAuthoritativelySettled', () => {
  test('accepts completed sessions', () => {
    expect(isAuthoritativelySettled('completed')).toBe(true);
  });

  test('does not treat a manual or interrupted stop as completion', () => {
    expect(isAuthoritativelySettled('stopped')).toBe(false);
  });
});
