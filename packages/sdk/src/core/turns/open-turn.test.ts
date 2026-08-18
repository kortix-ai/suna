import { describe, expect, test } from 'bun:test';

import {
  hasOpenAssistantTurn,
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

describe('hasOpenAssistantTurn', () => {
  test('false when there are no messages', () => {
    expect(hasOpenAssistantTurn(undefined)).toBe(false);
    expect(hasOpenAssistantTurn([])).toBe(false);
  });

  test('false when there is no assistant message at all', () => {
    expect(hasOpenAssistantTurn([user()])).toBe(false);
  });

  test('true while the last assistant message is still streaming', () => {
    expect(hasOpenAssistantTurn([user(), assistant()])).toBe(true);
    expect(hasOpenAssistantTurn([assistant({ time: { created: 1 } })])).toBe(true);
  });

  test('false once the last assistant message completed', () => {
    expect(hasOpenAssistantTurn([assistant({ time: { created: 1, completed: 2 } })])).toBe(false);
  });

  test('false once the last assistant message carries a NON-retryable error', () => {
    // The queue-wedge regression pin. `applyOptimisticAbort` in apps/web marks
    // the message with an AbortError but never sets `time.completed`, and an
    // aborted turn may never get a `message.updated` that does. Reading only
    // `time.completed` therefore stayed true forever after the stop button,
    // which permanently closed the queue's drain gate.
    expect(
      hasOpenAssistantTurn([assistant({ error: { name: 'AbortError', data: { message: 'x' } } })]),
    ).toBe(false);
  });

  test('TRUE while the last assistant message carries a RETRYABLE error', () => {
    // OpenCode stamps `info.error` on the live assistant message while it backs
    // off a 429, then keeps writing the SAME message. The turn has not ended.
    expect(
      hasOpenAssistantTurn([
        assistant({
          error: { name: 'APIError', data: { message: '429', statusCode: 429, isRetryable: true } },
        }),
      ]),
    ).toBe(true);
  });

  test('false when a retryable error also carries time.completed', () => {
    // Completion outranks retry: the message is finished, whatever the error says.
    expect(
      hasOpenAssistantTurn([
        assistant({
          time: { created: 1, completed: 2 },
          error: { name: 'APIError', data: { isRetryable: true } },
        }),
      ]),
    ).toBe(false);
  });

  test('reads the LAST assistant message, ignoring finished ones before it', () => {
    expect(
      hasOpenAssistantTurn([
        assistant({ time: { completed: 1 } }),
        user(),
        assistant({ time: { created: 2 } }),
      ]),
    ).toBe(true);
  });

  test('a user message after the assistant does not reopen a finished turn', () => {
    expect(hasOpenAssistantTurn([assistant({ time: { completed: 1 } }), user()])).toBe(false);
  });

  test('matches the sandbox daemon rule', () => {
    // The reference implementation is the sandbox daemon at
    // apps/kortix-sandbox-agent-server/src/opencode-turn-state.ts:89-93:
    //   role === 'assistant' && !time.completed &&
    //   (!error || error.data?.isRetryable === true)
    // This table asserts all four quadrants so the two implementations cannot
    // drift apart again.
    const quadrants: Array<[string, Record<string, unknown>, boolean]> = [
      ['no error, not completed', {}, true],
      ['non-retryable error', { error: { name: 'AbortError', data: {} } }, false],
      ['retryable error', { error: { name: 'APIError', data: { isRetryable: true } } }, true],
      ['completed', { time: { completed: 7 } }, false],
    ];
    for (const [label, fields, expected] of quadrants) {
      expect(`${label}=${hasOpenAssistantTurn([assistant(fields)])}`).toBe(`${label}=${expected}`);
    }
  });
});

/**
 * The narrow half of the predicate, and the one that carries evidence.
 *
 * `hasOpenAssistantTurn` is true for TWO very different things: a turn that is
 * mid-retry (OpenCode stamped a retryable error and is still writing the same
 * message), and a "husk" — a message left open forever by a sandbox that died
 * mid-turn, with no error and no completion. Gating a send on the first is a
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
    // The dead-sandbox case. `hasOpenAssistantTurn` is true here forever.
    expect(hasOpenAssistantTurn([assistant({})])).toBe(true);
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
