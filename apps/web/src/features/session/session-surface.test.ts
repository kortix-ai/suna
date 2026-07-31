import { describe, expect, test } from 'bun:test';

import {
  isNewSessionSurface,
  resolveSessionOverlay,
  shouldForgetNewSessionHint,
  shouldMountSessionChat,
} from './session-surface';

describe('isNewSessionSurface', () => {
  test('a session this tab just created has no transcript and gets the shell', () => {
    expect(isNewSessionSurface({ newSessionHint: true, hasTranscript: false })).toBe(true);
  });

  test('transcript evidence revokes a stale new-session hint', () => {
    expect(isNewSessionSurface({ newSessionHint: true, hasTranscript: true })).toBe(false);
  });

  test('a resumed session is never the new-session surface', () => {
    expect(isNewSessionSurface({ newSessionHint: false, hasTranscript: false })).toBe(false);
    expect(isNewSessionSurface({ newSessionHint: false, hasTranscript: true })).toBe(false);
  });
});

describe('shouldMountSessionChat', () => {
  test('a brand-new session holds the chat until the first message is sent', () => {
    const shell = {
      newSessionHint: true,
      hasTranscript: false,
      contentAvailable: true,
      submitted: false,
    };
    expect(shouldMountSessionChat(shell)).toBe(false);
    expect(shouldMountSessionChat({ ...shell, submitted: true })).toBe(true);
  });

  test('THE REGRESSION: a stuck new-session hint cannot withhold an existing transcript', () => {
    // The production failure. A hint left over from another session (an
    // in-memory fresh-mark, or a start-stash that was never consumed) said
    // "brand new" about a session with hours of history. The chat was then
    // never mounted, so it could never report ready, so the hint was never
    // cleared: the session painted the empty project-home surface until a hard
    // reload. Transcript evidence has to beat the hint, unconditionally.
    expect(
      shouldMountSessionChat({
        newSessionHint: true,
        hasTranscript: true,
        contentAvailable: true,
        submitted: false,
      }),
    ).toBe(true);
  });

  test('no deadlock exists: mounting never depends on a signal the chat produces', () => {
    // Enumerate every hint/submitted combination a session WITH history can be
    // in. If any of them withholds the chat, the surface can strand again —
    // because `chatReady` (and everything downstream of it) is produced by the
    // very chat being withheld.
    const withheld = [true, false].flatMap((newSessionHint) =>
      [true, false]
        .map((submitted) => ({
          newSessionHint,
          submitted,
          hasTranscript: true,
          contentAvailable: true,
        }))
        .filter((input) => !shouldMountSessionChat(input)),
    );
    expect(withheld).toEqual([]);
  });

  test('without a transcript pin there is nothing to mount on', () => {
    expect(
      shouldMountSessionChat({
        newSessionHint: false,
        hasTranscript: true,
        contentAvailable: false,
        submitted: true,
      }),
    ).toBe(false);
  });
});

describe('resolveSessionOverlay', () => {
  test('a resuming session boots under the loader, never the empty home surface', () => {
    expect(
      resolveSessionOverlay({
        newSessionHint: false,
        hasTranscript: false,
        submittedOnShell: false,
      }),
    ).toBe('boot-loader');
  });

  test('a session with history never shows the new-session shell', () => {
    expect(
      resolveSessionOverlay({ newSessionHint: true, hasTranscript: true, submittedOnShell: false }),
    ).toBe('boot-loader');
  });

  test('a genuinely new session gets the typeable shell', () => {
    expect(
      resolveSessionOverlay({
        newSessionHint: true,
        hasTranscript: false,
        submittedOnShell: false,
      }),
    ).toBe('new-session-shell');
  });

  test('the shell keeps the floor once the user has sent from it', () => {
    // Their first message lands in the transcript store before the chat has
    // crossfaded in. Without this the overlay would swap the optimistic bubble
    // they are looking at for a boot spinner, mid-send.
    expect(
      resolveSessionOverlay({ newSessionHint: true, hasTranscript: true, submittedOnShell: true }),
    ).toBe('new-session-shell');
  });
});

describe('shouldForgetNewSessionHint', () => {
  test('a wrong hint is dropped by transcript evidence, not by the chat it blocks', () => {
    expect(
      shouldForgetNewSessionHint({ chatReady: false, hasTranscript: true, submitted: false }),
    ).toBe(true);
  });

  test('kept only while the session still looks new and untouched', () => {
    expect(
      shouldForgetNewSessionHint({ chatReady: false, hasTranscript: false, submitted: false }),
    ).toBe(false);
  });

  test('dropped once the chat paints or the user sends', () => {
    expect(
      shouldForgetNewSessionHint({ chatReady: true, hasTranscript: false, submitted: false }),
    ).toBe(true);
    expect(
      shouldForgetNewSessionHint({ chatReady: false, hasTranscript: false, submitted: true }),
    ).toBe(true);
  });
});
