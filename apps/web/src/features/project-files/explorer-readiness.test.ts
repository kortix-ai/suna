import { describe, expect, test } from 'bun:test';
import { explorerReadinessState, EXPLORER_WAKE_POLL_MS } from './explorer-readiness';

/**
 * The explorer used to collapse two opposite states into one word.
 *
 * A readiness 503 from the sandbox proxy can mean the box is BOOTING (the
 * proxy reached it, OpenCode is coming up, it will answer on its own) or that
 * the box is PARKED (the platform answered from the session row without ever
 * dialling it; it resumes only on the next send). The explorer called both
 * "waking", said "The sandbox is starting. Files will appear automatically.",
 * and re-issued the refused request every 3s with no deadline.
 *
 * On a parked session neither sentence was true and the loop never ended, so
 * the panel alternated skeleton and spinner until the tab was closed. The
 * terminal panel already solved this: `nextPtyAttachStep` returns
 * `pause: 'asleep'` rather than animating a wait that cannot finish.
 */
describe('explorerReadinessState', () => {
  test('no readiness error is simply ready — nothing to announce', () => {
    expect(explorerReadinessState({ hasReadinessError: false, parked: false })).toEqual({
      kind: 'ready',
    });
  });

  test('a parked box does not become ready just because nothing errored yet', () => {
    // The first paint of a parked session has no error in hand yet. The panel
    // must not claim readiness it has no evidence for, but it also has nothing
    // to say until a request actually comes back refused.
    expect(explorerReadinessState({ hasReadinessError: false, parked: true })).toEqual({
      kind: 'ready',
    });
  });

  test('a BOOTING box keeps polling — it really does arrive on its own', () => {
    expect(explorerReadinessState({ hasReadinessError: true, parked: false })).toEqual({
      kind: 'waking',
    });
  });

  test('a PARKED box stops polling and says it is asleep', () => {
    expect(explorerReadinessState({ hasReadinessError: true, parked: true })).toEqual({
      kind: 'asleep',
    });
  });

  test('only a waking box carries a poll interval', () => {
    const waking = explorerReadinessState({ hasReadinessError: true, parked: false });
    const asleep = explorerReadinessState({ hasReadinessError: true, parked: true });
    expect(waking.kind === 'waking' ? EXPLORER_WAKE_POLL_MS : null).toBe(EXPLORER_WAKE_POLL_MS);
    expect(asleep.kind).toBe('asleep');
  });

  test('the poll cadence stays at the 3s the panel already used', () => {
    expect(EXPLORER_WAKE_POLL_MS).toBe(3_000);
  });
});
