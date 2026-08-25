import { describe, expect, test } from 'bun:test';
import {
  type LostTurn,
  type RuntimeRestartRecoveryDeps,
  recoverTurnsAfterRuntimeRestart,
} from './runtime-restart-recovery';

function deps(lost: LostTurn[], overrides: Partial<RuntimeRestartRecoveryDeps> = {}) {
  const requeued: Array<Record<string, unknown>> = [];
  const logs: Array<{ message: string; meta: Record<string, unknown> }> = [];
  const d: RuntimeRestartRecoveryDeps = {
    settleLostTurns: async () => lost,
    requeue: async (input) => {
      requeued.push(input);
      return 'requeued';
    },
    log: (message, meta) => logs.push({ message, meta }),
    ...overrides,
  };
  return { d, requeued, logs };
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
