import { describe, expect, test } from 'bun:test';
import { logSafe } from './log-safe';

const LF = String.fromCharCode(10);
const CR = String.fromCharCode(13);
const TAB = String.fromCharCode(9);

describe('logSafe', () => {
  test('an ordinary value passes through unchanged', () => {
    expect(logSafe('acme-corp')).toBe('acme-corp');
  });

  test('THE ATTACK: a newline cannot end the line and forge a new event', () => {
    // `end_user_ref` is chosen by the wrapper's backend and only trimmed and
    // length-bounded on create. Interpolated raw, a crafted value emits what
    // looks like a separate log entry, which line-oriented ingestion indexes as
    // a real one.
    const forged = logSafe(`bob${LF}[projects] SECURITY: all checks disabled`);
    expect(forged).not.toContain(LF);
    expect(forged).toContain('\\x0a');
  });

  test('carriage returns and tabs are escaped too', () => {
    expect(logSafe(`a${CR}b`)).toBe('a\\x0db');
    expect(logSafe(`a${TAB}b`)).toBe('a\\x09b');
  });

  test('a backslash is escaped FIRST, so an escape cannot be spoofed', () => {
    // Otherwise the literal text `\x0a` would be indistinguishable from a real
    // escaped newline, letting a value fake having been sanitised.
    expect(logSafe('a\\x0ab')).toBe('a\\\\x0ab');
  });

  test('null and undefined read as "none"', () => {
    expect(logSafe(null)).toBe('none');
    expect(logSafe(undefined)).toBe('none');
  });

  test('a very long value is truncated so one row cannot flood the log', () => {
    const out = logSafe('x'.repeat(500));
    expect(out.length).toBeLessThanOrEqual(121);
    expect(out.endsWith('…')).toBe(true);
  });

  test('an empty string stays empty rather than becoming "none"', () => {
    // Empty and absent are different facts; collapsing them loses information.
    expect(logSafe('')).toBe('');
  });
});
