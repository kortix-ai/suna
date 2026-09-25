import { beforeEach, expect, test } from 'bun:test';
import { useSessionWorkingStore } from '../browser/stores/session-working-store';
import { cancelSessionTurn } from './session-stop';

// `useSession().cancel()` is the Stop of every host built on `useSession`.
// A prompt queued while a turn runs has already been forwarded into the
// runtime's live queue; the abort drops that queue, and the server redelivers
// the row at once unless the session's prompt inbox was held FIRST. So Stop
// must hold the inbox, and only then abort — the same pairing
// `stopWithReceipt` makes for `useSessionSend().stop()`.

beforeEach(() => {
  useSessionWorkingStore.getState().reset();
});

test('cancel holds the prompt inbox before the abort goes out', async () => {
  const order: string[] = [];
  const settlement = await cancelSessionTurn({
    projectId: 'proj_1',
    sessionId: 'kses_1',
    runtimeSessionId: 'ses_1',
    runtimeActionReady: true,
    holdInboxPrompts: async (projectId, sessionId, held) => {
      order.push(`hold ${projectId} ${sessionId} ${held}`);
    },
    runAbort: async () => {
      order.push('abort');
    },
  });

  expect(order).toEqual(['hold proj_1 kses_1 true', 'abort']);
  expect(settlement.status).toBe('aborted');
  expect(useSessionWorkingStore.getState().aborts.kses_1).toBeDefined();
});

test('a failed hold never costs the user the abort', async () => {
  const order: string[] = [];
  const settlement = await cancelSessionTurn({
    projectId: 'proj_1',
    sessionId: 'kses_1',
    runtimeSessionId: 'ses_1',
    runtimeActionReady: true,
    holdInboxPrompts: async () => {
      order.push('hold');
      throw new Error('inbox unavailable');
    },
    runAbort: async () => {
      order.push('abort');
    },
  });

  expect(order).toEqual(['hold', 'abort']);
  expect(settlement.status).toBe('aborted');
});

test('before the runtime is bound, cancel neither holds nor aborts', async () => {
  const order: string[] = [];
  const settlement = await cancelSessionTurn({
    projectId: 'proj_1',
    sessionId: 'kses_1',
    runtimeSessionId: '',
    runtimeActionReady: false,
    holdInboxPrompts: async () => {
      order.push('hold');
    },
    runAbort: async () => {
      order.push('abort');
    },
  });

  expect(order).toEqual([]);
  expect(settlement.status).toBe('skipped');
});
