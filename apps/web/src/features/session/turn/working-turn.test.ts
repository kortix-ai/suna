import { describe, expect, test } from 'bun:test';
import { resolveWorkingTurn } from './working-turn';

const turn = (id: string, ...assistant: Array<'open' | 'done'>) => ({
  userMessage: { info: { id } },
  assistantMessages: assistant.map((s) => ({
    info: { time: s === 'done' ? { completed: 1 } : {} },
  })),
});

describe('resolveWorkingTurn', () => {
  test('empty transcript → nothing', () => {
    expect(resolveWorkingTurn({ turns: [], hintMessageId: null })).toEqual({
      workingTurnId: null,
      pendingTurnIds: [],
    });
  });

  test('the newest turn with an OPEN assistant message is working; later turns are pending', () => {
    // "UX" streams; "changed" was queued mid-turn and persisted by OpenCode.
    const r = resolveWorkingTurn({
      turns: [turn('a', 'done'), turn('ux', 'done', 'open'), turn('changed')],
      hintMessageId: null,
    });
    expect(r.workingTurnId).toBe('ux');
    expect(r.pendingTurnIds).toEqual(['changed']);
  });

  test('a husk (older open assistant) does not steal the indicator from the live turn', () => {
    const r = resolveWorkingTurn({
      turns: [turn('dead', 'open'), turn('b', 'done'), turn('c', 'open')],
      hintMessageId: null,
    });
    expect(r.workingTurnId).toBe('c');
  });

  test('between steps: the server hint keeps the indicator on the previous turn', () => {
    const r = resolveWorkingTurn({
      turns: [turn('ux', 'done'), turn('changed'), turn('more')],
      hintMessageId: 'ux',
    });
    expect(r.workingTurnId).toBe('ux');
    expect(r.pendingTurnIds).toEqual(['changed', 'more']);
  });

  test('a fresh idle send: the receipt names the new turn', () => {
    const r = resolveWorkingTurn({
      turns: [turn('old', 'done'), turn('new')],
      hintMessageId: 'new',
    });
    expect(r.workingTurnId).toBe('new');
    expect(r.pendingTurnIds).toEqual([]);
  });

  test('no hint: the NEWEST pending turn is where the next step lands', () => {
    // OpenCode parents the next step to the latest user message and answers
    // p1 and p2 together in it — p1 is taken, not pending.
    const r = resolveWorkingTurn({
      turns: [turn('old', 'done'), turn('p1'), turn('p2')],
      hintMessageId: null,
    });
    expect(r.workingTurnId).toBe('p2');
    expect(r.pendingTurnIds).toEqual([]);
  });

  test('first turn ever, no assistant content yet', () => {
    const r = resolveWorkingTurn({ turns: [turn('first')], hintMessageId: null });
    expect(r.workingTurnId).toBe('first');
    expect(r.pendingTurnIds).toEqual([]);
  });

  test('all settled, nothing pending: the last turn', () => {
    const r = resolveWorkingTurn({
      turns: [turn('a', 'done'), turn('b', 'done')],
      hintMessageId: null,
    });
    expect(r.workingTurnId).toBe('b');
    expect(r.pendingTurnIds).toEqual([]);
  });
});
