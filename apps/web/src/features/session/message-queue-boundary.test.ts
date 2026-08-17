import { describe, expect, test } from 'bun:test';

import {
  OPEN_TURN_HUSK_MS,
  QUEUE_SETTLE_MS,
  canDrainQueue,
  createDrainMachine,
  planDrainTick,
  runQueueInterrupt,
  shouldClearPause,
  shouldInterruptForQueue,
  shouldQueueInsteadOfSend,
  stepDrainMachine,
  type QueueDrainGates,
} from './message-queue-boundary';

/** Every gate clear. Tests flip one at a time. */
const CLEAR: QueueDrainGates = {
  isServerBusy: false,
  pendingSendInFlight: false,
  isOptimisticCompacting: false,
  hasIncompleteAssistant: false,
  hasActiveQuestion: false,
  hasPendingApproval: false,
  pendingPermissionCount: 0,
  isPaused: false,
  readOnly: false,
  runtimeReady: true,
  revertStaged: false,
};

describe('canDrainQueue', () => {
  test('true only when every gate is clear', () => {
    expect(canDrainQueue(CLEAR)).toBe(true);
  });

  // A plain loop, not `test.each` — `@types/bun` does not declare `each`, and
  // the three files in this repo that use it are the whole of the known
  // typecheck baseline. Not adding a fourth.
  const BLOCKING: [string, Partial<QueueDrainGates>][] = [
    ['isServerBusy', { isServerBusy: true }],
    ['pendingSendInFlight', { pendingSendInFlight: true }],
    ['isOptimisticCompacting', { isOptimisticCompacting: true }],
    ['hasIncompleteAssistant', { hasIncompleteAssistant: true }],
    ['readOnly', { readOnly: true }],
  ];
  for (const [name, override] of BLOCKING) {
    test(`false while ${name}`, () => {
      expect(canDrainQueue({ ...CLEAR, ...override })).toBe(false);
    });
  }

  test('false while a question is on screen — the queue must not answer it', () => {
    expect(canDrainQueue({ ...CLEAR, hasActiveQuestion: true })).toBe(false);
  });

  test('false while an approval is pending — the queue must not bypass the gate', () => {
    expect(canDrainQueue({ ...CLEAR, hasPendingApproval: true })).toBe(false);
    expect(canDrainQueue({ ...CLEAR, pendingPermissionCount: 1 })).toBe(false);
  });

  test('false while the user has interrupted', () => {
    // Pressing stop means "stop doing things". Firing the queue a beat later
    // is the opposite of what was asked for.
    expect(canDrainQueue({ ...CLEAR, isPaused: true })).toBe(false);
  });

  test('has no isBusy input at all', () => {
    // `isBusy` in session-chat.tsx is a 300 ms fade timer for the busy
    // indicator. Reading it as "the turn ended" is a root cause, so the gate
    // type must not even offer it.
    expect(Object.keys(CLEAR)).not.toContain('isBusy');
  });
});

describe('shouldQueueInsteadOfSend', () => {
  test('sends directly on an idle session with an empty queue', () => {
    expect(shouldQueueInsteadOfSend({ isBusy: false, pendingCount: 0, hasInFlight: false })).toBe(
      false,
    );
  });

  test('queues while the agent is running', () => {
    expect(shouldQueueInsteadOfSend({ isBusy: true, pendingCount: 0, hasInFlight: false })).toBe(
      true,
    );
  });

  test('queues behind anything already waiting, even when the session reads idle', () => {
    // The settle window is up to 700ms of idle-looking time with messages
    // still queued. Sending here would jump the line.
    expect(shouldQueueInsteadOfSend({ isBusy: false, pendingCount: 1, hasInFlight: false })).toBe(
      true,
    );
  });

  test('queues while a claimed message is on the wire', () => {
    // Between claiming and the server reporting busy, isBusy is false. Sending
    // here puts two prompts in flight at once.
    expect(shouldQueueInsteadOfSend({ isBusy: false, pendingCount: 0, hasInFlight: true })).toBe(
      true,
    );
  });
});

