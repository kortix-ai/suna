import { describe, expect, test } from 'bun:test';
import { commandBlocker, sendBlocker, sendBlockerMessage } from './send-blockers';

const clear = { hasActiveQuestion: false, pendingPermissionCount: 0, readOnly: false };

describe('sendBlocker', () => {
  test('nothing blocks an ordinary send', () => {
    expect(sendBlocker(clear)).toBeNull();
  });

  test('a structured question on screen blocks it', () => {
    // Sending unrelated text while a question is open answers the wrong prompt.
    expect(sendBlocker({ ...clear, hasActiveQuestion: true })).toBe('active_question');
  });

  test('a pending permission blocks it', () => {
    expect(sendBlocker({ ...clear, pendingPermissionCount: 2 })).toBe('pending_permission');
  });

  test('a read-only viewer blocks it', () => {
    expect(sendBlocker({ ...clear, readOnly: true })).toBe('read_only');
  });

  test('read-only outranks everything — it is the reason nothing may be sent at all', () => {
    expect(
      sendBlocker({ hasActiveQuestion: true, pendingPermissionCount: 3, readOnly: true }),
    ).toBe('read_only');
  });

  test('a working session does NOT block a prompt', () => {
    // The whole point of the server inbox: a prompt typed mid-turn becomes a
    // durable row and the control plane decides when it runs. Refusing it here
    // would be this tab guessing at ordering again.
    expect(sendBlocker(clear)).toBeNull();
    expect(commandBlocker({ ...clear, ...runnable })).toBeNull();
  });

  test('a sleeping sandbox does NOT block a prompt either', () => {
    // The prompt becomes an inbox row while the box is still waking, and the
    // drain delivers it when the box answers. That is the composer's own
    // "Waking this session up… messages you send will be queued" promise.
    expect(sendBlocker(clear)).toBeNull();
  });
});

const runnable = { isWorking: false, runtimeReady: true };

describe('commandBlocker', () => {
  test('a `/` command is refused while the session is working', () => {
    // A command is dispatched by `runCommand`, never by `POST .../prompts`, so
    // no server gate ever sees it. Putting one on the wire mid-turn aborts the
    // answer in progress.
    expect(commandBlocker({ ...clear, ...runnable, isWorking: true })).toBe('session_working');
  });

  test('a `/` command is refused while the sandbox is still waking', () => {
    // `runCommand` (use-session.ts) returns a RESOLVED promise when the runtime
    // is not switched yet: no request, no error, no row. Dispatching into it
    // cleared the draft and left the optimistic command bubble waiting on a
    // turn that never starts. A command has no inbox row to wait in, so the
    // only honest answer is to refuse it and keep the text.
    expect(commandBlocker({ ...clear, ...runnable, runtimeReady: false })).toBe('runtime_waking');
  });

  test('a waking runtime outranks a working session', () => {
    // Nothing is running on a box that is not up; naming the turn would send
    // the user to wait for something that is not happening.
    expect(commandBlocker({ ...clear, isWorking: true, runtimeReady: false })).toBe(
      'runtime_waking',
    );
  });

  test('it still answers the shared blockers first', () => {
    expect(commandBlocker({ ...clear, ...runnable, readOnly: true, isWorking: true })).toBe(
      'read_only',
    );
    expect(
      commandBlocker({ ...clear, ...runnable, hasActiveQuestion: true, isWorking: true }),
    ).toBe('active_question');
    expect(
      commandBlocker({ ...clear, readOnly: true, isWorking: false, runtimeReady: false }),
    ).toBe('read_only');
  });

  test('an idle, ready session runs the command', () => {
    expect(commandBlocker({ ...clear, ...runnable })).toBeNull();
  });
});

describe('sendBlockerMessage', () => {
  test('every blocker has a message a user can act on', () => {
    for (const blocker of [
      'active_question',
      'pending_permission',
      'read_only',
      'session_working',
      'runtime_waking',
    ] as const) {
      const copy = sendBlockerMessage(blocker);
      expect(copy.message.length).toBeGreaterThan(0);
      // No blocker may report itself with the enum name.
      expect(copy.message).not.toContain('_');
    }
  });

  test('the working refusal names what to do about it', () => {
    // "Refused" with no way forward is how a composer becomes a wall. The
    // command runs the moment the turn ends, and the copy has to say so.
    expect(sendBlockerMessage('session_working').description ?? '').toContain('turn');
  });

  test('the waking refusal says the wait is short and the text is kept', () => {
    const copy = sendBlockerMessage('runtime_waking');
    expect(copy.message.toLowerCase()).toContain('waking');
    expect((copy.description ?? '').toLowerCase()).toContain('again');
  });
});
