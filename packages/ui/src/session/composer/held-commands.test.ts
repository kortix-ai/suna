import { describe, expect, test } from 'bun:test';

import { canReleaseHeldCommand, heldCommandRows } from './held-commands';

const idle = {
  sessionWorking: false,
  runtimeReady: true,
  awaitingUserInput: false,
  inboxRows: [],
};

describe('canReleaseHeldCommand', () => {
  test('an idle, switched session with an empty inbox runs the command', () => {
    expect(canReleaseHeldCommand(idle)).toBe(true);
  });

  test('a working session holds it: a command mid-turn aborts the turn', () => {
    expect(canReleaseHeldCommand({ ...idle, sessionWorking: true })).toBe(false);
  });

  test('a box that is not up holds it: runCommand would swallow the dispatch', () => {
    expect(canReleaseHeldCommand({ ...idle, runtimeReady: false })).toBe(false);
  });

  test('an open question or permission holds it', () => {
    expect(canReleaseHeldCommand({ ...idle, awaitingUserInput: true })).toBe(false);
  });

  test('a waiting inbox row goes first', () => {
    for (const state of ['sending', 'queued', 'delivering'] as const) {
      expect(canReleaseHeldCommand({ ...idle, inboxRows: [{ state }] })).toBe(false);
    }
  });

  test('a failed row waits for the user and does not hold the command', () => {
    expect(canReleaseHeldCommand({ ...idle, inboxRows: [{ state: 'failed' }] })).toBe(true);
  });
});

describe('heldCommandRows', () => {
  const command = { name: 'review', description: 'Review the diff', template: '', hints: [] };

  test('draws the command as typed, removable, and nothing else', () => {
    const [row] = heldCommandRows([
      { id: 'a', command, args: 'src', split: { before: 'please', after: 'src' } },
    ]);
    expect(row).toMatchObject({
      id: 'command:a',
      text: 'please /review src',
      state: 'queued',
      command: true,
      removable: true,
      retryable: false,
      interruptible: false,
      takeBackEligible: false,
    });
  });

  test('without a split it reads /name args', () => {
    expect(heldCommandRows([{ id: 'b', command, args: 'src' }])[0].text).toBe('/review src');
    expect(heldCommandRows([{ id: 'c', command }])[0].text).toBe('/review');
  });
});