describe('shouldClearPause', () => {
  test('a new queued message resumes a queue paused by stop', () => {
    // Without this, pressing stop wedges the queue permanently: every later
    // message queues behind one that never drains.
    expect(shouldClearPause(1, 2)).toBe(true);
  });

  test('draining does not resume it', () => {
    expect(shouldClearPause(2, 1)).toBe(false);
    expect(shouldClearPause(1, 0)).toBe(false);
  });

  test('no change does not resume it', () => {
    expect(shouldClearPause(2, 2)).toBe(false);
  });
});

describe('stepDrainMachine', () => {
  const settle = QUEUE_SETTLE_MS;

  test('does not dispatch while the server is busy, however long it stays busy', () => {
    let machine = createDrainMachine();
    for (const now of [0, 1_000, 10_000]) {
      const next = stepDrainMachine(machine, { ...CLEAR, isServerBusy: true }, now, settle);
      expect(next.dispatch).toBe(false);
      machine = next.machine;
    }
  });

  test('dispatches once the gates have been clear for the settle window', () => {
    const busy = stepDrainMachine(createDrainMachine(), { ...CLEAR, isServerBusy: true }, 0, settle);
    const armed = stepDrainMachine(busy.machine, CLEAR, 100, settle);
    expect(armed.dispatch).toBe(false);

    const fired = stepDrainMachine(armed.machine, CLEAR, 100 + settle, settle);
    expect(fired.dispatch).toBe(true);
  });

  test('a gate re-closing inside the window cancels the pending dispatch', () => {
    // This is the flap between agentic steps that the old 300 ms fade timer
    // mistook for the end of a turn.
    const busy = stepDrainMachine(createDrainMachine(), { ...CLEAR, isServerBusy: true }, 0, settle);
    const armed = stepDrainMachine(busy.machine, CLEAR, 100, settle);
    const flapped = stepDrainMachine(
      armed.machine,
      { ...CLEAR, isServerBusy: true },
      100 + settle / 2,
      settle,
    );
    expect(flapped.dispatch).toBe(false);

    // The clock restarts from the moment it went clear again, not from before.
    const rearmed = stepDrainMachine(flapped.machine, CLEAR, 100 + settle, settle);
    expect(rearmed.dispatch).toBe(false);
    expect(stepDrainMachine(rearmed.machine, CLEAR, 100 + settle * 2, settle).dispatch).toBe(true);
  });

  test('a queue restored on an idle session still drains', () => {
    // After a reload the session may never have been busy in this tab's
    // lifetime. Requiring a busy period we could not have observed would wedge
    // the queue forever.
    const armed = stepDrainMachine(createDrainMachine(), CLEAR, 0, settle);
    expect(armed.dispatch).toBe(false);
    expect(stepDrainMachine(armed.machine, CLEAR, settle, settle).dispatch).toBe(true);
  });

  test('the machine carries exactly the settle clock and the husk clock', () => {
    // The removed field was `sawBusySinceDispatch`, a latch that refused to
    // release anything until a NEW busy period had been observed by this tab.
    // The busy GATE already enforces one-message-per-turn — `beginOptimisticSend`
    // flips the session busy synchronously inside the send — so the latch only
    // ever added a way to fail closed: no observed busy period meant the queue
    // stopped forever.
    //
    // `openTurnOnlySince` is NOT that latch coming back: it fails in the
    // opposite direction. It never blocks anything the gates would release —
    // it only bounds how long a dead turn's permanently-open assistant message
    // (no `time.completed`, no error — a sandbox that died mid-turn) may keep
    // the queue wedged. See OPEN_TURN_HUSK_MS.
    expect(Object.keys(createDrainMachine())).toEqual(['clearSince', 'openTurnOnlySince']);
  });

  test('the message behind the head does not follow it into the same turn', () => {
    // First come, first served: `queue[0]` goes alone, and `queue[1]` waits for
    // the turn it started. The busy gate is what enforces that, and it closes
    // synchronously inside the send.
    const fired = stepDrainMachine(
      stepDrainMachine(createDrainMachine(), CLEAR, 0, settle).machine,
      CLEAR,
      settle,
      settle,
    );
    expect(fired.dispatch).toBe(true);

    // The send made the session busy. The next message stays put, however long
    // the turn runs.
    let machine = fired.machine;
    for (const now of [settle + 1, settle * 5, settle * 50]) {
      const next = stepDrainMachine(machine, { ...CLEAR, isServerBusy: true }, now, settle);
      expect(next.dispatch).toBe(false);
      machine = next.machine;
    }

    // That turn ends. Now — and only now — the new head goes.
    const armed = stepDrainMachine(machine, CLEAR, settle * 51, settle);
    expect(armed.dispatch).toBe(false);
    expect(stepDrainMachine(armed.machine, CLEAR, settle * 52, settle).dispatch).toBe(true);
  });

  test('a send that never reached the server still leaves a full window behind it', () => {
    // The one path where the busy gate cannot help: the send threw, so the
    // session never went busy and every gate stayed clear. Resetting the clock
    // on dispatch is what stops the whole queue emptying in one burst here.
    const fired = stepDrainMachine(
      stepDrainMachine(createDrainMachine(), CLEAR, 0, settle).machine,
      CLEAR,
      settle,
      settle,
    );
    expect(fired.dispatch).toBe(true);
    expect(stepDrainMachine(fired.machine, CLEAR, settle + 1, settle).dispatch).toBe(false);
  });

  test('a failed send does not lock the rest of the queue out', () => {
    // The lockout that got the client queue deleted once already: a send that
    // never made the session busy left the old machine waiting forever for a
    // turn that never started, and only an explicit `rearmDrainMachine` from a
    // `catch` could free it. There is no state left to wait on.
    const fired = stepDrainMachine(
      stepDrainMachine(createDrainMachine(), CLEAR, 0, settle).machine,
      CLEAR,
      settle,
      settle,
    );
    const armed = stepDrainMachine(fired.machine, CLEAR, settle * 2, settle);
    expect(stepDrainMachine(armed.machine, CLEAR, settle * 3, settle).dispatch).toBe(true);
  });

  test('is pure — stepping does not mutate the machine handed in', () => {
    const machine = createDrainMachine();
    const snapshot = structuredClone(machine);
    stepDrainMachine(machine, CLEAR, 0, settle);

    expect(machine).toEqual(snapshot);
  });
});

