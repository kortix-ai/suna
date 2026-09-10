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
    const submit = createSubmitLatch(d.dispatch, () => null);
    const first = submit();
    void submit(); // same-tick double-fire: editor already cleared
    d.settle(0);
    await first;
    await tick();
    expect(d.calls()).toBe(1); // dropped, exactly like the old latch
  });

  test('each distinct re-entrant submit is its OWN submission, fired as one burst in order', async () => {
    // Three messages typed during one slow ACK used to collapse into ONE
    // deferred re-run that re-read the live editor — i.e. one message with
    // the three texts run together. Every Enter is one message; when the
    // in-flight dispatch settles the whole stash goes out TOGETHER (invoked
    // in Enter order — the sync prefix mints ids in order — awaited
    // concurrently, so one slow ack cannot hold the burst back).
    const d = controlledDispatch();
    let n = 0;
    const submit = createSubmitLatch(d.dispatch, () => `draft-${++n}`);
    const first = submit();
    void submit();
    void submit();
    void submit();
    expect(d.calls()).toBe(1);
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
    const submit = createSubmitLatch(d.dispatch, () => null);
    const first = submit();
    d.fail(0);
    await first.catch(() => {});
    void submit();
    expect(d.calls()).toBe(2); // a fresh submit goes straight through
    d.settle(1);
  });

  test('a submit during the burst stashes and fires when the burst settles', async () => {
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
    expect(d.calls()).toBe(2); // not re-entrant
    d.settle(1);
    await tick();
    expect(d.calls()).toBe(3);
    d.settle(2);
  });
});

/**
 * THE INTENT RIDES WITH THE DRAFT.
 *
 * Enter runs the prompt (interrupting a live turn if there is one); Cmd+Enter
 * queues it. A prompt typed during a slow send is STASHED and dispatched later
 * — so the intent has to be stashed with it. Carrying only the latest intent,
 * or re-deriving it at dispatch time from whether the session is busy, turns a
 * deliberate Cmd+Enter into an interrupt one keystroke after the user chose not
 * to interrupt.
 */
describe('createSubmitLatch carries the submit intent', () => {
  test('a direct submit hands its intent to the dispatch', async () => {
    const seen: unknown[] = [];
    const submit = createSubmitLatch<string, string>(
      async (draft, intent) => void seen.push([draft, intent]),
      () => null,
    );
    await submit('queue');
    expect(seen).toEqual([[undefined, 'queue']]);
  });

  test('each stashed draft keeps the intent it was typed with', async () => {
    const seen: Array<[unknown, unknown]> = [];
    let settle!: () => void;
    const gate = new Promise<void>((resolve) => (settle = resolve));
    let first = true;
    let n = 0;
    const submit = createSubmitLatch<string, string>(
      async (draft, intent) => {
        seen.push([draft, intent]);
        if (first) {
          first = false;
          await gate;
        }
      },
      () => `draft-${++n}`,
    );

    void submit('run'); // in flight, holds the latch
    void submit('queue'); // stashed, must stay 'queue'
    void submit('run'); // stashed, must stay 'run'
    settle();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(seen).toEqual([
      [undefined, 'run'],
      ['draft-1', 'queue'],
      ['draft-2', 'run'],
    ]);
  });

  test('the stash capture is told which intent it is capturing', async () => {
    const intents: unknown[] = [];
    let settle!: () => void;
    const gate = new Promise<void>((resolve) => (settle = resolve));
    let first = true;
    const submit = createSubmitLatch<string, string>(
      async () => {
        if (first) {
          first = false;
          await gate;
        }
      },
      (intent) => {
        intents.push(intent);
        return 'draft';
      },
    );

    void submit('run');
    void submit('queue');
    settle();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(intents).toEqual(['queue']);
  });
});
