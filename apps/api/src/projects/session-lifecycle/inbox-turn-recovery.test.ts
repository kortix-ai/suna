import { describe, expect, test } from 'bun:test';
import { settleCompletedInboxTurns, scheduleSessionTurnRecovery } from './inbox-turn-recovery';

const turn = { token: 'token-1', state: 'active', opencodeSessionId: 'ses-1', messageId: 'msg-1', startedAtMs: 1 };
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
      expect(settled).toBe(true);
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
  const recover = async () => { calls++; await pending; return false; };
  scheduleSessionTurnRecovery(box, recover);
  scheduleSessionTurnRecovery(box, recover);
  expect(calls).toBe(1);
  finish();
  await pending;
});


test('a recovered completion wakes its session immediately and does not impose a cooldown', async () => {
  const calls: string[] = [];
  const recover = async () => { calls.push('recover'); return true; };
  const wake = async (sessionId: string) => { calls.push(sessionId); };
  const recoveredBox = { ...box, sandboxId: 'handoff-box' };
  scheduleSessionTurnRecovery(recoveredBox, recover, wake);
  await Bun.sleep(0);
  expect(calls).toEqual(['recover', 'session-1']);
  scheduleSessionTurnRecovery(recoveredBox, async () => { calls.push('next-read'); return false; }, wake);
  await Bun.sleep(0);
  expect(calls).toEqual(['recover', 'session-1', 'next-read']);
});


test('a superseded recovery token cannot wake the queue', async () => {
  expect(await settleCompletedInboxTurns(box, {
    provider: (() => ({})) as never,
    observe: async () => ({ observation: 'terminal', endReason: 'completed', daemonAnswered: true, orphanedPrompt: false }),
    clear: async () => false,
  })).toBe(false);
});
