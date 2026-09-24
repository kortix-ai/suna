import { describe, expect, test } from 'bun:test';
import {
  leaveSandboxOnFocus,
  pendingOpenedThread,
  showsSessionContent,
  threadSandboxReady,
} from './session-sandbox';

const HOME = { activeSessionId: null, activePageId: null };
const URL_A = 'https://api.example.com/v1/p/ext-a/8000';
const URL_B = 'https://api.example.com/v1/p/ext-b/8000';

describe('showsSessionContent', () => {
  test('project home shows no session content', () => {
    expect(showsSessionContent(HOME)).toBe(false);
  });

  test('a thread or a page is session content', () => {
    expect(showsSessionContent({ ...HOME, activeSessionId: 'ses_1' })).toBe(true);
    expect(showsSessionContent({ ...HOME, activePageId: 'page:browser' })).toBe(true);
  });

  test('a connecting session is not an input: it needs no sandbox', () => {
    // The input type has no connecting field; extra keys are ignored.
    const connecting = { ...HOME, connectingProjectSessionId: 'ps_2' };
    expect(showsSessionContent(connecting)).toBe(false);
  });
});

describe('leaveSandboxOnFocus', () => {
  test('project home with no open in progress leaves the sandbox', () => {
    expect(leaveSandboxOnFocus({ ...HOME, connectInProgress: false })).toBe(true);
  });

  test('a session open in progress keeps the sandbox', () => {
    expect(leaveSandboxOnFocus({ ...HOME, connectInProgress: true })).toBe(false);
  });

  test('session content on screen keeps the sandbox', () => {
    expect(
      leaveSandboxOnFocus({ ...HOME, activeSessionId: 'ses_1', connectInProgress: false })
    ).toBe(false);
    expect(
      leaveSandboxOnFocus({ ...HOME, activePageId: 'page:terminal', connectInProgress: false })
    ).toBe(false);
  });
});

describe('threadSandboxReady', () => {
  test('no thread is never ready', () => {
    expect(
      threadSandboxReady({
        activeSessionId: null,
        sandboxUrl: URL_A,
        openedThread: { sessionId: 'ses_a', sandboxUrl: URL_A },
      })
    ).toBe(false);
  });

  test('the connect flow opened this thread and its sandbox is switched in', () => {
    expect(
      threadSandboxReady({
        activeSessionId: 'ses_b',
        sandboxUrl: URL_B,
        openedThread: { sessionId: 'ses_b', sandboxUrl: URL_B },
      })
    ).toBe(true);
  });

  test('the context still holds the previous session sandbox', () => {
    expect(
      threadSandboxReady({
        activeSessionId: 'ses_b',
        sandboxUrl: URL_A,
        openedThread: { sessionId: 'ses_b', sandboxUrl: URL_B },
      })
    ).toBe(false);
  });

  test('the context holds no sandbox yet', () => {
    expect(
      threadSandboxReady({
        activeSessionId: 'ses_b',
        sandboxUrl: undefined,
        openedThread: { sessionId: 'ses_b', sandboxUrl: URL_B },
      })
    ).toBe(false);
  });

  test('compares the exact value, not a prefix', () => {
    expect(
      threadSandboxReady({
        activeSessionId: 'ses_b',
        sandboxUrl: `${URL_B}/`,
        openedThread: { sessionId: 'ses_b', sandboxUrl: URL_B },
      })
    ).toBe(false);
    expect(
      threadSandboxReady({
        activeSessionId: 'ses_b',
        sandboxUrl: 'https://api.example.com/v1/p/ext-b/80001',
        openedThread: { sessionId: 'ses_b', sandboxUrl: URL_B },
      })
    ).toBe(false);
  });

  test('a thread opened outside the connect flow renders on the context sandbox', () => {
    expect(
      threadSandboxReady({ activeSessionId: 'ses_c', sandboxUrl: URL_A, openedThread: null })
    ).toBe(true);
    expect(
      threadSandboxReady({
        activeSessionId: 'ses_c',
        sandboxUrl: URL_A,
        openedThread: { sessionId: 'ses_b', sandboxUrl: URL_B },
      })
    ).toBe(true);
  });
});

describe('pendingOpenedThread', () => {
  test('the record stays while the switch is pending', () => {
    const record = { sessionId: 'ses_b', sandboxUrl: URL_B };
    expect(
      pendingOpenedThread({ activeSessionId: 'ses_b', sandboxUrl: URL_A, openedThread: record })
    ).toBe(record);
    expect(
      pendingOpenedThread({ activeSessionId: 'ses_b', sandboxUrl: undefined, openedThread: record })
    ).toBe(record);
  });

  test('the first match drops the record', () => {
    expect(
      pendingOpenedThread({
        activeSessionId: 'ses_b',
        sandboxUrl: URL_B,
        openedThread: { sessionId: 'ses_b', sandboxUrl: URL_B },
      })
    ).toBeNull();
  });

  test('a record for another thread, or no thread, stays', () => {
    const record = { sessionId: 'ses_b', sandboxUrl: URL_B };
    expect(
      pendingOpenedThread({ activeSessionId: 'ses_c', sandboxUrl: URL_B, openedThread: record })
    ).toBe(record);
    expect(
      pendingOpenedThread({ activeSessionId: null, sandboxUrl: URL_B, openedThread: record })
    ).toBe(record);
    expect(
      pendingOpenedThread({ activeSessionId: 'ses_b', sandboxUrl: URL_B, openedThread: null })
    ).toBeNull();
  });

  test('matched once, then the override changes → ready', () => {
    const URL_X = 'https://api.example.com/v1/p/ext-x/8000';
    let openedThread: { sessionId: string; sandboxUrl: string } | null = {
      sessionId: 'ses_b',
      sandboxUrl: URL_B,
    };

    // Commit 1: the thread commits before its sandbox.
    expect(threadSandboxReady({ activeSessionId: 'ses_b', sandboxUrl: URL_A, openedThread })).toBe(
      false
    );
    openedThread = pendingOpenedThread({ activeSessionId: 'ses_b', sandboxUrl: URL_A, openedThread });

    // Commit 2: the sandbox switches in, the record matches once and drops.
    expect(threadSandboxReady({ activeSessionId: 'ses_b', sandboxUrl: URL_B, openedThread })).toBe(
      true
    );
    openedThread = pendingOpenedThread({ activeSessionId: 'ses_b', sandboxUrl: URL_B, openedThread });
    expect(openedThread).toBeNull();

    // Commit 3: Settings → Instances switches the override; the thread stays.
    expect(threadSandboxReady({ activeSessionId: 'ses_b', sandboxUrl: URL_X, openedThread })).toBe(
      true
    );
  });
});
