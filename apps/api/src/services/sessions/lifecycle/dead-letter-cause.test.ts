import { describe, expect, test } from 'bun:test';
import { deadLetterCause } from './dead-letter-cause';

describe('deadLetterCause', () => {
  test('the messages that actually flooded prod are customer state', () => {
    // Verbatim from Better Stack, three days to 2026-09-10 — 3,113 of 3,238
    // dead letters, all cron triggers firing into accounts that cannot pay.
    for (const message of [
      'Out of credits. Top up to continue.',
      'Your team wallet is out of credits. Top up to keep your agents running.',
      'Model "codex/gpt-5.6-sol" is not available for this account',
      'Model "deepseek-v4-flash" is not available for this account',
      'workspace mode "read" requires restricted workspace artifacts',
    ]) {
      expect(deadLetterCause(message)).toBe('customer_state');
    }
  });

  test('a dropped delivery is still the platform, and still pages', () => {
    for (const message of [
      'delivery outcome: pending',
      'delivery outcome: no-session',
      'runtime unreachable after 3 attempts',
      'Unsupported command type: frobnicate',
    ]) {
      expect(deadLetterCause(message)).toBe('platform');
    }
  });

  test('an unrecognised or empty message stays an error', () => {
    // The safe direction: only a message we recognise is demoted.
    expect(deadLetterCause('something nobody has seen before')).toBe('platform');
    expect(deadLetterCause('')).toBe('platform');
    expect(deadLetterCause(null)).toBe('platform');
    expect(deadLetterCause(undefined)).toBe('platform');
  });
});
