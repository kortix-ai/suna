import { projectWorking } from '../../session/working';
import { describe, expect, test } from 'bun:test';
import {
  freshSendHint,
  fallbackBusyRowAfterTurnId,
  resolveWorkingTurn,
  shouldSuppressWorkingTurnBusy,
  turnIsConfirmedActive,
  workingTurnDrawsBusyRow,
} from './working-turn';

test('a finished answer yields its row to a prompt being delivered below it', () => {
  expect(shouldSuppressWorkingTurnBusy({
    hasPendingTurns: true,
    newestAssistantCompleted: true,
    workingTurnId: 'answered',
    activeTurnId: null,
    pendingDelivery: false,
    deliveringBelow: true,
  })).toBe(true);
});

test('a confirmed active turn keeps its working row through completed intermediate steps', () => {
  expect(shouldSuppressWorkingTurnBusy({
    hasPendingTurns: true,
    newestAssistantCompleted: true,
    workingTurnId: 'running',
    activeTurnId: 'running',
    pendingDelivery: false,
  })).toBe(false);
  // A null active id is missing evidence, not another turn. Suppressing on it
  // moved Thinking below the Quick Queue bubbles for a frame (2026-09-17).
  expect(shouldSuppressWorkingTurnBusy({
    hasPendingTurns: true,
    newestAssistantCompleted: true,
    workingTurnId: 'running',
    activeTurnId: null,
    pendingDelivery: false,
  })).toBe(false);
  expect(shouldSuppressWorkingTurnBusy({
    hasPendingTurns: true,
    newestAssistantCompleted: true,
    workingTurnId: 'running',
    activeTurnId: 'queued-next',
    pendingDelivery: false,
  })).toBe(true);
  expect(shouldSuppressWorkingTurnBusy({
    hasPendingTurns: true,
    newestAssistantCompleted: true,
    workingTurnId: 'running',
    activeTurnId: 'running',
    pendingDelivery: true,
  })).toBe(true);
});

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

  test("an idle send stays the working turn when its OWN echo stamps activity — no queued flash", () => {
    // The runtime echoes the user's prompt as `message.part.updated` before the
    // assistant message exists. That frame stamps activity, and the activity
    // branch of `projectWorking` names no turn — while the optimistic inbox row
    // still reads `queued`. The fallback then made the just-sent turn PENDING
    // for that window: the bubble dimmed, the scroll anchor fell back to the
    // previous answer (the room collapsed, the viewport clamped down) and then
    // re-anchored when the answer opened — the reported double jump on send.
    const working = projectWorking({
      optimistic: { messageId: 'new', turnId: 'new', atMs: 1_000, acceptedAtMs: null },
      inbox: { pending: 1, atMs: 1_050 },
      server: { turns: [], atMs: 900 },
      stream: { type: 'idle', atMs: 900 },
      activity: { atMs: 1_100 },
      nowMs: 1_150,
    });
    expect(working.turnId).toBeNull();

    const turns = [turn('old', 'done'), turn('new')];
    const unrunTurnIds = new Set(['new']);
    expect(resolveWorkingTurn({ turns, hintMessageId: working.turnId, unrunTurnIds })).toEqual({
      workingTurnId: 'old',
      pendingTurnIds: ['new'],
    });
    expect(
      resolveWorkingTurn({
        turns,
        hintMessageId: working.turnId ?? freshSendHint(turns, (id) => id === 'new'),
        unrunTurnIds,
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

describe('freshSendHint — the idle send this tab just made', () => {
  test('names the sent turn while it has no answer yet', () => {
    expect(freshSendHint([turn('old', 'done'), turn('new')], (id) => id === 'new')).toBe('new');
  });

  test('answers with the CURRENT id when the echo re-minted it', () => {
    // The predicate is the alias check (`optimisticOriginOf`); the hint must be
    // the id `resolveWorkingTurn` can find in `turns`.
    expect(freshSendHint([turn('old', 'done'), turn('echo')], (id) => id === 'echo')).toBe('echo');
  });

  test('retires itself once the turn has an answer — the transcript decides from there', () => {
    expect(freshSendHint([turn('old', 'done'), turn('new', 'open')], (id) => id === 'new')).toBeNull();
  });

  test('nothing for a send whose bubble is gone (failed, rewound, other session)', () => {
    expect(freshSendHint([turn('old', 'done')], (id) => id === 'new')).toBeNull();
    expect(freshSendHint([], () => true)).toBeNull();
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

describe('the fallback Thinking row stays above the queue', () => {
  const queued = new Set(['queued-a', 'queued-b']);

  test('it follows the last turn before the first queued bubble', () => {
    expect(fallbackBusyRowAfterTurnId({
      turns: [turn('done', 'done'), turn('running', 'done'), turn('queued-a'), turn('queued-b')],
      pendingTurnIds: new Set(),
      pendingPromptIds: queued,
      deliveringPromptIds: new Set(),
    })).toBe('running');
    expect(fallbackBusyRowAfterTurnId({
      turns: [turn('running'), turn('later')],
      pendingTurnIds: new Set(['later']),
      pendingPromptIds: new Set(),
      deliveringPromptIds: new Set(),
    })).toBe('running');
  });

  test('a prompt being delivered owns the row, directly under its bubble', () => {
    // 2026-09-17, local: the previous answer had finished and the next Quick
    // Queue prompt was mid-delivery (9 attachments). Thinking sat under the
    // finished answer, above the prompt the agent was about to run.
    expect(fallbackBusyRowAfterTurnId({
      turns: [turn('answered', 'done'), turn('queued-a'), turn('queued-b')],
      pendingTurnIds: new Set(),
      pendingPromptIds: queued,
      deliveringPromptIds: new Set(['queued-a']),
    })).toBe('queued-a');
  });

  test('with no queue, or a queue that starts the transcript, it stays at the end', () => {
    expect(fallbackBusyRowAfterTurnId({
      turns: [turn('done', 'done'), turn('running')],
      pendingTurnIds: new Set(),
      pendingPromptIds: new Set(),
      deliveringPromptIds: new Set(),
    })).toBeNull();
    expect(fallbackBusyRowAfterTurnId({
      turns: [turn('queued-a'), turn('queued-b')],
      pendingTurnIds: new Set(),
      pendingPromptIds: queued,
      deliveringPromptIds: new Set(),
    })).toBeNull();
  });
});

describe('a busy session always draws exactly one Thinking row', () => {
  test('an aborted reply finishes its turn, so the running prompt below is the working turn', () => {
    // 2026-09-17, local: a Quick Queue interrupt aborted the previous answer.
    // The live stream stalled, so the page had the aborted reply without its
    // completion stamp and no reply to the running prompt yet. The working
    // turn landed on the aborted answer, which never draws Thinking.
    const aborted = {
      userMessage: { info: { id: 'answered' } },
      assistantMessages: [
        { info: { time: { completed: 1 } } },
        { info: { time: {}, error: { name: 'MessageAbortedError' } } },
      ],
    };
    expect(resolveWorkingTurn({
      turns: [aborted, turn('running')],
      hintMessageId: null,
    })).toEqual({ workingTurnId: 'running', pendingTurnIds: [] });
  });

  test('a working turn that cannot draw its row hands it to the fallback', () => {
    const base = { lastTurnWorking: true, workingTurnId: 'turn', suppressed: false, isRetrying: false };
    expect(workingTurnDrawsBusyRow({ ...base, workingTurnHasError: false })).toBe(true);
    expect(workingTurnDrawsBusyRow({ ...base, workingTurnHasError: true })).toBe(false);
    expect(workingTurnDrawsBusyRow({ ...base, workingTurnHasError: true, isRetrying: true })).toBe(true);
    expect(workingTurnDrawsBusyRow({ ...base, workingTurnHasError: false, suppressed: true })).toBe(false);
    expect(workingTurnDrawsBusyRow({ ...base, workingTurnHasError: false, workingTurnId: null })).toBe(false);
    expect(workingTurnDrawsBusyRow({ ...base, workingTurnHasError: false, lastTurnWorking: false })).toBe(false);
  });

  test('a turn parked on a question draws no row, even during a retry', () => {
    // 2026-09-22, local (session 8d807956): the agent asked a 2-option
    // question; the row stayed `active` for 12m22s and the transcript shimmered
    // "Working on it" above the card asking the reader to act.
    const base = { lastTurnWorking: true, workingTurnId: 'turn', suppressed: false, workingTurnHasError: false };
    expect(workingTurnDrawsBusyRow({ ...base, isRetrying: false, awaitingUser: true })).toBe(false);
    expect(workingTurnDrawsBusyRow({ ...base, isRetrying: true, awaitingUser: true })).toBe(false);
    expect(workingTurnDrawsBusyRow({ ...base, isRetrying: false, awaitingUser: false })).toBe(true);
  });
});

describe('only a confirmed active turn drops its pending presentation', () => {
  test('a fresh send still waiting for acceptance keeps its pending bubble while it draws Thinking', () => {
    // CI, journey 27: the first Enter became the working turn through the
    // fresh-send hint and lost `data-pending-prompt-id` and its queue tint
    // while the inbox still held it.
    expect(turnIsConfirmedActive({
      isTurnWorking: true,
      turnId: 'sent',
      activeTurnId: 'receipt',
      pendingDelivery: true,
    })).toBe(false);
  });

  test('the server naming the running turn clears it', () => {
    expect(turnIsConfirmedActive({
      isTurnWorking: true,
      turnId: 'sent',
      activeTurnId: 'sent',
      pendingDelivery: false,
    })).toBe(true);
    expect(turnIsConfirmedActive({
      isTurnWorking: false,
      turnId: 'sent',
      activeTurnId: 'sent',
      pendingDelivery: false,
    })).toBe(false);
  });
});
