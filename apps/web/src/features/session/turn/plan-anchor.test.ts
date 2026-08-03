import { describe, expect, test } from 'bun:test';
import { planAnchorMessageId } from './plan-anchor';

type Msg = Parameters<typeof planAnchorMessageId>[0][number];

function user(id: string): Msg {
  return { info: { id, role: 'user' }, parts: [] } as unknown as Msg;
}

function assistant(id: string, tools: string[] = []): Msg {
  return {
    info: { id, role: 'assistant' },
    parts: tools.map((tool, i) => ({
      id: `${id}_p${i}`,
      type: 'tool',
      tool,
      callID: `call_${id}_${i}`,
      state: { status: 'completed' },
    })),
  } as unknown as Msg;
}

describe('planAnchorMessageId', () => {
  test('anchors the plan to the user message whose turn wrote the todos', () => {
    const messages = [
      user('u1'),
      assistant('a1', ['todowrite', 'bash']),
      user('u2'),
      assistant('a2', ['read']),
    ];

    // The reported bug: this returned 'u2' (the newest turn), so the plan card
    // migrated onto a message that never touched the plan.
    expect(planAnchorMessageId(messages)).toBe('u1');
  });

  test('a later turn that never writes todos does not steal the plan', () => {
    const messages = [
      user('u1'),
      assistant('a1', ['todowrite']),
      user('u2'),
      assistant('a2', ['bash']),
      user('u3'),
      assistant('a3', ['read', 'grep']),
    ];

    expect(planAnchorMessageId(messages)).toBe('u1');
  });

  test('a re-plan moves the anchor to the turn that re-planned', () => {
    const messages = [
      user('u1'),
      assistant('a1', ['todowrite']),
      user('u2'),
      assistant('a2', ['bash']),
      user('u3'),
      assistant('a3', ['todowrite']),
    ];

    expect(planAnchorMessageId(messages)).toBe('u3');
  });

  test('accepts both tool spellings', () => {
    expect(planAnchorMessageId([user('u1'), assistant('a1', ['todo_write'])])).toBe('u1');
    expect(planAnchorMessageId([user('u1'), assistant('a1', ['todowrite'])])).toBe('u1');
  });

  test('todos written while the turn is still streaming anchor to that turn', () => {
    const messages = [user('u1'), assistant('a1', ['bash']), user('u2'), assistant('a2', ['todowrite'])];

    expect(planAnchorMessageId(messages)).toBe('u2');
  });

  test('falls back to the last user message when no turn wrote todos', () => {
    // The session can hold todos with no `todowrite` part in the loaded
    // history — compaction drops old parts, and the todo list comes from the
    // runtime, not from the transcript. Keep the card reachable rather than
    // dropping it entirely.
    const messages = [user('u1'), assistant('a1', ['bash']), user('u2'), assistant('a2', ['read'])];

    expect(planAnchorMessageId(messages)).toBe('u2');
  });

  test('returns null when there is no user message at all', () => {
    expect(planAnchorMessageId([])).toBeNull();
    expect(planAnchorMessageId([assistant('a1', ['todowrite'])])).toBeNull();
  });

  test('ignores todo parts that precede any user message', () => {
    const messages = [assistant('a0', ['todowrite']), user('u1'), assistant('a1', ['bash'])];

    // No user message owned that write, so the fallback (last user) applies.
    expect(planAnchorMessageId(messages)).toBe('u1');
  });
});
