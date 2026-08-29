import { describe, expect, test } from 'bun:test';

import {
  canMountSessionChat,
  findInitialSessionPin,
  gatedRuntimeError,
  resolveSessionContentState,
  runtimeErrorPresentation,
  sessionErrorSurfaceReady,
} from './session-load-state';

describe('runtimeErrorPresentation', () => {
  const runtimeError = { status: 503, message: 'sandbox not ready' };

  test('keeps a resolved conversation mounted and presents recovery inline', () => {
    expect(
      runtimeErrorPresentation({
        chatSessionId: 'ses_root',
        runtimeError,
        runtimeBootError: 'daemon unavailable',
      }),
    ).toEqual({ replaceSession: false, inlineRecovery: true });
  });

  test('uses the full error surface when no conversation can render', () => {
    expect(
      runtimeErrorPresentation({ chatSessionId: null, runtimeError, runtimeBootError: null }),
    ).toEqual({ replaceSession: true, inlineRecovery: false });
  });

  test('renders no recovery state when runtime errors are absent', () => {
    expect(
      runtimeErrorPresentation({
        chatSessionId: 'ses_root',
        runtimeError: null,
        runtimeBootError: null,
      }),
    ).toEqual({ replaceSession: false, inlineRecovery: false });
  });
});

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

describe('resolveSessionContentState — the transcript read, not the session object', () => {
  const base = {
    runtimeReady: true,
    sessionFetched: true,
    hasRuntimeSession: true,
    hasMessages: false,
    hasOptimisticPrompt: false,
  };

  /**
   * The blank thread. The session GET is small and lands first; the message
   * read is the big one and is the one that loses to a waking box. Treating the
   * first as proof of the second rendered a full shell — header, composer,
   * empty thread — over a session with a long history.
   */
  test('a session object with no transcript read yet is still loading', () => {
    expect(resolveSessionContentState({ ...base, transcriptLoaded: false })).toEqual({
      isNotFound: false,
      isDataLoading: true,
    });
  });

  test('a session that really has no messages renders its composer', () => {
    expect(resolveSessionContentState({ ...base, transcriptLoaded: true })).toEqual({
      isNotFound: false,
      isDataLoading: false,
    });
  });

  test('messages on screen are never hidden by a pending read', () => {
    expect(
      resolveSessionContentState({ ...base, hasMessages: true, transcriptLoaded: false }),
    ).toEqual({ isNotFound: false, isDataLoading: false });
  });

  /**
   * DELIBERATE CONTRACT CHANGE (Jay, 2026-08-28). The old rule — "an
   * optimistic prompt is content too, read or no read" — let the prompt-inbox
   * rows (one fast DB read off the open bundle) dismiss the loader before the
   * transcript hydrated. The user watched their own messages paint alone and
   * the assistant replies pop in seconds later as a second mutation. On an
   * EXISTING session the paint is now atomic: hold the loader while the first
   * transcript read is outstanding, whatever the inbox says, then paint the
   * whole conversation at once.
   */
  test('inbox rows do not end the loader while the transcript read is outstanding', () => {
    expect(
      resolveSessionContentState({ ...base, hasOptimisticPrompt: true, transcriptLoaded: false }),
    ).toEqual({ isNotFound: false, isDataLoading: true });
  });

  test('once the transcript read lands, inbox rows paint with it', () => {
    expect(
      resolveSessionContentState({ ...base, hasOptimisticPrompt: true, transcriptLoaded: true }),
    ).toEqual({ isNotFound: false, isDataLoading: false });
  });

  test('a BRAND-NEW session still paints its first prompt on the keypress', () => {
    // No runtime session exists yet — there is no transcript to wait for, and
    // the Enter-paints-now contract holds: the optimistic bubble is the page.
    expect(
      resolveSessionContentState({
        ...base,
        hasRuntimeSession: false,
        hasOptimisticPrompt: true,
        transcriptLoaded: false,
      }),
    ).toEqual({ isNotFound: false, isDataLoading: false });
  });

  test('a caller that does not track the read keeps the old rule', () => {
    expect(resolveSessionContentState(base)).toEqual({
      isNotFound: false,
      isDataLoading: false,
    });
  });

  test('not-found still wins — there is no session to wait for', () => {
    expect(
      resolveSessionContentState({
        ...base,
        hasRuntimeSession: false,
        transcriptLoaded: false,
      }),
    ).toEqual({ isNotFound: true, isDataLoading: false });
  });
});
