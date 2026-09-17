import { describe, expect, test } from 'bun:test';
import { resolveEffectiveBusy, retryingAssistantGates } from './session-chat-busy';

describe('resolveEffectiveBusy', () => {
  test('a server-busy session is busy', () => {
    expect(
      resolveEffectiveBusy({
        isServerBusy: true,
        isOptimisticCompacting: false,
        hasRetryingAssistant: false,
      }),
    ).toBe(true);
  });

  test('an optimistically compacting session is busy', () => {
    expect(
      resolveEffectiveBusy({
        isServerBusy: false,
        isOptimisticCompacting: true,
        hasRetryingAssistant: false,
      }),
    ).toBe(true);
  });

  // S7: a turn mid provider-retry is LIVE. The projection can read idle for it
  // (the runtime's last status frame is stale by construction during a backoff),
  // so the retrying-turn predicate has to be able to answer on its own.
  test('a turn mid provider-retry is busy even when the projection says idle', () => {
    expect(
      resolveEffectiveBusy({
        isServerBusy: false,
        isOptimisticCompacting: false,
        hasRetryingAssistant: true,
      }),
    ).toBe(true);
  });

  test('an idle session with no retrying turn is not busy', () => {
    expect(
      resolveEffectiveBusy({
        isServerBusy: false,
        isOptimisticCompacting: false,
        hasRetryingAssistant: false,
      }),
    ).toBe(false);
  });
});

describe('retryingAssistantGates — a retrying reply holds Stop only on a fresh read', () => {
  test('Stop holds while the read that shows the open turn is fresh', () => {
    expect(
      retryingAssistantGates({
        retryingAssistantTurn: true,
        serverOpenTurnToken: 'tt-1',
        serverOpenTurnFresh: true,
      }),
    ).toEqual({ holdsStop: true, blocksCommand: true });
  });

  test('Stop releases once that read ages out; a `/` command still waits for the turn to end', () => {
    // A tab whose `/turn` reads stopped landing kept the token for the life of
    // the page, and the retrying reply pinned Stop on it.
    expect(
      retryingAssistantGates({
        retryingAssistantTurn: true,
        serverOpenTurnToken: 'tt-1',
        serverOpenTurnFresh: false,
      }),
    ).toEqual({ holdsStop: false, blocksCommand: true });
    expect(
      retryingAssistantGates({
        retryingAssistantTurn: true,
        serverOpenTurnToken: 'tt-1',
        serverOpenTurnFresh: undefined,
      }),
    ).toEqual({ holdsStop: false, blocksCommand: true });
  });

  test('guard: no open turn, or no retrying reply, holds nothing', () => {
    expect(
      retryingAssistantGates({
        retryingAssistantTurn: true,
        serverOpenTurnToken: null,
        serverOpenTurnFresh: false,
      }),
    ).toEqual({ holdsStop: false, blocksCommand: false });
    expect(
      retryingAssistantGates({
        retryingAssistantTurn: false,
        serverOpenTurnToken: 'tt-1',
        serverOpenTurnFresh: true,
      }),
    ).toEqual({ holdsStop: false, blocksCommand: false });
  });
});

describe('the command gate and the Stop display', () => {
  test('a stale read releases Stop but a `/` command still refuses', () => {
    const gates = retryingAssistantGates({
      retryingAssistantTurn: true,
      serverOpenTurnToken: 'tt-1',
      serverOpenTurnFresh: false,
    });
    const idle = { isServerBusy: false, isOptimisticCompacting: false };
    expect(resolveEffectiveBusy({ ...idle, hasRetryingAssistant: gates.holdsStop })).toBe(false);
    expect(resolveEffectiveBusy({ ...idle, hasRetryingAssistant: gates.blocksCommand })).toBe(true);
  });
});
