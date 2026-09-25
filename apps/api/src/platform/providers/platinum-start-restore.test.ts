// KRTX-197: a session idle for more than a day could not wake.
//
// Platinum answers /start on an archived box with 202 {state:'unarchiving'}
// once its 45 s inline wait runs out, and does NOT boot the box when the
// restore lands: the caller must /start again. start() returned on the 202,
// so the second /start was never sent and the wake fence gave up at 90 s
// with start_timeout. Each case below scripts a fake Platinum and asserts how
// many /start calls the provider makes and where it stops.
import { beforeEach, expect, mock, test } from 'bun:test';

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
mock.module('../sandbox-frontend-url', () => ({ sandboxFrontendBaseUrl: () => 'https://app.example.test' }));

type Reply = { status: number; body: Record<string, unknown> };
let starts: Reply[] = [];
let gets: Reply[] = [];
let startCalls = 0;
let getCalls = 0;

beforeEach(() => {
  startCalls = 0;
  getCalls = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    let reply: Reply;
    if ((init?.method ?? 'GET') === 'POST' && url.endsWith('/start')) {
      reply = starts[Math.min(startCalls, starts.length - 1)]!;
      startCalls += 1;
    } else {
      reply = gets[Math.min(getCalls, gets.length - 1)]!;
      getCalls += 1;
    }
    return new Response(JSON.stringify(reply.body), {
      status: reply.status,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as unknown as typeof fetch;
});

const provider = async () => new (await import('./platinum')).PlatinumProvider();

test('a box that starts directly takes one /start and no polling', async () => {
  starts = [{ status: 200, body: { id: 'sbx_1', state: 'starting' } }];
  gets = [{ status: 200, body: { id: 'sbx_1', state: 'running' } }];
  await (await provider()).start('sbx_1');
  expect(startCalls).toBe(1);
  expect(getCalls).toBe(0);
});

test('a restore that outlives the inline wait gets its second /start when it lands', async () => {
  starts = [
    { status: 202, body: { id: 'sbx_1', state: 'unarchiving' } },
    { status: 200, body: { id: 'sbx_1', state: 'starting' } },
  ];
  gets = [
    { status: 200, body: { id: 'sbx_1', state: 'unarchiving' } },
    { status: 200, body: { id: 'sbx_1', state: 'unarchiving' } },
    { status: 200, body: { id: 'sbx_1', state: 'stopped' } },
  ];
  await (await provider()).start('sbx_1');
  expect(startCalls).toBe(2);
  expect(getCalls).toBe(3);
}, 15_000);

test('a restore rolled back to archived is asked for again', async () => {
  starts = [
    { status: 202, body: { id: 'sbx_1', state: 'unarchiving' } },
    { status: 200, body: { id: 'sbx_1', state: 'starting' } },
  ];
  gets = [{ status: 200, body: { id: 'sbx_1', state: 'archived' } }];
  await (await provider()).start('sbx_1');
  expect(startCalls).toBe(2);
}, 15_000);

test('a restore that fails hands the box back to the wake fence without another /start', async () => {
  starts = [{ status: 202, body: { id: 'sbx_1', state: 'unarchiving' } }];
  gets = [{ status: 200, body: { id: 'sbx_1', state: 'failed-start' } }];
  await (await provider()).start('sbx_1');
  expect(startCalls).toBe(1);
  expect(getCalls).toBe(1);
}, 15_000);
