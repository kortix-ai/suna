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
import {
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

test('a restore that outlasts the budget fails the start outright', async () => {
  // Each poll costs a fake minute, so the 150 s budget runs out on the third.
  getAdvancesMs = 60_000;
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

test('start() returns inside the session wake lease', async () => {
  // Past the lease, wake maintenance declares the wake dead and stops the box
  // the moment it boots: the restore budget plus one last /start must fit.
  const { START_CALL_TIMEOUT_MS, START_RESTORE_BUDGET_MS } = await import('./platinum');
  expect(START_RESTORE_BUDGET_MS + START_CALL_TIMEOUT_MS).toBeLessThan(RUNTIME_WAKE_LEASE_MS);
});
