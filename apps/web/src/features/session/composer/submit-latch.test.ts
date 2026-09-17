import { describe, expect, test } from 'bun:test';

import { createSubmitLatch } from './submit-latch';

/** A dispatch whose settlement the test controls. */
function controlledDispatch() {
  const resolvers: Array<() => void> = [];
  const rejecters: Array<(err: Error) => void> = [];
  let calls = 0;
  const args: unknown[] = [];
  const dispatch = (draft?: unknown) => {
    calls++;
    args.push(draft);
    return new Promise<void>((resolve, reject) => {
      resolvers.push(resolve);
      rejecters.push(reject);
    });
  };
  return {
    dispatch,
    calls: () => calls,
    args: () => args,
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

  test('a distinct prompt dispatches before the previous acceptance returns', async () => {
    const d = controlledDispatch();
    const submit = createSubmitLatch(d.dispatch, () => true);
    const first = submit();
    void submit(); // the second message, typed while the first ACK is pending
    expect(d.calls()).toBe(2); // paint and POST now, while the first ACK waits
    d.settle(0);
    await first;
    await tick();
    expect(d.calls()).toBe(2); // acceptance does not dispatch it twice
    d.settle(1);
  });

  test('a re-entrant submit with an EMPTY draft is dropped (double-fire guard)', async () => {
    const d = controlledDispatch();
    const submit = createSubmitLatch(d.dispatch, () => null);
    const first = submit();
    void submit(); // same-tick double-fire: editor already cleared
    d.settle(0);
    await first;
    await tick();
    expect(d.calls()).toBe(1); // dropped, exactly like the old latch
  });

  test('each distinct re-entrant submit is its OWN submission, fired as one burst in order', async () => {
    // Every Enter paints and submits independently, in input order.
    const d = controlledDispatch();
    let n = 0;
    const submit = createSubmitLatch(d.dispatch, () => `draft-${++n}`);
    const first = submit();
    void submit();
    void submit();
    void submit();
    expect(d.calls()).toBe(4);
    d.settle(0);
    await first;
    await tick();
    expect(d.calls()).toBe(4);
    expect(d.args()).toEqual([undefined, 'draft-1', 'draft-2', 'draft-3']);
    d.settle(1);
    d.settle(2);
    d.settle(3);
  });

  test('the stash is captured at submit time, not re-read later', async () => {
    // The whole point: what the user had typed at Enter #2 is what #2 sends,
    // whatever they type afterwards.
    const d = controlledDispatch();
    let draft = 'second';
    const submit = createSubmitLatch(d.dispatch, () => draft);
    const first = submit();
    void submit();
    draft = 'typed later';
    d.settle(0);
    await first;
    await tick();
    expect(d.args()[1]).toBe('second');
    d.settle(1);
  });

  test('a later prompt survives a failed earlier acceptance', async () => {
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
    const submit = createSubmitLatch(d.dispatch, () => null);
    const first = submit();
    d.fail(0);
    await first.catch(() => {});
    void submit();
    expect(d.calls()).toBe(2); // a fresh submit goes straight through
    d.settle(1);
  });

  test('a third submit dispatches while the second acceptance is pending', async () => {
    const d = controlledDispatch();
    let n = 0;
    const submit = createSubmitLatch(d.dispatch, () => `draft-${++n}`);
    const first = submit();
    void submit();
    d.settle(0);
    await first;
    await tick();
    expect(d.calls()).toBe(2); // burst in flight
    void submit(); // typed during the burst
    expect(d.calls()).toBe(3); // the pending ACK cannot delay local feedback
    d.settle(1);
    await tick();
    expect(d.calls()).toBe(3);
    d.settle(2);
  });

  test('out-of-order acceptances keep duplicate protection for the remaining send', async () => {
    const d = controlledDispatch();
    let draft: string | null = 'second';
    const submit = createSubmitLatch(d.dispatch, () => draft);
    const first = submit();
    const second = submit();
    d.settle(1);
    await second;
    draft = null;
    await submit();
    expect(d.calls()).toBe(2);
    d.settle(0);
    await first;
    const third = submit();
    expect(d.calls()).toBe(3);
    d.settle(2);
    await third;
  });
});
