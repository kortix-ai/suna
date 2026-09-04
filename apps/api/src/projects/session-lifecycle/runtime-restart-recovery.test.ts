import { describe, expect, test } from 'bun:test';
import {
  type LostTurn,
  type RuntimeRestartRecoveryDeps,
  recoverTurnsAfterRuntimeRestart,
} from './runtime-restart-recovery';

function deps(lost: LostTurn[], overrides: Partial<RuntimeRestartRecoveryDeps> = {}) {
  const requeued: Array<Record<string, unknown>> = [];
  const logs: Array<{ message: string; meta: Record<string, unknown> }> = [];
  const reArmedSessions: string[] = [];
  const drains: number[] = [];
  const d: RuntimeRestartRecoveryDeps = {
    settleLostTurns: async () => lost,
    reArmBlockedPrompts: async (sessionId) => {
      reArmedSessions.push(sessionId);
      return 0;
    },
    kickDrain: () => drains.push(1),
    requeue: async (input) => {
      requeued.push(input);
      return 'requeued';
    },
    log: (message, meta) => logs.push({ message, meta }),
    ...overrides,
  };
  return { d, requeued, logs, reArmedSessions, drains };
}

describe('recoverTurnsAfterRuntimeRestart (Essentia 2026-08-25: wake under an open turn)', () => {
  test('a box with no open turn is untouched', async () => {
    const { d, requeued, logs } = deps([]);
    const result = await recoverTurnsAfterRuntimeRestart({ sandboxId: 'sb', sessionId: 'ses' }, d);
    expect(result.lost).toEqual([]);
    expect(requeued).toEqual([]);
    expect(logs).toEqual([]);
  });

  test('every open turn is settled and each prompt it carried is redelivered DUE on a wake', async () => {
    const { d, requeued } = deps([
      { token: 't-active', messageId: 'msg_active', state: 'active' },
      { token: 't-delivering', messageId: 'msg_delivering', state: 'delivering' },
      { token: 't-no-prompt', messageId: null, state: 'active' },
    ]);
    const result = await recoverTurnsAfterRuntimeRestart(
      { sandboxId: 'sb', sessionId: 'ses', externalId: 'ext' },
      d,
    );
    expect(result.lost).toHaveLength(3);
    expect(requeued).toEqual([
      {
        sessionId: 'ses',
        wireMessageId: 'msg_active',
        turnToken: 't-active',
        endReason: 'runtime_gone',
        hold: false,
      },
      {
        sessionId: 'ses',
        wireMessageId: 'msg_delivering',
        turnToken: 't-delivering',
        endReason: 'runtime_gone',
        hold: false,
      },
      {
        sessionId: 'ses',
        wireMessageId: null,
        turnToken: 't-no-prompt',
        endReason: 'runtime_gone',
        hold: false,
      },
    ]);
  });

  test('hold:true keeps the prompt visible but not due', async () => {
    const { d, requeued } = deps([{ token: 't', messageId: 'm', state: 'active' }]);
    await recoverTurnsAfterRuntimeRestart({ sandboxId: 'sb', sessionId: 'ses', hold: true }, d);
    expect(requeued[0]?.hold).toBe(true);
  });

  test('one failed redelivery does not stop the others and is reported, never thrown', async () => {
    let calls = 0;
    const { d, logs } = deps(
      [
        { token: 't1', messageId: 'm1', state: 'active' },
        { token: 't2', messageId: 'm2', state: 'active' },
      ],
      {
        requeue: async () => {
          calls += 1;
          if (calls === 1) throw new Error('inbox unavailable');
          return 'requeued';
        },
      },
    );
    const result = await recoverTurnsAfterRuntimeRestart({ sandboxId: 'sb', sessionId: 'ses' }, d);
    expect(result.redeliveries).toEqual([
      { token: 't1', outcome: 'error' },
      { token: 't2', outcome: 'requeued' },
    ]);
    expect(logs.some((l) => l.message.includes('redelivery failed'))).toBe(true);
  });
});

// A prompt parked because the RUNTIME was down (store.parkPromptForUnreachableRuntime)
// is waiting for exactly one event: the runtime becoming reachable again. Both
// callers of this function observe that event — a confirmed wake
// (routes/shared.ts resumeStoppedSandbox → finalize) and the proxy finding a
// restarted box (sandbox-proxy/backend.ts) — so this is where the wait ends.
describe('recoverTurnsAfterRuntimeRestart — the runtime is back, so parked prompts go out', () => {
  test('re-arms this session and kicks the drain rather than waiting for the tick', async () => {
    const reArmed: string[] = [];
    const { d, reArmedSessions, drains } = deps([], {
      reArmBlockedPrompts: async (sessionId) => {
        reArmed.push(sessionId);
        return 2;
      },
    });
    const result = await recoverTurnsAfterRuntimeRestart({ sandboxId: 'sb', sessionId: 'ses' }, d);
    expect(result.reArmed).toBe(2);
    expect(reArmed).toEqual(['ses']);
    expect(drains).toEqual([1]);
    expect(reArmedSessions).toEqual([]);
  });

  test('a box that comes back with NOTHING to settle still re-arms — the user still sent it', async () => {
    const { d, reArmedSessions } = deps([]);
    const result = await recoverTurnsAfterRuntimeRestart({ sandboxId: 'sb', sessionId: 'ses' }, d);
    expect(result.lost).toEqual([]);
    expect(reArmedSessions).toEqual(['ses']);
  });

  test('nothing parked → no drain kick', async () => {
    const { d, drains } = deps([]);
    await recoverTurnsAfterRuntimeRestart({ sandboxId: 'sb', sessionId: 'ses' }, d);
    expect(drains).toEqual([]);
  });

  test('a re-arm failure is reported, never thrown, and never blocks turn recovery', async () => {
    const { d, logs, requeued } = deps([{ token: 't', messageId: 'm', state: 'active' }], {
      reArmBlockedPrompts: async () => {
        throw new Error('db down');
      },
    });
    const result = await recoverTurnsAfterRuntimeRestart({ sandboxId: 'sb', sessionId: 'ses' }, d);
    expect(result.reArmed).toBe(0);
    expect(requeued).toHaveLength(1);
    expect(logs.some((l) => l.message.includes('re-arming runtime-blocked prompts failed'))).toBe(
      true,
    );
  });
});
