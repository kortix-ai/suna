import { describe, expect, test } from 'bun:test';

import {
  hasRetryingAssistantTurn,
  isRetryableTurnError,
} from './open-turn';

function assistant(fields: Record<string, unknown> = {}) {
  return { info: { role: 'assistant', ...fields } };
}
function user() {
  return { info: { role: 'user' } };
}

describe('isRetryableTurnError', () => {
  test('false for null, undefined, a string, and a number', () => {
    expect(isRetryableTurnError(null)).toBe(false);
    expect(isRetryableTurnError(undefined)).toBe(false);
    expect(isRetryableTurnError('APIError')).toBe(false);
    expect(isRetryableTurnError(429)).toBe(false);
  });

  test('false for an error with no data', () => {
    expect(isRetryableTurnError({ name: 'AbortError' })).toBe(false);
  });

  test('false when data.isRetryable is false', () => {
    // The `ApiError` wire shape — @opencode-ai/sdk v2 types.gen.d.ts declares
    // `data.isRetryable: boolean`, so a non-retryable API error is this exact
    // object with the flag off.
    expect(
      isRetryableTurnError({
        name: 'APIError',
        data: { message: 'bad request', statusCode: 400, isRetryable: false },
      }),
    ).toBe(false);
  });

  test('true only when data.isRetryable is exactly true', () => {
    expect(isRetryableTurnError({ name: 'APIError', data: { isRetryable: true } })).toBe(true);
    // Strict `=== true`: a truthy stand-in is not the flag.
    expect(isRetryableTurnError({ data: { isRetryable: 'true' } })).toBe(false);
    expect(isRetryableTurnError({ data: { isRetryable: 1 } })).toBe(false);
  });
});

/**
 * The narrow half of the predicate, and the one that carries evidence.
 *
 * "Is the last assistant message merely unfinished?" is true for TWO very
 * different things: a turn that is mid-retry (OpenCode stamped a retryable
 * error and is still writing the same message), and a "husk" — a message left
 * open forever by a sandbox that died mid-turn, with no error and no
 * completion. Gating a send on the first is a
 * correctness rule; gating on the second wedges the composer for the lifetime
 * of the session, which is why the old code needed a 10s clock and a
 * confirmation round-trip to escape it. Only the retry case has proof.
 */
describe('hasRetryingAssistantTurn', () => {
  test('true only while the open turn carries a RETRYABLE error', () => {
    expect(
      hasRetryingAssistantTurn([
        assistant({ error: { name: 'APIError', data: { isRetryable: true } } }),
      ]),
    ).toBe(true);
  });

  test('false for a husk — an open message with no error at all', () => {
    // The dead-sandbox case: open forever, but never evidence of a live turn.
    expect(hasRetryingAssistantTurn([assistant({})])).toBe(false);
  });

  test('false once the message completes, retryable error or not', () => {
    expect(
      hasRetryingAssistantTurn([
        assistant({ time: { completed: 7 }, error: { data: { isRetryable: true } } }),
      ]),
    ).toBe(false);
  });

  test('false for a terminal error, and for no assistant message at all', () => {
    expect(hasRetryingAssistantTurn([assistant({ error: { name: 'AbortError' } })])).toBe(false);
    expect(hasRetryingAssistantTurn([user()])).toBe(false);
    expect(hasRetryingAssistantTurn([])).toBe(false);
    expect(hasRetryingAssistantTurn(undefined)).toBe(false);
  });

  test('reads the LAST assistant message, not an older one', () => {
    expect(
      hasRetryingAssistantTurn([
        assistant({ error: { data: { isRetryable: true } } }),
        user(),
        assistant({ time: { completed: 9 } }),
      ]),
    ).toBe(false);
  });
});