describe('planDrainTick', () => {
  const settle = QUEUE_SETTLE_MS;
  const base = { machine: createDrainMachine(), gates: CLEAR, sending: false, settleMs: settle };

  test('does nothing on an empty queue, and does not touch the clock', () => {
    const armed = { clearSince: 0, openTurnOnlySince: null };
    const { machine, action } = planDrainTick({ ...base, machine: armed, pendingCount: 0, now: 0 });

    expect(action).toEqual({ kind: 'idle' });
    expect(machine).toBe(armed);
  });

  test('does nothing while a send is already on the wire', () => {
    // Re-entering here is how the same message got sent twice.
    const { action } = planDrainTick({
      ...base,
      sending: true,
      pendingCount: 3,
      now: settle * 10,
    });

    expect(action).toEqual({ kind: 'idle' });
  });

  test('waits out the remainder of the settle window, and says how long', () => {
    // Nothing else re-renders while the gates simply stay clear, so the caller
    // has to set a timer. An off-by-one here means the queue stalls until the
    // next unrelated render.
    const armed = planDrainTick({ ...base, pendingCount: 1, now: 1_000 });
    expect(armed.action).toEqual({ kind: 'wait', ms: settle });

    const later = planDrainTick({ ...base, machine: armed.machine, pendingCount: 1, now: 1_200 });
    expect(later.action).toEqual({ kind: 'wait', ms: settle - 200 });
  });

  test('dispatches once the window has elapsed', () => {
    const armed = planDrainTick({ ...base, pendingCount: 2, now: 0 });
    const fired = planDrainTick({ ...base, machine: armed.machine, pendingCount: 2, now: settle });

    expect(fired.action).toEqual({ kind: 'dispatch' });
  });

  test('does not schedule a timer while a gate is closed', () => {
    // A closed gate will re-render when it opens. Polling behind it would burn
    // a timer per tick for as long as the agent runs.
    const { action } = planDrainTick({
      ...base,
      gates: { ...CLEAR, isServerBusy: true },
      pendingCount: 1,
      now: 0,
    });

    expect(action).toEqual({ kind: 'idle' });
  });

  test('never returns a negative wait', () => {
    const armed = planDrainTick({ ...base, pendingCount: 1, now: 0 });
    // A clock that jumped backwards (or a timer that fired late) must not ask
    // for a negative timeout.
    const skewed = planDrainTick({ ...base, machine: armed.machine, pendingCount: 1, now: -5_000 });

    expect(skewed.action.kind === 'wait' && skewed.action.ms >= 0).toBe(true);
  });
});

