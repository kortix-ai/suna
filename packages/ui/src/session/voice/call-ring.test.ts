import { describe, expect, test } from 'bun:test';

import { callTime } from './call-ring';

describe('callTime', () => {
  test('a call\'s length as a phone shows it', () => {
    expect(callTime(0)).toBe('0:00');
    expect(callTime(7_400)).toBe('0:07');
    expect(callTime(272_000)).toBe('4:32');
    expect(callTime(3_729_000)).toBe('1:02:09');
    expect(callTime(-500)).toBe('0:00');
  });
});
