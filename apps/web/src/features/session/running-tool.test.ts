import { describe, expect, test } from 'bun:test';

import { hasRunningToolCall, type RunningToolMessage } from './running-tool';

function assistant(
  parts: Array<{ type?: string; state?: { status?: string } }>,
  info: Partial<RunningToolMessage['info']> = {},
): RunningToolMessage {
  return { info: { role: 'assistant', ...info }, parts };
}

const user: RunningToolMessage = { info: { role: 'user' }, parts: [] };

describe('hasRunningToolCall', () => {
  test('false with no messages', () => {
    expect(hasRunningToolCall(undefined)).toBe(false);
    expect(hasRunningToolCall([])).toBe(false);
  });

  test('true while a tool part on the open assistant message is running', () => {
    expect(
      hasRunningToolCall([user, assistant([{ type: 'tool', state: { status: 'running' } }])]),
    ).toBe(true);
  });

  test('false once every tool part has completed or errored', () => {
    expect(
      hasRunningToolCall([
        user,
        assistant([
          { type: 'tool', state: { status: 'completed' } },
          { type: 'tool', state: { status: 'error' } },
        ]),
      ]),
    ).toBe(false);
  });

  test('a pending tool does not block — it has not started executing', () => {
    // Interrupting before a tool starts is exactly the boundary the queue
    // wants: the tool never runs, nothing is killed halfway.
    expect(
      hasRunningToolCall([user, assistant([{ type: 'tool', state: { status: 'pending' } }])]),
    ).toBe(false);
  });

  test('non-tool parts never count', () => {
    expect(
      hasRunningToolCall([user, assistant([{ type: 'text' }, { type: 'reasoning' }])]),
    ).toBe(false);
  });

  test('only the last assistant message is consulted', () => {
    // An older message frozen with a `running` part (dead sandbox husk) must
    // not block interrupts for the rest of the session's life.
    expect(
      hasRunningToolCall([
        assistant([{ type: 'tool', state: { status: 'running' } }]),
        user,
        assistant([{ type: 'tool', state: { status: 'completed' } }]),
      ]),
    ).toBe(false);
  });

  test('a completed or errored assistant message cannot have a running tool', () => {
    // `time.completed` / `error` mean the turn ended; a part still reading
    // `running` there is stale data, not a live execution.
    expect(
      hasRunningToolCall([
        assistant([{ type: 'tool', state: { status: 'running' } }], {
          time: { completed: 123 },
        }),
      ]),
    ).toBe(false);
    expect(
      hasRunningToolCall([
        assistant([{ type: 'tool', state: { status: 'running' } }], { error: { name: 'x' } }),
      ]),
    ).toBe(false);
  });

  test('a trailing user message does not hide the open assistant turn', () => {
    // The optimistic user bubble for a queued send appears after the open
    // assistant message; the scan skips non-assistant roles.
    expect(
      hasRunningToolCall([
        assistant([{ type: 'tool', state: { status: 'running' } }]),
        user,
      ]),
    ).toBe(true);
  });
});
