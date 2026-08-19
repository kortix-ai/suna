/**
 * The submit latch: one user action = one submission — WITHOUT eating the next
 * user action.
 *
 * The inline predecessor (`submissionInFlight` in composer.tsx) returned on any
 * re-entrant submit, holding the gate for the entire await of the previous
 * send's ACK. That ACK can take seconds (file uploads) to ~30s (the sandbox
 * boot/wake retry window in `promptOpenCodeMessage`), and every Enter inside
 * the window was silently dropped — the message the queue exists to hold never
 * reached the queue decision. That is the "second message never queues, Enter
 * does nothing" report.
 *
 * The discriminator between the two cases the latch must separate:
 *  - a same-tick DOUBLE-FIRE of one action arrives with an empty draft
 *    (dispatch already cleared the editor synchronously; only un-flushed
 *    `attachedFiles` state can linger) → still dropped, same as before.
 *  - a DISTINCT second message arrives with typed text → deferred, and re-runs
 *    once the in-flight dispatch settles, landing in the normal busy→queue path.
 */
import { describe, expect, test } from 'bun:test';

import { createSubmitLatch } from './submit-latch';

/** A dispatch whose settlement the test controls. */
function controlledDispatch() {
  const resolvers: Array<() => void> = [];
  const rejecters: Array<(err: Error) => void> = [];
  let calls = 0;
  const dispatch = () => {
    calls++;
    return new Promise<void>((resolve, reject) => {
      resolvers.push(resolve);
      rejecters.push(reject);
    });
  };
  return {
    dispatch,
    calls: () => calls,
    settle: (i: number) => resolvers[i](),
    fail: (i: number) => rejecters[i](new Error('send failed')),
  };
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('createSubmitLatch', () => {
  test('a single submit dispatches once', async () => {
    const d = controlledDispatch();
    const submit = createSubmitLatch(d.dispatch, () => true);
    const p = submit();
    expect(d.calls()).toBe(1);
    d.settle(0);
    await p;
    expect(d.calls()).toBe(1);
  });

  test('a re-entrant submit with draft text defers, then dispatches after settle', async () => {
    const d = controlledDispatch();
    const submit = createSubmitLatch(d.dispatch, () => true);
    const first = submit();
    void submit(); // the second message, typed while the first ACK is pending
    expect(d.calls()).toBe(1); // not re-entrant — still in flight
    d.settle(0);
    await first;
    await tick();
    expect(d.calls()).toBe(2); // the deferred submission ran
  });

  test('a re-entrant submit with an EMPTY draft is dropped (double-fire guard)', async () => {
    const d = controlledDispatch();
    const submit = createSubmitLatch(d.dispatch, () => false);
    const first = submit();
    void submit(); // same-tick double-fire: editor already cleared
    d.settle(0);
    await first;
    await tick();
    expect(d.calls()).toBe(1); // dropped, exactly like the old latch
  });

  test('many re-entrant submits collapse into one deferred re-run', async () => {
    const d = controlledDispatch();
    const submit = createSubmitLatch(d.dispatch, () => true);
    const first = submit();
    void submit();
    void submit();
    void submit(); // mashing Enter while blocked
    d.settle(0);
    await first;
    await tick();
    expect(d.calls()).toBe(2); // one re-run reads the whole current draft
    d.settle(1);
  });

  test('the deferred re-run happens even when the first dispatch throws', async () => {
    // The first send failing is not a reason to lose the second message.
    const d = controlledDispatch();
    const submit = createSubmitLatch(d.dispatch, () => true);
    const first = submit();
    void submit();
    d.fail(0);
    await first.catch(() => {});
    await tick();
    expect(d.calls()).toBe(2);
    d.settle(1);
  });

  test('a throw releases the latch — the composer cannot wedge', async () => {
    const d = controlledDispatch();
    const submit = createSubmitLatch(d.dispatch, () => false);
    const first = submit();
    d.fail(0);
    await first.catch(() => {});
    void submit();
    expect(d.calls()).toBe(2); // a fresh submit goes straight through
    d.settle(1);
  });

  test('the deferred re-run is itself latched (a submit during it defers again)', async () => {
    const d = controlledDispatch();
    const submit = createSubmitLatch(d.dispatch, () => true);
    const first = submit();
    void submit();
    d.settle(0);
    await first;
    await tick();
    expect(d.calls()).toBe(2); // deferred run in flight
    void submit(); // typed during the deferred run
    expect(d.calls()).toBe(2); // not re-entrant
    d.settle(1);
    await tick();
    expect(d.calls()).toBe(3);
    d.settle(2);
  });
});
