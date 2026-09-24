import { projectWorking } from '../../session/working';
import { describe, expect, test } from 'bun:test';
import {
  busyRowTurnPresentation,
  freshSendHint,
  fallbackBusyRowAfterTurnId,
  resolveBusyRow,
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

describe('a finished answer with no queued bubble below it', () => {
  const base = {
    hasPendingTurns: false,
    newestAssistantCompleted: true,
    newestAssistantContinuesTurn: false,
    workingTurnId: 'answered',
    pendingDelivery: false,
    sessionWorking: true,
  };

  test('yields its row when the session works and names no turn: the next turn has no bubble yet', () => {
    expect(shouldSuppressWorkingTurnBusy({ ...base, activeTurnId: null })).toBe(true);
    expect(shouldSuppressWorkingTurnBusy({ ...base, activeTurnId: 'next' })).toBe(true);
    expect(shouldSuppressWorkingTurnBusy({ ...base, activeTurnId: 'answered', pendingDelivery: true })).toBe(true);
  });

  test('guard: keeps its row while the projection names it', () => {
    expect(shouldSuppressWorkingTurnBusy({ ...base, activeTurnId: 'answered' })).toBe(false);
  });

  test('guard: keeps its row through the idle fade, so the row never moves as it leaves', () => {
    expect(shouldSuppressWorkingTurnBusy({ ...base, activeTurnId: null, sessionWorking: false })).toBe(false);
    expect(shouldSuppressWorkingTurnBusy({ ...base, activeTurnId: null, sessionWorking: undefined })).toBe(false);
  });

  test('guard: a step that finished with tool calls keeps its row, whatever the projection names', () => {
    // A trigger or `/` command turn has no message id, so the projection never
    // names it. Between two of its steps the newest message is complete.
    expect(
      shouldSuppressWorkingTurnBusy({
        ...base,
        newestAssistantContinuesTurn: true,
        activeTurnId: null,
      }),
    ).toBe(false);
    expect(
      shouldSuppressWorkingTurnBusy({
        ...base,
        newestAssistantContinuesTurn: true,
        pendingDelivery: true,
        activeTurnId: null,
      }),
    ).toBe(false);
  });

  test('an ABSENT finish reason yields the row: the rule stands on positive evidence only', () => {
    // `AssistantMessage.finish` is optional on the wire and nothing else in
    // this app reads it. Requiring a reason to release the row made the whole
    // rule a no-op on a runtime that reports none: the answered turn kept the
    // row until the next echo, which is the placement this rule exists to fix.
    // Only `tool-calls` / `unknown` — the two reasons OpenCode continues on —
    // hold the row.
    expect(
      shouldSuppressWorkingTurnBusy({
        ...base,
        newestAssistantContinuesTurn: undefined,
        activeTurnId: null,
      }),
    ).toBe(true);
    expect(
      shouldSuppressWorkingTurnBusy({
        ...base,
        newestAssistantContinuesTurn: undefined,
        activeTurnId: 'answered',
        pendingDelivery: true,
      }),
    ).toBe(true);
  });

  test('guard: an open answer always keeps its row', () => {
    expect(
      shouldSuppressWorkingTurnBusy({ ...base, newestAssistantCompleted: false, activeTurnId: null }),
    ).toBe(false);
  });
});

/** `open` streams; `done` finished with `stop`; `step` finished with
 *  `tool-calls`, so another step is coming; `closed` completed with NO finish
 *  reason — `AssistantMessage.finish` is optional on the wire. */
const turn = (id: string, ...assistant: Array<'open' | 'done' | 'step' | 'closed'>) => ({
  userMessage: { info: { id } },
  assistantMessages: assistant.map((s) => ({
    info:
      s === 'open'
        ? { time: {} }
        : s === 'closed'
          ? { time: { completed: 1 } }
          : { time: { completed: 1 }, finish: s === 'done' ? 'stop' : 'tool-calls' },
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

/**
 * The busy row from the send frame to the answer, fed by the SDK's real
 * `projectWorking`. Every step is one observation the tab can make, in the
 * order the runtime and the control plane produce them.
 */
describe('resolveBusyRow — the busy row draws on the turn that is starting', () => {
  type Inputs = Parameters<typeof projectWorking>[0];
  type Row = {
    prompt_id: string;
    state: string;
    message_id: string;
    wire_message_id: string;
    /** Why admission waits, as `GET .../prompts` reports it. */
    reason?: string | null;
  };
  type Turn = ReturnType<typeof turn>;
  interface Step {
    name: string;
    turns: Turn[];
    prompts: Row[];
    inputs: Inputs;
    /** The id `handleSend` recorded for an idle send, when there was one. */
    freshSendId?: string;
    /** The delay-hidden busy value; defaults to the projection's state. */
    lastTurnWorking?: boolean;
  }

  const T = 1_789_000_000_000;
  const iso = (ms: number) => new Date(ms).toISOString();
  const ledger = (id: string, startedAtMs: number) => ({
    turn_token: `t_${id}`,
    state: 'active' as const,
    message_id: id,
    opencode_session_id: 'oc',
    started_at: iso(startedAtMs),
    accepted_at: iso(startedAtMs),
  });
  const waiting = (id: string, reason = 'turn_active'): Row => ({
    prompt_id: `p_${id}`,
    state: 'waiting',
    message_id: id,
    wire_message_id: id,
    reason,
  });

  /** Where the page draws the row: in a turn card, in the fallback slot under
   *  a turn, at the transcript's end, or nowhere. */
  function place(step: Step) {
    const projection = projectWorking(step.inputs);
    const freshSendTurnId = step.freshSendId
      ? freshSendHint(step.turns, (id) => id === step.freshSendId)
      : null;
    const row = resolveBusyRow({
      turns: step.turns,
      prompts: step.prompts,
      projection,
      freshSendTurnId,
      lastTurnWorking: step.lastTurnWorking ?? projection.state === 'working',
      isRetrying: false,
      turnHasError: () => false,
      firstPromptStandIn: false,
    });
    const at = row.someTurnDrawsBusyRow
      ? `turn:${row.workingTurnId}`
      : row.showFallbackBusyRow
        ? row.fallbackBusyRowTurnId === null
          ? 'end'
          : `under:${row.fallbackBusyRowTurnId}`
        : 'none';
    const pending = step.turns
      .filter((t) => busyRowTurnPresentation(row, t).pending)
      .map((t) => t.userMessage.info.id);
    return { state: projection.state, at, pending };
  }

  function run(steps: Step[]) {
    return steps.map((step) => ({ step: step.name, ...place(step) }));
  }

  test('a direct send draws the row on its own bubble at every step', () => {
    // Turn A ended 4 s ago. Its idle frame triggered a /turn read that landed
    // before the relay closed A's ledger row, so the cached read still lists A.
    const ended: Inputs = {
      optimistic: null,
      inbox: { pending: 0, atMs: T + 1_010 },
      server: { turns: [ledger('A', T - 60_000)], atMs: T + 1_010, source: 'read' },
      stream: { type: 'idle', origin: 'wire', atMs: T + 1_000 },
      activity: { atMs: T + 900 },
      runtimeBusySinceAtMs: T - 60_000,
      nowMs: T + 1_050,
    };
    const sent = [turn('A', 'done'), turn('W')];
    const receipt = { messageId: 'W', turnId: 'W', atMs: T + 5_000, acceptedAtMs: null };
    const enter: Step = {
      name: 'Enter',
      turns: sent,
      prompts: [{ ...waiting('W'), state: 'queued' }],
      freshSendId: 'W',
      inputs: { ...ended, optimistic: receipt, inbox: { pending: 1, atMs: T + 5_000 }, nowMs: T + 5_001 },
    };
    // Sent inside the relay window: the admission gate still sees A and lists
    // the row `waiting (turn_active)`.
    const accepted: Step = {
      ...enter,
      name: 'POST accepted',
      prompts: [waiting('W')],
      inputs: {
        ...enter.inputs,
        optimistic: { ...receipt, acceptedAtMs: T + 5_200 },
        inbox: { pending: 1, atMs: T + 5_200 },
        nowMs: T + 5_201,
      },
    };
    const drained: Step = {
      ...accepted,
      name: 'drain',
      prompts: [],
      inputs: {
        ...accepted.inputs,
        inbox: { pending: 0, atMs: T + 6_000, drainedAtMs: T + 6_000 },
        nowMs: T + 6_001,
      },
    };
    const busy: Step = {
      ...drained,
      name: 'busy frame',
      inputs: {
        ...drained.inputs,
        stream: { type: 'busy', origin: 'wire', atMs: T + 6_100 },
        runtimeBusySinceAtMs: T + 6_100,
        nowMs: T + 6_101,
      },
    };
    const echo: Step = {
      ...busy,
      name: 'echo, /turn still [A]',
      inputs: { ...busy.inputs, activity: { atMs: T + 6_200 }, nowMs: T + 6_201 },
    };
    const read: Step = {
      ...echo,
      name: '/turn [W]',
      inputs: {
        ...echo.inputs,
        server: { turns: [ledger('W', T + 6_050)], atMs: T + 6_150, source: 'read' },
        nowMs: T + 6_301,
      },
    };
    const open: Step = {
      ...read,
      name: 'assistant open',
      turns: [turn('A', 'done'), turn('W', 'open')],
      inputs: { ...read.inputs, activity: { atMs: T + 6_400 }, nowMs: T + 6_401 },
    };

    expect(run([enter, accepted, drained, busy, echo, read, open]).map(({ step, state, at }) => ({ step, state, at }))).toEqual([
      { step: 'Enter', state: 'working', at: 'turn:W' },
      { step: 'POST accepted', state: 'working', at: 'turn:W' },
      { step: 'drain', state: 'working', at: 'turn:W' },
      { step: 'busy frame', state: 'working', at: 'turn:W' },
      { step: 'echo, /turn still [A]', state: 'working', at: 'turn:W' },
      { step: '/turn [W]', state: 'working', at: 'turn:W' },
      { step: 'assistant open', state: 'working', at: 'turn:W' },
    ]);
  });

  /** A prompt queued in the list above the composer while `running` answers.
   *  It has no transcript bubble until the runtime echoes it as `echoId`. */
  function composerQueuedTurn(input: {
    before: Turn[];
    running: string;
    runningStartedAtMs: number;
    queued: string;
    echoId: string;
    /** Rows still listed after this prompt leaves the inbox. */
    behind: Row[];
    receipt: NonNullable<Inputs['optimistic']>;
    /** The instant the running turn's idle frame reaches the tab. */
    idleAtMs: number;
    busySinceAtMs: number;
    /** How the running turn's answer closed. `closed` reports no finish
     *  reason, which the wire type allows. */
    runningEnd?: 'done' | 'closed';
  }): Step[] {
    const { idleAtMs: I } = input;
    const answered = [...input.before, turn(input.running, input.runningEnd ?? 'done')];
    const rows = [waiting(input.queued), ...input.behind];
    const idle: Step = {
      name: `${input.running} idle`,
      turns: answered,
      prompts: rows,
      inputs: {
        optimistic: input.receipt,
        inbox: { pending: rows.length, atMs: I + 10 },
        server: {
          turns: [ledger(input.running, input.runningStartedAtMs)],
          atMs: I + 10,
          source: 'read',
        },
        stream: { type: 'idle', origin: 'wire', atMs: I },
        activity: { atMs: I - 100 },
        runtimeBusySinceAtMs: input.busySinceAtMs,
        nowMs: I + 50,
      },
    };
    const promoted: Step = {
      ...idle,
      name: `${input.queued} promoted`,
      prompts: input.behind,
      inputs: {
        ...idle.inputs,
        inbox:
          input.behind.length > 0
            ? { pending: input.behind.length, atMs: I + 2_010 }
            : { pending: 0, atMs: I + 2_010, drainedAtMs: I + 2_010 },
        nowMs: I + 2_050,
      },
    };
    const busy: Step = {
      ...promoted,
      name: `${input.queued} busy frame`,
      inputs: {
        ...promoted.inputs,
        stream: { type: 'busy', origin: 'wire', atMs: I + 2_100 },
        runtimeBusySinceAtMs: I + 2_100,
        nowMs: I + 2_120,
      },
    };
    const echo: Step = {
      ...busy,
      name: `echo ${input.echoId}`,
      turns: [...answered, turn(input.echoId)],
      inputs: { ...busy.inputs, activity: { atMs: I + 2_200 }, nowMs: I + 2_210 },
    };
    const read: Step = {
      ...echo,
      name: `/turn [${input.echoId}]`,
      inputs: {
        ...echo.inputs,
        server: { turns: [ledger(input.echoId, I + 2_080)], atMs: I + 2_150, source: 'read' },
        nowMs: I + 2_300,
      },
    };
    const open: Step = {
      ...read,
      name: `${input.echoId} assistant open`,
      turns: [...answered, turn(input.echoId, 'open')],
      inputs: { ...read.inputs, activity: { atMs: I + 2_400 }, nowMs: I + 2_410 },
    };
    return [idle, promoted, busy, echo, read, open];
  }

  test('a prompt queued above the composer: the end-of-list row until its echo, then its own turn', () => {
    const steps = composerQueuedTurn({
      before: [],
      running: 'A',
      runningStartedAtMs: T - 60_000,
      queued: 'W_B',
      echoId: 'R_B',
      behind: [],
      receipt: { messageId: 'W_B', turnId: 'A', atMs: T - 20_000, acceptedAtMs: T - 19_800 },
      idleAtMs: T + 1_000,
      busySinceAtMs: T - 60_000,
    });
    expect(run(steps)).toEqual([
      { step: 'A idle', state: 'working', at: 'end', pending: [] },
      { step: 'W_B promoted', state: 'working', at: 'end', pending: [] },
      { step: 'W_B busy frame', state: 'working', at: 'end', pending: [] },
      { step: 'echo R_B', state: 'working', at: 'turn:R_B', pending: [] },
      { step: '/turn [R_B]', state: 'working', at: 'turn:R_B', pending: [] },
      { step: 'R_B assistant open', state: 'working', at: 'turn:R_B', pending: [] },
    ]);
  });

  test('the queued prompt still leaves A when A reported no finish reason', () => {
    // Same steps as above with ONE difference: A's answer completed without a
    // finish reason. `AssistantMessage.finish` is optional on the wire, so a
    // rule that needs one to release the row is a rule that never fires.
    const steps = composerQueuedTurn({
      before: [],
      running: 'A',
      runningEnd: 'closed',
      runningStartedAtMs: T - 60_000,
      queued: 'W_B',
      echoId: 'R_B',
      behind: [],
      receipt: { messageId: 'W_B', turnId: 'A', atMs: T - 20_000, acceptedAtMs: T - 19_800 },
      idleAtMs: T + 1_000,
      busySinceAtMs: T - 60_000,
    });
    expect(run(steps).map(({ step, at }) => ({ step, at }))).toEqual([
      { step: 'A idle', at: 'end' },
      { step: 'W_B promoted', at: 'end' },
      { step: 'W_B busy frame', at: 'end' },
      { step: 'echo R_B', at: 'turn:R_B' },
      { step: '/turn [R_B]', at: 'turn:R_B' },
      { step: 'R_B assistant open', at: 'turn:R_B' },
    ]);
  });

  test('two prompts queued above the composer drain back to back, each on its own row', () => {
    const receipt = { messageId: 'W_C', turnId: 'A', atMs: T - 10_000, acceptedAtMs: T - 9_800 };
    const first = composerQueuedTurn({
      before: [],
      running: 'A',
      runningStartedAtMs: T - 60_000,
      queued: 'W_B',
      echoId: 'R_B',
      behind: [waiting('W_C', 'older_prompt_pending')],
      receipt,
      idleAtMs: T + 1_000,
      busySinceAtMs: T - 60_000,
    });
    const second = composerQueuedTurn({
      before: [turn('A', 'done')],
      running: 'R_B',
      runningStartedAtMs: T + 3_080,
      queued: 'W_C',
      echoId: 'R_C',
      behind: [],
      receipt,
      idleAtMs: T + 10_000,
      busySinceAtMs: T + 3_100,
    });
    expect(run([...first, ...second]).map(({ step, state, at }) => ({ step, state, at }))).toEqual([
      { step: 'A idle', state: 'working', at: 'end' },
      { step: 'W_B promoted', state: 'working', at: 'end' },
      { step: 'W_B busy frame', state: 'working', at: 'end' },
      { step: 'echo R_B', state: 'working', at: 'turn:R_B' },
      { step: '/turn [R_B]', state: 'working', at: 'turn:R_B' },
      { step: 'R_B assistant open', state: 'working', at: 'turn:R_B' },
      { step: 'R_B idle', state: 'working', at: 'end' },
      { step: 'W_C promoted', state: 'working', at: 'end' },
      { step: 'W_C busy frame', state: 'working', at: 'end' },
      { step: 'echo R_C', state: 'working', at: 'turn:R_C' },
      { step: '/turn [R_C]', state: 'working', at: 'turn:R_C' },
      { step: 'R_C assistant open', state: 'working', at: 'turn:R_C' },
    ]);
  });

  test('the projection names the turn first; the fresh-send hint decides only where it names none', () => {
    const turns = [turn('old', 'open'), turn('new')];
    const at = (turnId: string | null, freshSendTurnId: string | null) =>
      resolveBusyRow({
        turns,
        prompts: [],
        projection: { state: 'working', turnId },
        freshSendTurnId,
        lastTurnWorking: true,
        isRetrying: false,
        turnHasError: () => false,
        firstPromptStandIn: false,
      }).workingTurnId;
    expect(at('old', 'new')).toBe('old');
    expect(at(null, 'new')).toBe('new');
    expect(at(null, null)).toBe('old');
  });

  test('a claimed first prompt keeps its queued dimming while the server holds it', () => {
    // The claim hides the duplicate bubble; the surviving copy is on screen
    // under the claim's id, which no inbox row carries.
    const turns = [turn('first-bubble')];
    const input = {
      turns,
      prompts: [{ prompt_id: 'p1', state: 'queued', message_id: 'row-id', wire_message_id: 'row-id' }],
      projection: { state: 'working' as const, turnId: null, pendingDelivery: true as const },
      freshSendTurnId: null,
      lastTurnWorking: true,
      isRetrying: false,
      turnHasError: () => false,
      firstPromptStandIn: false,
    };
    expect(resolveBusyRow(input).workingTurnId).toBe('first-bubble');
    const claimed = resolveBusyRow({ ...input, claimedFirstTurnId: 'first-bubble' });
    expect(claimed.workingTurnId).toBeNull();
    expect([...claimed.pendingTurnIds]).toEqual(['first-bubble']);
  });

  test('guard: a turn the projection cannot name keeps its row between two steps', () => {
    // A trigger's turn: the ledger row carries no message id.
    const between: Step = {
      name: 'between steps',
      turns: [turn('A', 'done'), turn('X', 'step')],
      prompts: [],
      inputs: {
        optimistic: null,
        inbox: { pending: 0, atMs: T + 20_000 },
        server: {
          turns: [{ ...ledger('X', T + 10_000), message_id: null }],
          atMs: T + 12_000,
          source: 'read',
        },
        stream: { type: 'busy', origin: 'wire', atMs: T + 10_000 },
        activity: { atMs: T + 19_900 },
        runtimeBusySinceAtMs: T + 10_000,
        nowMs: T + 20_000,
      },
    };
    expect(run([between])).toEqual([
      { step: 'between steps', state: 'working', at: 'turn:X', pending: [] },
    ]);
  });

  test('guard: a finished turn keeps its row through the idle fade', () => {
    const fade: Step = {
      name: 'idle fade',
      turns: [turn('A', 'done')],
      prompts: [],
      lastTurnWorking: true,
      inputs: {
        optimistic: null,
        inbox: { pending: 0, atMs: T + 1_010 },
        server: { turns: [], atMs: T + 1_010, source: 'read' },
        stream: { type: 'idle', origin: 'wire', atMs: T + 1_000 },
        activity: { atMs: T + 900 },
        runtimeBusySinceAtMs: T - 60_000,
        nowMs: T + 1_100,
      },
    };
    expect(run([fade])).toEqual([{ step: 'idle fade', state: 'idle', at: 'turn:A', pending: [] }]);
  });

  test('a prompt queued in the transcript draws the row on its bubble from promotion', () => {
    const answered = [turn('A', 'done'), turn('W_B')];
    const idle: Step = {
      name: 'A idle',
      turns: answered,
      prompts: [waiting('W_B')],
      inputs: {
        optimistic: { messageId: 'W_B', turnId: 'A', atMs: T - 20_000, acceptedAtMs: T - 19_800 },
        inbox: { pending: 1, atMs: T + 1_010 },
        server: { turns: [ledger('A', T - 60_000)], atMs: T + 1_010, source: 'read' },
        stream: { type: 'idle', origin: 'wire', atMs: T + 1_000 },
        activity: { atMs: T + 900 },
        runtimeBusySinceAtMs: T - 60_000,
        nowMs: T + 1_050,
      },
    };
    // The drain has re-minted the row's `message_id`; the bubble keeps its wire id.
    const delivering: Step = {
      ...idle,
      name: 'W_B delivering',
      prompts: [{ ...waiting('W_B'), state: 'delivering', message_id: 'R_B' }],
      inputs: { ...idle.inputs, inbox: { pending: 1, atMs: T + 2_010 }, nowMs: T + 2_050 },
    };
    const promoted: Step = {
      ...idle,
      name: 'W_B promoted',
      prompts: [],
      inputs: {
        ...idle.inputs,
        inbox: { pending: 0, atMs: T + 3_010, drainedAtMs: T + 3_010 },
        nowMs: T + 3_050,
      },
    };
    const busy: Step = {
      ...promoted,
      name: 'W_B busy frame',
      inputs: {
        ...promoted.inputs,
        stream: { type: 'busy', origin: 'wire', atMs: T + 3_100 },
        runtimeBusySinceAtMs: T + 3_100,
        nowMs: T + 3_120,
      },
    };
    const echo: Step = {
      ...busy,
      name: 'echo R_B',
      turns: [turn('A', 'done'), turn('R_B')],
      inputs: { ...busy.inputs, activity: { atMs: T + 3_200 }, nowMs: T + 3_210 },
    };
    const read: Step = {
      ...echo,
      name: '/turn [R_B]',
      inputs: {
        ...echo.inputs,
        server: { turns: [ledger('R_B', T + 3_080)], atMs: T + 3_150, source: 'read' },
        nowMs: T + 3_300,
      },
    };
    expect(run([idle, delivering, promoted, busy, echo, read])).toEqual([
      // Not promoted yet: the row stays above the queued bubble.
      { step: 'A idle', state: 'working', at: 'under:A', pending: ['W_B'] },
      // Delivering: W_B IS the work in progress, so its own turn draws the row
      // — the same place the fallback slot drew it, and still dimmed. (Hinting
      // the working turn to the delivering prompt is what keeps a GROUP's row
      // under its last row while the earlier rows echo.)
      { step: 'W_B delivering', state: 'working', at: 'turn:W_B', pending: ['W_B'] },
      { step: 'W_B promoted', state: 'working', at: 'turn:W_B', pending: [] },
      { step: 'W_B busy frame', state: 'working', at: 'turn:W_B', pending: [] },
      { step: 'echo R_B', state: 'working', at: 'turn:R_B', pending: [] },
      { step: '/turn [R_B]', state: 'working', at: 'turn:R_B', pending: [] },
    ]);
  });
});

describe('resolveBusyRow — waiting on the user is not the agent working', () => {
  // A turn parked on a question or a permission prompt is still OPEN, but the
  // agent is waiting on the reader: no busy row draws anywhere. Both halves
  // matter — the working turn declines its own row, and the fallback must not
  // catch the row it declined, or the shimmer only moves one position down.
  const openTurn = {
    userMessage: { info: { id: 'u1' } },
    assistantMessages: [{ info: { time: { created: 1 } } }],
  };
  const base: Parameters<typeof resolveBusyRow>[0] = {
    turns: [openTurn],
    prompts: [],
    projection: { state: 'working' as const, turnId: 'u1' },
    freshSendTurnId: null,
    lastTurnWorking: true,
    isRetrying: false,
    turnHasError: () => false,
    firstPromptStandIn: false,
  };

  test('a working turn draws its own row while the agent works', () => {
    const row = resolveBusyRow(base);
    expect(row.someTurnDrawsBusyRow).toBe(true);
    expect(row.showFallbackBusyRow).toBe(false);
  });

  test('parked on the user: the turn declines its row and the fallback does not catch it', () => {
    const row = resolveBusyRow({ ...base, awaitingUser: true });
    expect(row.someTurnDrawsBusyRow).toBe(false);
    expect(row.showFallbackBusyRow).toBe(false);
  });

  test('parked on the user with no working turn: still no fallback row', () => {
    const row = resolveBusyRow({ ...base, turns: [], awaitingUser: true });
    expect(row.someTurnDrawsBusyRow).toBe(false);
    expect(row.showFallbackBusyRow).toBe(false);
    // Guard: the same state without the question does draw the fallback.
    expect(resolveBusyRow({ ...base, turns: [] }).showFallbackBusyRow).toBe(true);
  });
});

describe('fallbackBusyRowAfterTurnId — a whole group delivering', () => {
  // A Queue List group is published `delivering` at once. Its one reply is
  // parented on the LAST message of the group, so the waiting row sits under
  // that one — never between the group's bubbles (reported 2026-09-24).
  const bare = (id: string) => ({ userMessage: { info: { id } }, assistantMessages: [] });
  const done = (id: string) => ({
    userMessage: { info: { id } },
    assistantMessages: [{ info: { time: { created: 1, completed: 2 } } }],
  });

  test('several delivering prompts: the row goes under the LAST of them', () => {
    const turns = [done('prev'), bare('g1'), bare('g2'), bare('g3')];
    expect(
      fallbackBusyRowAfterTurnId({
        turns,
        pendingTurnIds: new Set(['g1', 'g2', 'g3']),
        pendingPromptIds: new Set(['g1', 'g2', 'g3']),
        deliveringPromptIds: new Set(['g1', 'g2', 'g3']),
      }),
    ).toBe('g3');
  });

  test('guard: one delivering prompt still draws the row under its own bubble', () => {
    const turns = [done('prev'), bare('d1'), bare('q2')];
    expect(
      fallbackBusyRowAfterTurnId({
        turns,
        pendingTurnIds: new Set(['d1', 'q2']),
        pendingPromptIds: new Set(['d1', 'q2']),
        deliveringPromptIds: new Set(['d1']),
      }),
    ).toBe('d1');
  });
});

describe('resolveBusyRow — a group whose rows echo one by one', () => {
  // Measured 2026-09-24 (real Firefox): four Queue List rows appeared together,
  // then each echo (≈2 s apart) moved "Thinking" under ONE, TWO, THREE, FOUR.
  // An echoed row leaves the inbox; the transcript-only fallback then picked it
  // as the newest unanswered turn. The group's reply lands under its LAST row.
  const bare = (id: string) => ({ userMessage: { info: { id } }, assistantMessages: [] });
  const done = (id: string) => ({
    userMessage: { info: { id } },
    assistantMessages: [{ info: { time: { created: 1, completed: 2 } } }],
  });
  const delivering = (id: string) => ({
    prompt_id: `p_${id}`,
    state: 'delivering',
    message_id: id,
    wire_message_id: id,
  });
  const base: Parameters<typeof resolveBusyRow>[0] = {
    turns: [done('prev'), bare('g1'), bare('g2'), bare('g3'), bare('g4')],
    // g1 has echoed and left the inbox; g2..g4 are still being delivered.
    prompts: [delivering('g2'), delivering('g3'), delivering('g4')],
    projection: { state: 'working', turnId: null, pendingDelivery: true },
    freshSendTurnId: null,
    lastTurnWorking: true,
    isRetrying: false,
    turnHasError: () => false,
    firstPromptStandIn: false,
  };

  test('the row stays under the LAST row of the group while earlier rows echo', () => {
    const row = resolveBusyRow(base);
    const at = row.someTurnDrawsBusyRow
      ? row.workingTurnId
      : row.showFallbackBusyRow
        ? row.fallbackBusyRowTurnId
        : null;
    expect(at).toBe('g4');
  });

  test('guard: once the server names the running turn, that turn wins', () => {
    const row = resolveBusyRow({
      ...base,
      prompts: [],
      projection: { state: 'working', turnId: 'g4' },
    });
    expect(row.workingTurnId).toBe('g4');
  });
});