/**
 * The runtime gate — what lets the composer stay ENABLED while the sandbox is
 * stopped without losing the message.
 *
 * `send()` only checks that an opencode session id exists, not that its runtime
 * answers, so a prompt submitted against a sleeping box is accepted and lost.
 * These two rules are the replacement for disabling the input: route it to the
 * queue on the way in, hold it there until the box wakes.
 */
describe('runtimeReady gate', () => {
  test('a sleeping runtime blocks the drain even with every other gate clear', () => {
    expect(canDrainQueue({ ...CLEAR, runtimeReady: false })).toBe(false);
  });

  test('the drain resumes on its own once the runtime answers', () => {
    // Nothing else has to change — no re-enqueue, no user action. This is the
    // whole promise the notice makes ("messages will go out automatically").
    expect(canDrainQueue({ ...CLEAR, runtimeReady: false })).toBe(false);
    expect(canDrainQueue({ ...CLEAR, runtimeReady: true })).toBe(true);
  });

  test('a sleeping runtime holds the settle machine at zero, never dispatching', () => {
    const gates = { ...CLEAR, runtimeReady: false };
    let machine = createDrainMachine();

    // Well past the settle window — a gate that only delayed would fire here.
    for (const now of [0, 1_000, 10_000, 60_000]) {
      const step = stepDrainMachine(machine, gates, now);
      machine = step.machine;
      expect(step.dispatch).toBe(false);
    }
    expect(machine.clearSince).toBeNull();
  });

  test('submitting against a sleeping runtime queues, even on a totally idle session', () => {
    // The case that used to be impossible because the input was disabled:
    // nothing busy, nothing queued, nothing in flight — and it must STILL
    // queue, because the wire would swallow it.
    expect(
      shouldQueueInsteadOfSend({
        isBusy: false,
        pendingCount: 0,
        hasInFlight: false,
        runtimeReady: false,
      }),
    ).toBe(true);
  });

  test('a ready runtime restores the ordinary rules', () => {
    expect(
      shouldQueueInsteadOfSend({
        isBusy: false,
        pendingCount: 0,
        hasInFlight: false,
        runtimeReady: true,
      }),
    ).toBe(false);
  });

  test('omitting runtimeReady defaults to ready — existing callers are unchanged', () => {
    expect(
      shouldQueueInsteadOfSend({ isBusy: false, pendingCount: 0, hasInFlight: false }),
    ).toBe(false);
    expect(
      shouldQueueInsteadOfSend({ isBusy: true, pendingCount: 0, hasInFlight: false }),
    ).toBe(true);
  });
});

/**
 * T22 — the web must never prompt across a staged session rewind. A staged
 * revert's local hide window can hide the ONLY thing making other gates
 * (`hasIncompleteAssistant`, `isServerBusy`) read true, so relying on those
 * alone would let the drain open SOONER during a staged revert, not later —
 * exactly backwards. This gate hard-closes the drain independent of every
 * other signal, for as long as `rewindMessageId` is non-null (staged, not
 * yet committed) on the session.
 */
describe('revertStaged gate', () => {
  test('a staged revert blocks the drain even with every other gate clear', () => {
    expect(canDrainQueue({ ...CLEAR, revertStaged: true })).toBe(false);
  });

  test('the drain resumes once the revert is no longer staged (cleared or committed)', () => {
    expect(canDrainQueue({ ...CLEAR, revertStaged: true })).toBe(false);
    expect(canDrainQueue({ ...CLEAR, revertStaged: false })).toBe(true);
  });

  test('a staged revert holds the settle machine at zero, never dispatching', () => {
    const gates = { ...CLEAR, revertStaged: true };
    let machine = createDrainMachine();
    for (const now of [0, 1_000, 10_000, 60_000]) {
      const step = stepDrainMachine(machine, gates, now);
      machine = step.machine;
      expect(step.dispatch).toBe(false);
    }
    expect(machine.clearSince).toBeNull();
  });
});

