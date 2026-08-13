import { describe, expect, test } from 'bun:test';

import { hasOpenAssistantTurn } from './assistant-turn-open';

function assistant(fields: Record<string, unknown> = {}) {
  return { info: { role: 'assistant', ...fields } };
}
function user() {
  return { info: { role: 'user' } };
}

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

  test('false once the last assistant message carries an error', () => {
    // The reason this predicate exists. `applyOptimisticAbort` marks the
    // message with an AbortError but never sets `time.completed`, and an
    // aborted turn may never get a `message.updated` that does. Reading only
    // `time.completed` therefore left this true forever after the stop button,
    // which permanently closed the queue's drain gate: every message typed
    // after an interrupt queued behind one that could never be released.
    expect(
      hasOpenAssistantTurn([assistant({ error: { name: 'AbortError', data: { message: 'x' } } })]),
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
});
