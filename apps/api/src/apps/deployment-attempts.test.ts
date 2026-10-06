import { describe, expect, test } from 'bun:test';
import { attemptsExhausted } from './deployment-worker';

describe('attemptsExhausted', () => {
  test('the third attempt is allowed to run; the fourth claim fails the deployment', () => {
    expect(attemptsExhausted(1)).toBe(false);
    expect(attemptsExhausted(3)).toBe(false);
    expect(attemptsExhausted(4)).toBe(true);
  });
});
