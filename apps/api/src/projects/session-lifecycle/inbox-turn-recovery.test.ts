import { describe, expect, test } from 'bun:test';
import type { SessionPushEvent } from '../../notifications/session-push';
import { notifyClosedTurn } from '../lib/closed-turn-notification';
import { reconcileInboxTurn, settleCompletedInboxTurns, scheduleSessionTurnRecovery } from './inbox-turn-recovery';

/** A synthetic closed-turn session row: no prompter, no message id. */
const closedTurnRow = (row: { projectId: string; childSession: boolean; endErrorNames?: (string | null)[] }) => ({
  sessionId: 'session-synthetic',
  accountId: '00000000-0000-4000-8000-0000000000aa',
  metadata: {},
  origin: 'user',
  turnMessageId: null,
  errorMessage: null,
  endErrorNames: [] as (string | null)[],
  ...row,
});
const noContext = async () => ({});

const turn = { token: 'token-1', state: 'active', runtimeSessionId: 'ses-1', messageId: 'msg-1', startedAtMs: 1 };
const box = { sessionId: 'session-1', sandboxId: 'box-1', externalId: 'ext-1', provider: 'platinum' as const, metadata: { activeTurns: { 'token-1': turn } } };

describe('queue terminal recovery', () => {
  for (const endReason of ['completed', 'failed'] as const) {
    test(`settles only the observed token after ${endReason}`, async () => {
      const cleared: unknown[][] = [];
      const observed: unknown[][] = [];
      const settled = await settleCompletedInboxTurns(box, {
        provider: (() => ({})) as never,
        observe: async (...args) => { observed.push(args); return { observation: 'terminal', endReason, daemonAnswered: true, orphanedPrompt: false }; },
        clear: async (...args) => { cleared.push(args); return true; },
      });
      expect(settled).toEqual([{ token: 'token-1', reason: endReason }]);
      expect(observed[0]?.[3]).toMatchObject(turn);
      expect(cleared).toEqual([['box-1', 'token-1', undefined, endReason]]);
    });
  }
  for (const [observation, endReason] of [['active', null], ['unknown', null], ['terminal', null], ['terminal', 'abandoned']] as const) {
    test(`preserves authority for ${observation}/${endReason}`, async () => {
      let cleared = false;
      await settleCompletedInboxTurns(box, {
        provider: (() => ({})) as never,
        observe: async () => ({ observation, endReason, daemonAnswered: true, orphanedPrompt: false }),
        clear: async () => { cleared = true; return true; },
      });
      expect(cleared).toBe(false);
    });
  }
  test('does not probe a prompt still being delivered', async () => {
    let observed = false;
    await settleCompletedInboxTurns({ ...box, metadata: { activeTurns: { 'token-1': { ...turn, state: 'delivering' } } } }, {
      provider: (() => ({})) as never,
      observe: async () => { observed = true; return { observation: 'terminal', endReason: 'completed', daemonAnswered: true, orphanedPrompt: false }; },
      clear: async () => true,
    });
    expect(observed).toBe(false);
  });
});


test('concurrent turn readers share one recovery without waiting for the runtime', async () => {
  let calls = 0;
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => { finish = resolve; });
  const recover = async () => { calls++; await pending; return []; };
  scheduleSessionTurnRecovery(box, recover);
  scheduleSessionTurnRecovery(box, recover);
  expect(calls).toBe(1);
  finish();
  await pending;
});


test('a recovered completion wakes its session immediately and does not impose a cooldown', async () => {
  const calls: string[] = [];
  const recover = async () => { calls.push('recover'); return [{ token: 'token-1', reason: 'completed' as const }]; };
  const wake = async (sessionId: string) => { calls.push(sessionId); return false; };
  const recoveredBox = { ...box, sandboxId: 'handoff-box' };
  scheduleSessionTurnRecovery(recoveredBox, recover, wake, async () => {});
  await Bun.sleep(0);
  expect(calls).toEqual(['recover', 'session-1']);
  scheduleSessionTurnRecovery(recoveredBox, async () => { calls.push('next-read'); return []; }, wake);
  await Bun.sleep(0);
  expect(calls).toEqual(['recover', 'session-1', 'next-read']);
});


