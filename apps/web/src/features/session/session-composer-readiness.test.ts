import { describe, expect, test } from 'bun:test';

import { sessionComposerReadiness } from './session-composer-readiness';

describe('sessionComposerReadiness', () => {
  test('a ready runtime leaves the composer alone — no notice', () => {
    expect(sessionComposerReadiness({ runtimeReady: true })).toEqual({
      ready: true,
      notice: null,
    });
  });

  test('a sleeping sandbox reports not-ready WITHOUT disabling anything', () => {
    // The behaviour change this file exists to pin. It used to return
    // `{ disabled: true }`, which produced a dead editor and a spinner where
    // the send button belongs — indistinguishable from a broken composer, and
    // for a stopped sandbox it never cleared on its own. The shape no longer
    // has a `disabled` field for a caller to reach for.
    const readiness = sessionComposerReadiness({ runtimeReady: false });

    expect(readiness.ready).toBe(false);
    expect('disabled' in readiness).toBe(false);
  });

  test('says what is happening AND what a send will do', () => {
    // Both halves matter: the send button stays live, so a notice that only
    // says "waking" leaves pressing it looking like nothing happened.
    const { notice } = sessionComposerReadiness({ runtimeReady: false });

    expect(notice).toMatch(/waking/i);
    expect(notice).toMatch(/queue/i);
  });

  test('the notice is null when ready, so the bar cannot render on a live session', () => {
    expect(sessionComposerReadiness({ runtimeReady: true }).notice).toBeNull();
  });
});
