import { describe, expect, test } from 'bun:test';
import { deliverWithRetry, type DeliveryTarget } from '../deliver';

// Regression guard for "@Kortix replied 'Still waking this thread's session back
// up — send that again' on a session that was already awake." The runtime was
// ready; the prompt hand-off just had a transient post-wake hiccup (a rotated
// opencode session 404, a daemon 5xx, a briefly-null externalId). The old path
// bounced to 'pending' on the first miss and dropped the message. deliverWithRetry
// must heal + retry through that window and only surface 'pending' if it truly
// never lands.

const ready = (externalId: string | null, opencodeSessionId: string | null): DeliveryTarget => ({
  stage: 'ready',
  externalId,
  opencodeSessionId,
});

const noSleep = async () => {};
// Deterministic clock: each call advances by `step` (no wall-clock in the test).
const stepNow = (step: number) => {
  let t = -step;
  return () => {
    t += step;
    return t;
  };
};

describe('deliverWithRetry — hand the prompt off through the post-wake flake', () => {
  test('happy path: first send accepted → delivered, never reopens', async () => {
    let sends = 0;
    let reopens = 0;
    const outcome = await deliverWithRetry({
      opened: ready('ext-1', 'oc-1'),
      reopen: async () => {
        reopens++;
        return ready('ext-1', 'oc-1');
      },
      send: async () => {
        sends++;
        return true;
      },
      now: stepNow(1000),
      sleepFn: noSleep,
    });
    expect(outcome).toBe('delivered');
    expect(sends).toBe(1);
    expect(reopens).toBe(0);
  });

  test('THE FIX: a transient send failure is healed + retried → delivered (not pending)', async () => {
    let sends = 0;
    const outcome = await deliverWithRetry({
      opened: ready('ext-1', 'oc-1'),
      reopen: async () => ready('ext-1', 'oc-2'), // rotated opencode session
      send: async (_ext, oc) => {
        sends++;
        return oc === 'oc-2'; // first id 404s, healed id is accepted
      },
      now: stepNow(1000),
      sleepFn: noSleep,
    });
    expect(outcome).toBe('delivered');
    expect(sends).toBe(2);
  });

  test('externalId briefly null at ready → waits for the resume to surface it, then delivers', async () => {
    const outcome = await deliverWithRetry({
      opened: ready(null, 'oc-1'), // mid-resume: no external id yet → cannot send
      reopen: async () => ready('ext-1', 'oc-1'),
      send: async () => true,
      now: stepNow(1000),
      sleepFn: noSleep,
    });
    expect(outcome).toBe('delivered');
  });

  test('send never succeeds before the deadline → pending (the honest last resort)', async () => {
    let sends = 0;
    const outcome = await deliverWithRetry({
      opened: ready('ext-1', 'oc-1'),
      reopen: async () => ready('ext-1', 'oc-1'),
      send: async () => {
        sends++;
        return false;
      },
      now: stepNow(10_000),
      sleepFn: noSleep,
      deadlineMs: 45_000,
    });
    expect(outcome).toBe('pending');
    expect(sends).toBeGreaterThan(1); // it really did retry, not bounce on the first miss
  });

  test('reopen finds the session gone → no-session', async () => {
    const outcome = await deliverWithRetry({
      opened: ready('ext-1', 'oc-1'),
      reopen: async () => null,
      send: async () => false,
      now: stepNow(1000),
      sleepFn: noSleep,
    });
    expect(outcome).toBe('no-session');
  });

  // A DOWN RUNTIME IS NOT A FAILED DELIVERY. This loop stops re-trying a dead
  // box in-line — that part was always right — but the outcome it reports has
  // to say WHY, because the drain turns 'failed' into a dead-letter on the
  // first attempt. SampleCo 2026-08-26: a queued prompt delivered while the box
  // was unreachable went `state:failed, attempts:1` and was never re-tried when
  // the box came back minutes later.
  test('reopen reports a parked runtime → unreachable (stop retrying HERE, keep the prompt)', async () => {
    const outcome = await deliverWithRetry({
      opened: ready('ext-1', 'oc-1'),
      reopen: async () => ({ stage: 'failed', externalId: null, opencodeSessionId: null }),
      send: async () => false,
      now: stepNow(1000),
      sleepFn: noSleep,
    });
    expect(outcome).toBe('unreachable');
  });

  test('reopen reports a hibernated box → unreachable, not failed', async () => {
    const outcome = await deliverWithRetry({
      opened: ready('ext-1', 'oc-1'),
      reopen: async () => ({ stage: 'stopped', externalId: null, opencodeSessionId: null }),
      send: async () => false,
      now: stepNow(1000),
      sleepFn: noSleep,
    });
    expect(outcome).toBe('unreachable');
  });

  test('a MISSING session stays terminal — there is nothing to come back to', async () => {
    const outcome = await deliverWithRetry({
      opened: ready('ext-1', 'oc-1'),
      reopen: async () => null,
      send: async () => false,
      now: stepNow(1000),
      sleepFn: noSleep,
    });
    expect(outcome).toBe('no-session');
  });

  // THE PATH TO THE BOX IS DOWN, AND THE BOX ITSELF LOOKS FINE. `reopen` keeps
  // answering `ready` — the session row IS ready, the sandbox IS running — but
  // every POST comes back 502 from the proxy. That used to spend the deadline
  // and report 'pending', which `executeQueuedContinue` retries on the
  // 5-attempt dead-letter budget: the user's message was destroyed ~5 minutes
  // in. Prod 2026-09-15/16, a Platinum control plane that refused every POST
  // while GETs served normally, did exactly that at ~48 prompts/hour.
  test('the daemon is never reached though the stage stays ready → unreachable, not pending', async () => {
    let sends = 0;
    const outcome = await deliverWithRetry({
      opened: ready('ext-1', 'oc-1'),
      reopen: async () => ready('ext-1', 'oc-1'),
      send: async () => { sends++; return 'unreachable'; },
      now: stepNow(1000),
      sleepFn: noSleep,
    });
    expect(outcome).toBe('unreachable');
    expect(sends).toBeGreaterThan(1);
  });

  // The daemon ANSWERING and refusing is a different thing from nobody
  // answering. It is reachable, so re-opening the session can heal it, and a
  // spent deadline is still 'pending'.
  test('a daemon that answers and refuses stays pending — reachable is not unreachable', async () => {
    const outcome = await deliverWithRetry({
      opened: ready('ext-1', 'oc-1'),
      reopen: async () => ready('ext-1', 'oc-1'),
      send: async () => false,
      now: stepNow(1000),
      sleepFn: noSleep,
    });
    expect(outcome).toBe('pending');
  });

  // Flap: the path comes back and the next attempt lands. Nothing about the
  // earlier 502s may cost the prompt its delivery.
  test('an unreachable attempt followed by an accepted one delivers', async () => {
    let n = 0;
    const outcome = await deliverWithRetry({
      opened: ready('ext-1', 'oc-1'),
      reopen: async () => ready('ext-1', 'oc-1'),
      send: async () => (++n < 3 ? 'unreachable' : true),
      now: stepNow(1000),
      sleepFn: noSleep,
    });
    expect(outcome).toBe('delivered');
  });

  // The freshest verdict wins: the path was down, then the daemon came back and
  // refused on its own terms. That is reachable, so 'pending'.
  test('the LAST attempt decides the verdict', async () => {
    let n = 0;
    const outcome = await deliverWithRetry({
      opened: ready('ext-1', 'oc-1'),
      reopen: async () => ready('ext-1', 'oc-1'),
      send: async () => (++n < 3 ? 'unreachable' : false),
      now: stepNow(1000),
      sleepFn: noSleep,
    });
    expect(outcome).toBe('pending');
  });
});