test('a superseded recovery token cannot wake the queue', async () => {
  expect(await settleCompletedInboxTurns(box, {
    provider: (() => ({})) as never,
    observe: async () => ({ observation: 'terminal', endReason: 'completed', daemonAnswered: true, orphanedPrompt: false }),
    clear: async () => false,
  })).toEqual([]);
});

describe('a recovered turn close pushes once', () => {
  const PROJECT = '00000000-0000-4000-8000-000000000001';
  let seq = 0;
  // Each test needs its own sandbox id: recoveryInFlight is keyed by it.
  const freshBox = () => ({ ...box, sandboxId: `push-box-${++seq}` });
  const settle = (endReason: 'completed' | 'failed', won = true) => (b: Parameters<typeof settleCompletedInboxTurns>[0]) =>
    settleCompletedInboxTurns(b, {
      provider: (() => ({})) as never,
      observe: async () => ({ observation: 'terminal', endReason, daemonAnswered: true, orphanedPrompt: false }),
      clear: async () => won,
    });
  // The real notifier rule with a synthetic session row.
  const realNotify = (childSession: boolean, events: SessionPushEvent[], endErrorNames: (string | null)[] = []) =>
    (input: Parameters<typeof notifyClosedTurn>[0]) =>
      notifyClosedTurn(input, {
        loadSession: async () => closedTurnRow({ projectId: PROJECT, childSession, endErrorNames }),
        context: noContext,
        notify: async (event) => { events.push(event); return { reason: 'no_recipient', recipients: [] }; },
      });
  const flush = async () => { for (let i = 0; i < 5; i++) await Bun.sleep(0); };

  for (const [endReason, type] of [['completed', 'completion'], ['failed', 'error']] as const) {
    test(`a ${endReason} turn sends one ${type} push`, async () => {
      const events: SessionPushEvent[] = [];
      scheduleSessionTurnRecovery(freshBox(), settle(endReason), async () => false, realNotify(false, events));
      await flush();
      expect(events).toMatchObject([{ type, sessionId: 'session-1', projectId: PROJECT }]);
    });
  }

  test('a lost close race sends nothing', async () => {
    const calls: unknown[] = [];
    scheduleSessionTurnRecovery(freshBox(), settle('completed', false), async () => false, async (input) => { calls.push(input); });
    await flush();
    expect(calls).toEqual([]);
  });

  test('a promoted queued prompt cancels the completion push', async () => {
    const events: SessionPushEvent[] = [];
    scheduleSessionTurnRecovery(freshBox(), settle('completed'), async () => true, realNotify(false, events));
    await flush();
    expect(events).toEqual([]);
  });

  test('a failed turn still sends its error when a prompt was promoted', async () => {
    const events: SessionPushEvent[] = [];
    scheduleSessionTurnRecovery(freshBox(), settle('failed'), async () => true, realNotify(false, events));
    await flush();
    expect(events).toMatchObject([{ type: 'error', sessionId: 'session-1', projectId: PROJECT }]);
  });

  test('a child session sends nothing', async () => {
    const events: SessionPushEvent[] = [];
    scheduleSessionTurnRecovery(freshBox(), settle('completed'), async () => false, realNotify(true, events));
    await flush();
    expect(events).toEqual([]);
  });

  test('a wake that throws still sends the error push', async () => {
    const events: SessionPushEvent[] = [];
    scheduleSessionTurnRecovery(freshBox(), settle('failed'), async () => { throw new Error('drain down'); }, realNotify(false, events));
    await flush();
    expect(events).toMatchObject([{ type: 'error', sessionId: 'session-1', projectId: PROJECT }]);
  });

  test('a wake that throws sends no completion: promotion is unknown', async () => {
    const calls: unknown[] = [];
    const events: SessionPushEvent[] = [];
    const notify = realNotify(false, events);
    scheduleSessionTurnRecovery(freshBox(), settle('completed'), async () => { throw new Error('promote down'); },
      async (input) => { calls.push(input); await notify(input); });
    await flush();
    expect(calls).toEqual([{ sessionId: 'session-1', reason: 'completed', promoted: true, turnTokens: ['token-1'] }]);
    expect(events).toEqual([]);
  });

  test('the error push goes out before the wake', async () => {
    const order: string[] = [];
    scheduleSessionTurnRecovery(freshBox(), settle('failed'),
      async () => { order.push('wake'); return false; },
      async (input) => { order.push(`push:${input.reason}`); });
    await flush();
    expect(order).toEqual(['push:failed', 'wake']);
  });

  test('a Stop the user asked for, closed here as failed, sends nothing', async () => {
    const events: SessionPushEvent[] = [];
    scheduleSessionTurnRecovery(freshBox(), settle('failed'), async () => false, realNotify(false, events, ['UserStop']));
    await flush();
    expect(events).toEqual([]);
  });

  test('a real failure closed here still sends its error', async () => {
    const events: SessionPushEvent[] = [];
    scheduleSessionTurnRecovery(freshBox(), settle('failed'), async () => false, realNotify(false, events, ['APIError']));
    await flush();
    expect(events).toMatchObject([{ type: 'error', sessionId: 'session-1', projectId: PROJECT }]);
  });

  test('the completion push waits for the wake', async () => {
    const order: string[] = [];
    scheduleSessionTurnRecovery(freshBox(), settle('completed'),
      async () => { order.push('wake'); return false; },
      async (input) => { order.push(`push:${input.reason}`); });
    await flush();
    expect(order).toEqual(['wake', 'push:completed']);
  });

  test('two cleared turns send one push, error when either failed', async () => {
    const calls: unknown[] = [];
    scheduleSessionTurnRecovery(freshBox(), async () => [
      { token: 'token-a', reason: 'completed' },
      { token: 'token-b', reason: 'failed' },
    ], async () => false, async (input) => { calls.push(input); });
    await flush();
    expect(calls).toEqual([{ sessionId: 'session-1', reason: 'failed', turnTokens: ['token-b'] }]);
  });
});