describe('dead-turn husk override', () => {
  // A sandbox that dies mid-turn and boots fresh leaves the last assistant
  // message permanently open: `time.completed` never set, no error ever
  // patched. The session status is idle (the runtime is doing nothing), yet
  // `hasIncompleteAssistant` stayed true for the lifetime of the transcript —
  // wedging the queue forever, hard refresh included, because the husk is in
  // the server's own data. After OPEN_TURN_HUSK_MS of "idle in every way
  // except the dangling message", the husk stops blocking.
  const HUSK_ONLY = { ...CLEAR, hasIncompleteAssistant: true };

  test('an open assistant turn still blocks the drain while fresh', () => {
    const machine = createDrainMachine();
    let step = stepDrainMachine(machine, HUSK_ONLY, 0);
    expect(step.dispatch).toBe(false);
    step = stepDrainMachine(step.machine, HUSK_ONLY, OPEN_TURN_HUSK_MS - 1);
    expect(step.dispatch).toBe(false);
  });

  test('a husk outlasting OPEN_TURN_HUSK_MS stops blocking and the queue drains after the settle window', () => {
    let machine = createDrainMachine();
    machine = stepDrainMachine(machine, HUSK_ONLY, 0).machine;
    // Husk expired — the settle clock starts now.
    machine = stepDrainMachine(machine, HUSK_ONLY, OPEN_TURN_HUSK_MS).machine;
    const step = stepDrainMachine(machine, HUSK_ONLY, OPEN_TURN_HUSK_MS + QUEUE_SETTLE_MS);
    expect(step.dispatch).toBe(true);
  });

  test('a real running turn never husks — server busy resets the husk clock', () => {
    let machine = createDrainMachine();
    machine = stepDrainMachine(machine, HUSK_ONLY, 0).machine;
    // The server reports busy mid-wait: this is a live turn, not a husk.
    machine = stepDrainMachine(machine, { ...HUSK_ONLY, isServerBusy: true }, 5_000).machine;
    // Open-assistant again with the server idle — the clock must restart.
    machine = stepDrainMachine(machine, HUSK_ONLY, 6_000).machine;
    const step = stepDrainMachine(machine, HUSK_ONLY, OPEN_TURN_HUSK_MS + 1_000);
    expect(step.dispatch).toBe(false);
  });

  test('any other closed gate resets the husk clock', () => {
    let machine = createDrainMachine();
    machine = stepDrainMachine(machine, HUSK_ONLY, 0).machine;
    machine = stepDrainMachine(machine, { ...HUSK_ONLY, runtimeReady: false }, 5_000).machine;
    machine = stepDrainMachine(machine, HUSK_ONLY, 6_000).machine;
    const step = stepDrainMachine(machine, HUSK_ONLY, OPEN_TURN_HUSK_MS + 5_999);
    expect(step.dispatch).toBe(false);
  });

  test('planDrainTick schedules a wake-up while waiting out the husk', () => {
    // Nothing re-renders while a husk merely ages, so the planner must hand
    // back a timer — otherwise the override only fires on an unrelated render.
    let machine = createDrainMachine();
    machine = stepDrainMachine(machine, HUSK_ONLY, 0).machine;
    const { action } = planDrainTick({
      machine,
      gates: HUSK_ONLY,
      pendingCount: 1,
      sending: false,
      now: 1_000,
    });
    expect(action.kind).toBe('wait');
    if (action.kind === 'wait') {
      expect(action.ms).toBe(OPEN_TURN_HUSK_MS - 1_000);
    }
  });
});

// ---------------------------------------------------------------------------
// Interrupt-at-boundary: a queued message stops the run at the next tool
// boundary instead of waiting for the whole turn.
// ---------------------------------------------------------------------------

/** The state in which the interrupt must fire. Tests flip one input at a time. */
const INTERRUPTIBLE = {
  gates: { ...CLEAR, isServerBusy: true, hasIncompleteAssistant: true },
  hasRunningTool: false,
  hasNewPending: true,
  sending: false,
  interrupting: false,
};

