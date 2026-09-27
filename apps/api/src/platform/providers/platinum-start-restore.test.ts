// KRTX-197: a session idle for more than a day could not wake.
//
// Platinum answers /start on an archived box with 202 {state:'unarchiving'}
// once its 45 s inline wait runs out, and does NOT boot the box when the
// restore lands: the caller must /start again. start() returned on the 202,
// so the second /start was never sent and the wake fence gave up at 90 s
// with start_timeout. Worse, the client's 20 s default timeout abandoned the
// /start before even that 202 arrived. Each case below scripts a fake Platinum
// and asserts the exact conversation start() holds with it.
import { afterEach, beforeEach, expect, mock, setSystemTime, test } from 'bun:test';
import { RUNTIME_RESTART_LEASE_MS } from '../../projects/session-lifecycle/runtime-restart-fence';
import {
  RUNTIME_WAKE_HARD_MS,
  RUNTIME_WAKE_LEASE_MS,
  isAmbiguousRuntimeStartError,
} from '../../projects/session-lifecycle/runtime-wake-fence';

mock.module('../../config', () => ({
  config: {
    PLATINUM_API_KEY: 'pt_test',
    PLATINUM_API_URL: 'https://platinum.example.test',
    KORTIX_URL: 'https://api.example.test',
    KORTIX_SANDBOX_AUTOSTOP_MINUTES: 15,
    PLATINUM_TEMPLATE: 'kortix-computer',
  },
  SANDBOX_VERSION: 'test-version',
}));
mock.module('../service-key', () => ({ serviceKeyForExternalId: async () => null }));
mock.module('../sandbox-frontend-url', () => ({
  sandboxFrontendBaseUrl: () => 'https://app.example.test',
}));

type Reply = { status: number; state: string } | 'timeout';
let starts: Reply[] = [];
let gets: Reply[] = [];
let events: string[] = [];
/** Fake time each GET costs, for the budget case. */
let getAdvancesMs = 0;