describe('admission reconcile pushes for the turns it closes', () => {
  const PROJECT = '00000000-0000-4000-8000-000000000001';
  const run = async (endReason: 'completed' | 'failed', opts: { won?: boolean; child?: boolean; found?: boolean } = {}) => {
    const calls: unknown[] = [];
    const events: SessionPushEvent[] = [];
    await reconcileInboxTurn('session-1', {
      readBox: async () => (opts.found === false ? undefined : box),
      settle: (b) => settleCompletedInboxTurns(b, {
        provider: (() => ({})) as never,
        observe: async () => ({ observation: 'terminal', endReason, daemonAnswered: true, orphanedPrompt: false }),
        clear: async () => opts.won ?? true,
      }),
      notify: async (input) => {
        calls.push(input);
        await notifyClosedTurn(input, {
          loadSession: async () => closedTurnRow({ projectId: PROJECT, childSession: opts.child ?? false }),
          context: noContext,
          notify: async (event) => { events.push(event); return { reason: 'no_recipient', recipients: [] }; },
        });
      },
    });
    return { calls, events };
  };

  test('a failed turn sends one error push', async () => {
    const { events } = await run('failed');
    expect(events).toMatchObject([{ type: 'error', sessionId: 'session-1', projectId: PROJECT }]);
  });
  test('a completed turn sends no completion: the queued head prompt runs next', async () => {
    const { calls, events } = await run('completed');
    expect(calls).toEqual([{ sessionId: 'session-1', reason: 'completed', promoted: true }]);
    expect(events).toEqual([]);
  });
  test('a lost close race sends nothing', async () => {
    const { calls } = await run('failed', { won: false });
    expect(calls).toEqual([]);
  });
  test('a child session sends nothing', async () => {
    const { events } = await run('failed', { child: true });
    expect(events).toEqual([]);
  });
  test('a session with no box sends nothing', async () => {
    const { calls } = await run('failed', { found: false });
    expect(calls).toEqual([]);
  });
});
