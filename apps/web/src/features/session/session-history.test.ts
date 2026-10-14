import { describe, expect, test } from 'bun:test';
import type { SessionLogMessage } from '@kortix/sdk';

import { formatTextSize, harnessName, hasOutOfContext } from './session-history';

describe('session history helpers', () => {
  test('a harness id reads as its product name; an unknown id shows as it is', () => {
    expect(harnessName('opencode')).toBe('OpenCode');
    expect(harnessName('pi')).toBe('pi');
    expect(harnessName('codex')).toBe('codex');
  });

  test('a text size rounds up to whole kB, and to tenths of a MB from 1 MB on', () => {
    expect(formatTextSize(300_000, 'en')).toBe('293 kB');
    expect(formatTextSize(16 * 1024 + 1, 'en')).toBe('17 kB');
    expect(formatTextSize(3 * 1024 * 1024 + 1, 'en')).toBe('3.1 MB');
    expect(formatTextSize(300_000, 'de')).toBe('293 kB');
  });

  test('the toggle has work only when a message out of context is not streaming', () => {
    const m = (in_context: boolean, status: SessionLogMessage['status'] = 'complete') => ({ in_context, status }) as SessionLogMessage;
    expect(hasOutOfContext(undefined)).toBe(false);
    expect(hasOutOfContext([m(true), m(false, 'streaming')])).toBe(false);
    expect(hasOutOfContext([m(true), m(false, 'error')])).toBe(true);
  });
});