beforeEach(() => {
  events = [];
  getAdvancesMs = 0;
  let startCalls = 0;
  let getCalls = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const post = (init?.method ?? 'GET') === 'POST' && String(input).endsWith('/start');
    // The last scripted reply repeats once the script runs out.
    const reply = post
      ? starts[Math.min(startCalls++, starts.length - 1)]
      : gets[Math.min(getCalls++, gets.length - 1)];
    if (!reply) throw new Error('unscripted Platinum call');
    if (!post && getAdvancesMs) setSystemTime(new Date(Date.now() + getAdvancesMs));
    if (reply === 'timeout') {
      events.push('POST timeout');
      const error = new Error('The operation timed out.');
      error.name = 'TimeoutError';
      throw error;
    }
    events.push(post ? `POST ${reply.status}` : `GET ${reply.state}`);
    return new Response(JSON.stringify({ id: 'sbx_1', state: reply.state }), {
      status: reply.status,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as unknown as typeof fetch;
});
afterEach(() => setSystemTime());

const provider = async () => new (await import('./platinum')).PlatinumProvider();
const ok = (state: string) => ({ status: 200, state });
const restoring = { status: 202, state: 'unarchiving' };
const conflict = { status: 409, state: '' };

test('a box that starts directly takes one /start and no polling', async () => {
  starts = [ok('starting')];
  await (await provider()).start('sbx_1');
  expect(events).toEqual(['POST 200']);
});

test('a restore that outlives the inline wait gets its second /start when it lands', async () => {
  starts = [restoring, ok('starting')];
  gets = [ok('unarchiving'), ok('unarchiving'), ok('stopped')];
  await (await provider()).start('sbx_1');
  expect(events).toEqual([
    'POST 202',
    'GET unarchiving',
    'GET unarchiving',
    'GET stopped',
    'POST 200',
  ]);
}, 15_000);

test('a /start the client gave up on is followed through, not failed', async () => {
  // Platinum was still inside its inline wait when the call timed out; the
  // restore carries on server-side and needs its /start when it lands.
  starts = ['timeout', ok('starting')];
  gets = [ok('unarchiving'), ok('stopped')];
  await (await provider()).start('sbx_1');
  expect(events).toEqual(['POST timeout', 'GET unarchiving', 'GET stopped', 'POST 200']);
}, 15_000);

test('a restore rolled back to archived is asked for again', async () => {
  starts = [restoring, ok('starting')];
  gets = [ok('archived')];
  await (await provider()).start('sbx_1');
  expect(events).toEqual(['POST 202', 'GET archived', 'POST 200']);
}, 15_000);

test('a restore that fails hands the box back without another /start', async () => {
  starts = [restoring];
  gets = [ok('failed-start')];
  await (await provider()).start('sbx_1');
  expect(events).toEqual(['POST 202', 'GET failed-start']);
}, 15_000);

test('a restore another caller started is waited on, not hammered with /start', async () => {
  // Platinum answers a second /start during an unarchive with 409. Re-posting
  // at once only collects more 409s until the stop grace runs out.
  starts = [conflict, ok('starting')];
  gets = [ok('unarchiving'), ok('unarchiving'), ok('stopped')];
  await (await provider()).start('sbx_1');
  expect(events).toEqual([
    'POST 409',
    'GET unarchiving',
    'GET unarchiving',
    'GET stopped',
    'POST 200',
  ]);
}, 15_000);

test('losing the race to the post-restore /start still sees the box up', async () => {
  // Two waiters sat out the same restore; the other one's /start landed
  // first. Each poll costs 20 fake seconds, so the restore alone outlasts the
  // 30 s stop grace this /start began with.
  getAdvancesMs = 20_000;
  starts = [restoring, conflict];
  gets = [ok('unarchiving'), ok('stopped'), ok('starting'), ok('running')];
  await (await provider()).start('sbx_1');
  expect(events).toEqual([
    'POST 202',
    'GET unarchiving',
    'GET stopped',
    'POST 409',
    'GET starting',
    'GET running',
  ]);
}, 15_000);

test("a long restore renews the caller's lease as it goes, and a failed renewal is not fatal", async () => {
  // Each poll costs 20 fake seconds: renewals land on the first in-progress
  // read and then once per 30 s, at t = 20, 60 and 100 s.
  getAdvancesMs = 20_000;
  starts = [restoring, ok('starting')];
  gets = [...Array(5).fill(ok('unarchiving')), ok('stopped')];
  let renewals = 0;
  await (await provider()).start('sbx_1', {
    onProgress: async () => {
      renewals += 1;
      if (renewals === 1) throw new Error('lease write failed');
    },
  });
  expect(renewals).toBe(3);
  expect(events).toEqual([
    'POST 202',
    ...Array(5).fill('GET unarchiving'),
    'GET stopped',
    'POST 200',
  ]);
}, 15_000);

test('a restore that outlasts the budget fails the start outright', async () => {
  // Each poll costs 200 fake seconds, so the 8 min budget runs out on the third.
  getAdvancesMs = 200_000;
  starts = [restoring];
  gets = [ok('unarchiving')];
  const error = await (await provider()).start('sbx_1').then(
    () => null,
    (e: unknown) => e,
  );
  expect(String(error)).toContain('still restoring from archive');
  expect(events).toEqual(['POST 202', 'GET unarchiving', 'GET unarchiving', 'GET unarchiving']);
  // Not "ambiguous": the wake fails now instead of polling a box that cannot
  // boot on this call, and the next wake finds it restored.
  expect(isAmbiguousRuntimeStartError(error)).toBe(false);
}, 15_000);

test('the restore budget fits the wake, and renewals outpace every lease they keep', async () => {
  const { START_CALL_TIMEOUT_MS, START_PROGRESS_INTERVAL_MS, START_RESTORE_BUDGET_MS } =
    await import('./platinum');
  // start() plus one last /start, with the status loop's confirmation after.
  expect(START_RESTORE_BUDGET_MS + START_CALL_TIMEOUT_MS).toBeLessThan(RUNTIME_WAKE_HARD_MS);
  // At least two renewals per lease, so one lost write never lets it lapse.
  expect(START_PROGRESS_INTERVAL_MS * 2).toBeLessThan(RUNTIME_WAKE_LEASE_MS);
  expect(START_PROGRESS_INTERVAL_MS * 2).toBeLessThan(RUNTIME_RESTART_LEASE_MS);
});
