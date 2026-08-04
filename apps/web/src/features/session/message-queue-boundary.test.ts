import { describe, expect, test } from 'bun:test';

import {
  QUEUE_SETTLE_MS,
  canDrainQueue,
  createDrainMachine,
  rearmDrainMachine,
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
    // indicator. Reading it as "the turn ended" is root cause 2, so the gate
    // type must not even offer it.
    expect(Object.keys(CLEAR)).not.toContain('isBusy');
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

  test('dispatches exactly once per turn — the next needs a new busy period', () => {
    // Three queued messages must become three turns, not one burst. The old
    // drain looped `await handleSend` over the whole queue, so items 2..N
    // landed inside item 1's turn.
    const busy = stepDrainMachine(createDrainMachine(), { ...CLEAR, isServerBusy: true }, 0, settle);
    const armed = stepDrainMachine(busy.machine, CLEAR, 100, settle);
    const first = stepDrainMachine(armed.machine, CLEAR, 100 + settle, settle);
    expect(first.dispatch).toBe(true);

    // Still idle, much later. Nothing more goes out.
    let machine = first.machine;
    for (const now of [settle * 3, settle * 10, settle * 100]) {
      const next = stepDrainMachine(machine, CLEAR, now, settle);
      expect(next.dispatch).toBe(false);
      machine = next.machine;
    }

    // The dispatched message starts a turn; when that turn ends, the next goes.
    const busyAgain = stepDrainMachine(machine, { ...CLEAR, isServerBusy: true }, settle * 101, settle);
    const rearmed = stepDrainMachine(busyAgain.machine, CLEAR, settle * 102, settle);
    const second = stepDrainMachine(rearmed.machine, CLEAR, settle * 103, settle);
    expect(second.dispatch).toBe(true);
  });

  test('a queue restored on an idle session still drains', () => {
    // After a reload the session may never have been busy in this tab's
    // lifetime. Requiring a busy period we could not have observed would wedge
    // the queue forever.
    const armed = stepDrainMachine(createDrainMachine(), CLEAR, 0, settle);
    expect(armed.dispatch).toBe(false);
    expect(stepDrainMachine(armed.machine, CLEAR, settle, settle).dispatch).toBe(true);
  });

  test('rearm lets the queue continue after a send that never went busy', () => {
    // A send that fails outright never produces a busy period, so without an
    // explicit rearm the rest of the queue would never move — the exact
    // lockout that got the queue deleted once already.
    const busy = stepDrainMachine(createDrainMachine(), { ...CLEAR, isServerBusy: true }, 0, settle);
    const armed = stepDrainMachine(busy.machine, CLEAR, 100, settle);
    const dispatched = stepDrainMachine(armed.machine, CLEAR, 100 + settle, settle);
    expect(dispatched.dispatch).toBe(true);

    // Without the rearm the machine is waiting for a busy period that the
    // failed send never produced, so nothing would ever move again.
    expect(stepDrainMachine(dispatched.machine, CLEAR, settle * 9, settle).dispatch).toBe(false);

    const rearmed = stepDrainMachine(rearmDrainMachine(dispatched.machine), CLEAR, settle * 3, settle);
    expect(rearmed.dispatch).toBe(false);
    expect(stepDrainMachine(rearmed.machine, CLEAR, settle * 4, settle).dispatch).toBe(true);
  });

  test('is pure — stepping does not mutate the machine handed in', () => {
    const machine = createDrainMachine();
    const snapshot = structuredClone(machine);
    stepDrainMachine(machine, CLEAR, 0, settle);

    expect(machine).toEqual(snapshot);
  });
});
