import { describe, expect, test } from 'bun:test';

import {
  canMountSessionChat,
  findInitialSessionPin,
  gatedRuntimeError,
  resolveSessionContentState,
  sessionErrorSurfaceReady,
} from './session-load-state';

describe('session load state', () => {
  test('uses the authorized project-session list as an initial transcript pin', () => {
    expect(
      findInitialSessionPin(
        [
          { session_id: 'session-a', opencode_session_id: 'ses_a' },
          { session_id: 'session-b', opencode_session_id: 'ses_b' },
        ],
        'session-b',
      ),
    ).toBe('ses_b');
    expect(findInitialSessionPin(undefined, 'session-b')).toBeNull();
  });

  test('mounts cached transcript content before the runtime switch completes', () => {
    expect(
      canMountSessionChat({
        switched: false,
        opencodeSessionId: 'opencode-cached',
      }),
    ).toBe(true);
  });

  test('keeps a session without a known transcript pin on the boot surface', () => {
    expect(
      canMountSessionChat({
        switched: false,
        opencodeSessionId: null,
      }),
    ).toBe(false);
  });

  test('a transcript pin alone does not end the boot shell', () => {
    expect(sessionErrorSurfaceReady({ runtimeError: null, runtimeBootError: null })).toBe(false);
  });

  test('a settled runtime error ends the boot shell so the card can be read', () => {
    expect(
      sessionErrorSurfaceReady({ runtimeError: new Error('gone'), runtimeBootError: null }),
    ).toBe(true);
  });

  test('keeps hydrated messages visible after a runtime session lookup miss', () => {
    expect(
      resolveSessionContentState({
        runtimeReady: true,
        sessionFetched: true,
        hasRuntimeSession: false,
        hasMessages: true,
        hasOptimisticPrompt: false,
      }),
    ).toEqual({
      isNotFound: false,
      isDataLoading: false,
    });
  });

  test('reports a terminal lookup miss when the session has no content', () => {
    expect(
      resolveSessionContentState({
        runtimeReady: true,
        sessionFetched: true,
        hasRuntimeSession: false,
        hasMessages: false,
        hasOptimisticPrompt: false,
      }),
    ).toEqual({
      isNotFound: true,
      isDataLoading: false,
    });
  });

  test('keeps an unresolved session on the loading surface', () => {
    expect(
      resolveSessionContentState({
        runtimeReady: false,
        sessionFetched: false,
        hasRuntimeSession: false,
        hasMessages: false,
        hasOptimisticPrompt: false,
      }),
    ).toEqual({
      isNotFound: false,
      isDataLoading: true,
    });
  });

  test('keeps an optimistic prompt visible during a runtime session lookup miss', () => {
    expect(
      resolveSessionContentState({
        runtimeReady: true,
        sessionFetched: true,
        hasRuntimeSession: false,
        hasMessages: false,
        hasOptimisticPrompt: true,
      }),
    ).toEqual({
      isNotFound: false,
      isDataLoading: false,
    });
  });

  test('hides a runtime error while phase still reads starting — a wake racing /start is not a failure', () => {
    expect(
      gatedRuntimeError({
        phase: 'starting',
        runtimeError: { status: 503, body: { error: 'sandbox not ready (status: stopped)' } },
      }),
    ).toBeNull();
  });

  test('surfaces the runtime error once phase has settled to error', () => {
    const runtimeError = { status: 500, body: { error: 'boom' } };
    expect(gatedRuntimeError({ phase: 'error', runtimeError })).toBe(runtimeError);
  });

  test('stays null with no runtime error, regardless of phase', () => {
    expect(gatedRuntimeError({ phase: 'ready', runtimeError: null })).toBeNull();
    expect(gatedRuntimeError({ phase: 'starting', runtimeError: null })).toBeNull();
  });
});
