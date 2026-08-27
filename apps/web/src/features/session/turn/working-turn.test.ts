import { projectWorking } from '@kortix/sdk';
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

  test('a fresh send receipt outranks stale open metadata on the previous answer', () => {
    const r = resolveWorkingTurn({
      turns: [turn('old', 'open'), turn('new')],
      hintMessageId: 'new',
    });
    expect(r.workingTurnId).toBe('new');
    expect(r.pendingTurnIds).toEqual([]);
  });

  test('an idle send admitted by the inbox owns the indicator instead of becoming queued', () => {
    const working = projectWorking({
      optimistic: {
        messageId: 'new',
        turnId: 'new',
        atMs: 1_000,
        acceptedAtMs: 1_100,
      },
      inbox: { pending: 1, atMs: 1_100 },
      server: { turns: [], atMs: 1_200 },
      stream: { type: 'idle', atMs: 900 },
      nowMs: 1_300,
    });

    expect(
      resolveWorkingTurn({
        turns: [turn('old', 'done'), turn('new')],
        hintMessageId: working.turnId,
        unrunTurnIds: new Set(['new']),
      }),
    ).toEqual({ workingTurnId: 'new', pendingTurnIds: [] });
  });

  test('a send admitted during an active response stays queued behind that response', () => {
    const working = projectWorking({
      optimistic: {
        messageId: 'queued',
        turnId: 'active',
        atMs: 1_000,
        acceptedAtMs: 1_100,
      },
      inbox: { pending: 1, atMs: 1_100 },
      server: { turns: [], atMs: 1_200 },
      stream: { type: 'busy', atMs: 900 },
      nowMs: 1_300,
    });

    expect(
      resolveWorkingTurn({
        turns: [turn('active', 'open'), turn('queued')],
        hintMessageId: working.turnId,
        unrunTurnIds: new Set(['queued']),
      }),
    ).toEqual({ workingTurnId: 'active', pendingTurnIds: ['queued'] });
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
  test('a prompt the SERVER still holds is never the working turn — it is queued', () => {
    // MEASURED, local stack 2026-08-26 (session 65216cc6): two sends 700ms
    // apart, the first not streaming yet, so the working projection decides
    // from the INBOX and its `turnId` hint is null. Without the inbox fact the
    // fallback made the second prompt the working turn — full opacity, no
    // "Queued" label — while `GET .../prompts` listed it `waiting`.
    const r = resolveWorkingTurn({
      turns: [turn('old', 'done'), turn('p1'), turn('p2')],
      hintMessageId: null,
      unrunTurnIds: new Set(['p2']),
    });
    expect(r.workingTurnId).toBe('p1');
    expect(r.pendingTurnIds).toEqual(['p2']);
  });

  test('EVERY pending turn held by the server: the indicator falls back, all read queued', () => {
    const r = resolveWorkingTurn({
      turns: [turn('old', 'done'), turn('p1'), turn('p2')],
      hintMessageId: null,
      unrunTurnIds: new Set(['p1', 'p2']),
    });
    expect(r.workingTurnId).toBe('old');
    expect(r.pendingTurnIds).toEqual(['p1', 'p2']);
  });

  test('the inbox never overrides a turn that is visibly streaming', () => {
    // Rule 1 outranks it: content on screen is the agent working there, even
    // if a stale inbox read still lists the row.
    const r = resolveWorkingTurn({
      turns: [turn('old', 'done'), turn('p1', 'open')],
      hintMessageId: null,
      unrunTurnIds: new Set(['p1']),
    });
    expect(r.workingTurnId).toBe('p1');
    expect(r.pendingTurnIds).toEqual([]);
  });

  test('the hint outranks the inbox — the server named the turn it opened', () => {
    const r = resolveWorkingTurn({
      turns: [turn('old', 'done'), turn('p1'), turn('p2')],
      hintMessageId: 'p2',
      unrunTurnIds: new Set(['p2']),
    });
    expect(r.workingTurnId).toBe('p2');
    expect(r.pendingTurnIds).toEqual([]);
  });
});

describe('resolveWorkingTurn — a transcript with no assistant content at all', () => {
  const turn = (id: string) => ({
    userMessage: { info: { id } },
    assistantMessages: [] as ReadonlyArray<{ info: { time?: { completed?: number } } }>,
  });

  test('no turn is working when the server is holding every prompt', () => {
    // `newestWithContent` is -1 here, so rule 4 has nothing to fall back to.
    // It used to index `turns[-1]` and throw, which the error boundary turned
    // into "Something went wrong" over the entire session view.
    const turns = [turn('u1'), turn('u2'), turn('u3')];
    const unrunTurnIds = new Set(['u1', 'u2', 'u3']);
    expect(resolveWorkingTurn({ turns, hintMessageId: null, unrunTurnIds })).toEqual({
      workingTurnId: null,
      pendingTurnIds: ['u1', 'u2', 'u3'],
    });
  });

  test('the newest unheld prompt is still the working turn', () => {
    const turns = [turn('u1'), turn('u2')];
    expect(
      resolveWorkingTurn({ turns, hintMessageId: null, unrunTurnIds: new Set(['u2']) }),
    ).toEqual({ workingTurnId: 'u1', pendingTurnIds: ['u2'] });
  });
});