describe('shouldInterruptForQueue', () => {
  test('fires while the server is busy, nothing else holds, and no tool is running', () => {
    expect(shouldInterruptForQueue(INTERRUPTIBLE)).toBe(true);
  });

  test('an open assistant message alone does not block — busy IS the interrupt target', () => {
    // `hasIncompleteAssistant` is a drain gate ("wait for the turn to end").
    // The interrupt exists precisely because the turn has not ended.
    expect(
      shouldInterruptForQueue({
        ...INTERRUPTIBLE,
        gates: { ...INTERRUPTIBLE.gates, hasIncompleteAssistant: true },
      }),
    ).toBe(true);
  });

  test('waits while a tool call is executing — never kill a running tool', () => {
    expect(shouldInterruptForQueue({ ...INTERRUPTIBLE, hasRunningTool: true })).toBe(false);
  });

  test('fires the moment the running tool finishes', () => {
    const during = { ...INTERRUPTIBLE, hasRunningTool: true };
    expect(shouldInterruptForQueue(during)).toBe(false);
    expect(shouldInterruptForQueue({ ...during, hasRunningTool: false })).toBe(true);
  });

  test('does nothing while the server is idle — the ordinary drain owns that path', () => {
    expect(
      shouldInterruptForQueue({
        ...INTERRUPTIBLE,
        gates: { ...INTERRUPTIBLE.gates, isServerBusy: false },
      }),
    ).toBe(false);
  });

  test('nothing new pending → no interrupt', () => {
    // Leftovers from a split batch queued BEFORE this turn started must wait
    // for it, not kill it. Only a message typed during the run interrupts.
    expect(shouldInterruptForQueue({ ...INTERRUPTIBLE, hasNewPending: false })).toBe(false);
  });

  test('never doubles up while a send or an earlier interrupt is in flight', () => {
    expect(shouldInterruptForQueue({ ...INTERRUPTIBLE, sending: true })).toBe(false);
    expect(shouldInterruptForQueue({ ...INTERRUPTIBLE, interrupting: true })).toBe(false);
  });

  const HOLDS: [string, Partial<QueueDrainGates>][] = [
    ['a structured question is on screen', { hasActiveQuestion: true }],
    ['an approval is pending', { hasPendingApproval: true }],
    ['permissions are pending', { pendingPermissionCount: 1 }],
    ['the user pressed stop', { isPaused: true }],
    ['the view is read-only', { readOnly: true }],
    ['the runtime is not ready', { runtimeReady: false }],
    ['a rewind is staged', { revertStaged: true }],
    ['our own send is unacknowledged', { pendingSendInFlight: true }],
    ['a compaction is running', { isOptimisticCompacting: true }],
  ];
  for (const [name, override] of HOLDS) {
    test(`held while ${name}`, () => {
      expect(
        shouldInterruptForQueue({
          ...INTERRUPTIBLE,
          gates: { ...INTERRUPTIBLE.gates, ...override },
        }),
      ).toBe(false);
    });
  }
});

describe('runQueueInterrupt', () => {
  test('aborts first, then claims and dispatches the batch', async () => {
    const order: string[] = [];
    await runQueueInterrupt({
      interrupt: async () => {
        order.push('interrupt');
      },
      isHeld: () => false,
      claimBatch: () => {
        order.push('claim');
        return ['a', 'b'];
      },
      dispatch: async (claimed) => {
        order.push(`dispatch:${claimed.join(',')}`);
      },
    });
    expect(order).toEqual(['interrupt', 'claim', 'dispatch:a,b']);
  });

  test('a failed abort dispatches nothing — never fire into a still-running turn', async () => {
    let dispatched = false;
    await runQueueInterrupt({
      interrupt: async () => {
        throw new Error('abort failed');
      },
      isHeld: () => false,
      claimBatch: () => ['a'],
      dispatch: async () => {
        dispatched = true;
      },
    });
    expect(dispatched).toBe(false);
  });

  test('a stop pressed while the abort settled holds the dispatch', async () => {
    // The user hit stop during our interrupt. Stop wins: "stop doing things"
    // includes the queue, and the pause must not be followed a beat later by
    // exactly the message it was holding back.
    let dispatched = false;
    await runQueueInterrupt({
      interrupt: async () => {},
      isHeld: () => true,
      claimBatch: () => ['a'],
      dispatch: async () => {
        dispatched = true;
      },
    });
    expect(dispatched).toBe(false);
  });

  test('an empty claim dispatches nothing — another drain already took the batch', async () => {
    let dispatched = false;
    await runQueueInterrupt({
      interrupt: async () => {},
      isHeld: () => false,
      claimBatch: () => [],
      dispatch: async () => {
        dispatched = true;
      },
    });
    expect(dispatched).toBe(false);
  });
});
