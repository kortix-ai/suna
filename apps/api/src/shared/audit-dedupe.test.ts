import { describe, expect, test } from 'bun:test';
import { createFirstInWindow } from './audit-dedupe';

describe('createFirstInWindow', () => {
  test('admits the first sight, drops repeats inside the window, admits again after it', () => {
    let t = 0;
    const first = createFirstInWindow({ windowMs: 1000, now: () => t });
    expect(first('a')).toBe(true);
    expect(first('a')).toBe(false);
    expect(first('b')).toBe(true);
    t = 999;
    expect(first('a')).toBe(false);
    t = 1000;
    expect(first('a')).toBe(true);
    expect(first('a')).toBe(false);
  });

  test('is bounded: the oldest key is evicted and is admitted again', () => {
    const first = createFirstInWindow({ maxEntries: 2, now: () => 0 });
    first('a');
    first('b');
    first('c'); // evicts a
    expect(first('b')).toBe(false);
    expect(first('a')).toBe(true);
  });
});
