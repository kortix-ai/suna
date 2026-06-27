import { describe, expect, test } from 'bun:test';

import {
  extractSendErrorMessage,
  getSendRetryDelayMs,
  isOpenCodeNotReadyError,
  isTransientSendStatus,
} from './opencode-send-retry';

describe('extractSendErrorMessage', () => {
  test('reads thrown Error messages', () => {
    expect(extractSendErrorMessage(new Error('opencode not ready'))).toBe('opencode not ready');
  });

  test('reads plain strings', () => {
    expect(extractSendErrorMessage('opencode not ready')).toBe('opencode not ready');
  });

  test('reads the SDK response-error shape ({ data: { message } })', () => {
    expect(extractSendErrorMessage({ data: { message: 'opencode not ready' } })).toBe(
      'opencode not ready',
    );
  });

  test('reads a top-level message / error field', () => {
    expect(extractSendErrorMessage({ message: 'boom' })).toBe('boom');
    expect(extractSendErrorMessage({ error: 'nope' })).toBe('nope');
  });

  test('returns empty string for nullish input', () => {
    expect(extractSendErrorMessage(null)).toBe('');
    expect(extractSendErrorMessage(undefined)).toBe('');
  });
});

describe('isOpenCodeNotReadyError', () => {
  test('matches the boot 503 across shapes and casing', () => {
    expect(isOpenCodeNotReadyError(new Error('opencode not ready'))).toBe(true);
    expect(isOpenCodeNotReadyError('OpenCode Not Ready')).toBe(true);
    expect(isOpenCodeNotReadyError({ data: { message: 'opencode not ready' } })).toBe(true);
    expect(
      isOpenCodeNotReadyError('Failed to perform action: opencode not ready'),
    ).toBe(true);
  });

  test('does not match unrelated errors', () => {
    expect(isOpenCodeNotReadyError(new Error('Insufficient credits'))).toBe(false);
    expect(isOpenCodeNotReadyError({ data: { message: 'Bad request' } })).toBe(false);
    expect(isOpenCodeNotReadyError(null)).toBe(false);
  });
});

describe('isTransientSendStatus', () => {
  test('treats missing status (thrown transport error) as transient', () => {
    expect(isTransientSendStatus(undefined)).toBe(true);
  });

  test('treats 5xx / 408 / 429 as transient', () => {
    expect(isTransientSendStatus(500)).toBe(true);
    expect(isTransientSendStatus(503)).toBe(true);
    expect(isTransientSendStatus(408)).toBe(true);
    expect(isTransientSendStatus(429)).toBe(true);
  });

  test('treats other 4xx as terminal', () => {
    expect(isTransientSendStatus(400)).toBe(false);
    expect(isTransientSendStatus(401)).toBe(false);
    expect(isTransientSendStatus(404)).toBe(false);
  });
});

describe('getSendRetryDelayMs', () => {
  test('retries "opencode not ready" across the full boot window', () => {
    const err = new Error('opencode not ready');
    // 503 status is reported alongside the boot message.
    const delays: number[] = [];
    for (let attempt = 1; ; attempt++) {
      const delay = getSendRetryDelayMs(attempt, 503, err);
      if (delay === null) break;
      delays.push(delay);
      if (attempt > 20) throw new Error('retry schedule did not terminate');
    }
    // 7 retries → 8 total attempts, covering ~16s of cold boot.
    expect(delays.length).toBe(7);
    expect(delays.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(15000);
  });

  test('retries a generic transient 5xx, but only briefly', () => {
    const err = { data: { message: 'upstream blip' } };
    expect(getSendRetryDelayMs(1, 502, err)).toBe(400);
    expect(getSendRetryDelayMs(2, 502, err)).toBe(1000);
    expect(getSendRetryDelayMs(3, 502, err)).toBe(2000);
    // Generic transient window exhausts after 3 retries (4 attempts total).
    expect(getSendRetryDelayMs(4, 502, err)).toBeNull();
  });

  test('retries a thrown transport error (no status)', () => {
    const err = new Error('Failed to fetch');
    expect(getSendRetryDelayMs(1, undefined, err)).toBe(400);
    expect(getSendRetryDelayMs(3, undefined, err)).toBe(2000);
    expect(getSendRetryDelayMs(4, undefined, err)).toBeNull();
  });

  test('never retries a real 4xx client error', () => {
    const err = { data: { message: 'Bad request' } };
    expect(getSendRetryDelayMs(1, 400, err)).toBeNull();
    expect(getSendRetryDelayMs(1, 401, err)).toBeNull();
    expect(getSendRetryDelayMs(1, 404, err)).toBeNull();
  });

  test('"opencode not ready" wins even when surfaced as a non-transient status', () => {
    // Defensive: if the boot 503 is ever relabeled with a 4xx-ish status, the
    // message still drives a boot-window retry.
    const err = new Error('opencode not ready');
    expect(getSendRetryDelayMs(1, 400, err)).toBe(400);
  });
});
