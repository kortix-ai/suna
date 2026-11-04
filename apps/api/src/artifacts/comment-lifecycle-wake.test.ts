import { expect, test } from 'bun:test';
import { createArtifactCommentLifecycleWaker } from './comment-lifecycle-wake';
const settle = () => new Promise(resolve => setTimeout(resolve, 0));
function fixture(global = true, jobs = false) {
  const flags = { global, jobs }; const calls: unknown[] = []; const scheduled: Array<{ run: () => void; delay: number }> = []; const errors: unknown[] = [];
  let fail = false;
  const wake = createArtifactCommentLifecycleWaker({ workersEnabled: () => flags.global, jobWorkerEnabled: () => flags.jobs, now: () => 1000,
    schedule: (run, delay) => { scheduled.push({ run, delay }); },
    drain: async input => { calls.push(input); if (fail) throw new Error('synthetic drain failure'); }, onError: key => errors.push(key) });
  return { wake, flags, calls, scheduled, errors, fail: () => { fail = true; } };
}
test('global-only and jobs-only enable exact handoff kicks while both false schedule nothing', async () => {
  for (const [global, jobs] of [[true,false],[false,true],[false,false]]) {
    const f = fixture(global,jobs); f.wake({ idempotencyKey: 'owned-exact-command', availableAt: new Date(1000) }); await settle();
    expect(f.calls).toEqual(global || jobs ? [{ idempotencyKey: 'owned-exact-command', limit: 1, burst: false, coalesce: false }] : []); expect(f.scheduled).toEqual([]);
  }
});
test('a future availableAt waits once and execution rechecks worker flags', async () => {
  const f = fixture(); f.wake({ idempotencyKey: 'owned-future-digest', availableAt: new Date(16000) });
  expect(f.calls).toEqual([]); expect(f.scheduled.map(item => item.delay)).toEqual([15000]);
  f.flags.global = false; f.scheduled[0].run(); await settle(); expect(f.calls).toEqual([]);
  f.flags.jobs = true; f.scheduled[0].run(); await settle(); expect(f.calls).toHaveLength(1);
});
test('targeted drain rejection is contained without changing durable command state', async () => {
  const f = fixture(); f.fail(); f.wake({ idempotencyKey: 'owned-retryable-command', availableAt: new Date(900) }); await settle();
  expect(f.calls).toHaveLength(1); expect(f.errors).toEqual(['owned-retryable-command']);
});
test('future kicks share one bounded timer and distant queue retries own their scheduling', () => {
  const f = fixture();
  for (let attempt = 0; attempt < 3; attempt++) f.wake({ idempotencyKey: 'same-digest', availableAt: new Date(16000) });
  f.wake({ idempotencyKey: 'distant-retry', availableAt: new Date(61001) });
  f.wake({ idempotencyKey: 'invalid-date', availableAt: new Date(NaN) });
  expect(f.scheduled.map(item => item.delay)).toEqual([15000]);
  expect(f.calls).toEqual([]);
});
