import { describe, expect, test } from 'bun:test';

import { sessionComposerReadiness } from './session-composer-readiness';

describe('sessionComposerReadiness', () => {
  test('a ready runtime leaves the composer alone — no notice', () => {
    expect(sessionComposerReadiness({ runtimeReady: true })).toEqual({
      ready: true,
      notice: null,
      retryable: false,
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

  test('booting/connecting (not yet unreachable) is not retryable', () => {
    // The default — still within the poll loop's failure threshold. No
    // manual retry offered; the background poller is expected to resolve
    // this on its own shortly.
    const readiness = sessionComposerReadiness({ runtimeReady: false, unreachable: false });

    expect(readiness.retryable).toBe(false);
    expect(readiness.notice).toMatch(/waking/i);
  });

  test('confirmed unreachable offers a retry and says so, distinctly from "waking"', () => {
    // Past `FAIL_THRESHOLD_*` — `useRuntimePhase() === 'unreachable'`. Same
    // "not ready" bucket as a booting sandbox, but this one has been failing
    // for a while and the user needs to know an escape hatch exists instead
    // of staring at an unchanging "waking up" forever. See `retryable`'s doc.
    const readiness = sessionComposerReadiness({ runtimeReady: false, unreachable: true });

    expect(readiness.ready).toBe(false);
    expect(readiness.retryable).toBe(true);
    expect(readiness.notice).not.toMatch(/waking/i);
    expect(readiness.notice).toMatch(/queue/i);
  });

  test('stalled (booting past the ceiling, never unreachable) also offers a retry', () => {
    // The gap `unreachable` alone can't cover: a sandbox proxy that keeps
    // answering 503 resets the probe's failure counter every tick, so
    // `unreachable` never fires no matter how long OpenCode stays wedged
    // mid-boot. `useRuntimeBootStalled()` is the only thing that still bounds
    // that case — see its doc and `bootingSinceAt` on the connection store.
    const readiness = sessionComposerReadiness({ runtimeReady: false, stalled: true });

    expect(readiness.ready).toBe(false);
    expect(readiness.retryable).toBe(true);
    expect(readiness.notice).toMatch(/queue/i);
  });

  test('unreachable is checked before stalled — its notice wins when both are true', () => {
    const readiness = sessionComposerReadiness({
      runtimeReady: false,
      unreachable: true,
      stalled: true,
    });

    expect(readiness.notice).toMatch(/lost contact/i);
  });
});
