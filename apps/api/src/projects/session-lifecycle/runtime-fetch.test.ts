// The daemon lists what its runtime serves in `GET /kortix/health`. The API
// reads the list once per sandbox per 5 minutes: `/start` hands it to the
// client, and the delivery reads the turn-verb capability from the same memo.
import { afterAll, beforeEach, expect, test } from 'bun:test';

import { __resetRuntimeTurnVerbsMemo, runtimeCapabilities, runtimeServesTurnVerbs } from './runtime-fetch';

const ORIGINAL_FETCH = globalThis.fetch;
const endpoint = async () => ({ url: 'https://daemon.test', headers: {} });
let health: () => Response;
let healthReads = 0;

beforeEach(() => {
  __resetRuntimeTurnVerbsMemo();
  healthReads = 0;
  health = () => Response.json({ capabilities: ['runtime.turns.v1', 'session.subagents'] });
  globalThis.fetch = (async () => {
    healthReads += 1;
    return health();
  }) as unknown as typeof fetch;
});
afterAll(() => {
  globalThis.fetch = ORIGINAL_FETCH;
});

test('the capability list is read once and serves both readers', async () => {
  expect(await runtimeCapabilities('ext-1', endpoint)).toEqual(['runtime.turns.v1', 'session.subagents']);
  expect(await runtimeServesTurnVerbs('ext-1', endpoint)).toBe(true);
  expect(await runtimeCapabilities('ext-1', endpoint)).toEqual(['runtime.turns.v1', 'session.subagents']);
  expect(healthReads).toBe(1);
});

test('a failed read answers unknown and is not kept', async () => {
  health = () => new Response(null, { status: 503 });
  expect(await runtimeCapabilities('ext-1', endpoint)).toBeNull();
  expect(await runtimeServesTurnVerbs('ext-1', endpoint)).toBe(false);
  health = () => Response.json({ capabilities: ['session.subagents'] });
  expect(await runtimeCapabilities('ext-1', endpoint)).toEqual(['session.subagents']);
  expect(healthReads).toBe(3);
});

test('a daemon that lists nothing serves nothing, and that answer is kept', async () => {
  health = () => Response.json({ status: 'ok' });
  expect(await runtimeCapabilities('ext-1', endpoint)).toEqual([]);
  expect(await runtimeServesTurnVerbs('ext-1', endpoint)).toBe(false);
  expect(healthReads).toBe(1);
});

test('no sandbox id, no read', async () => {
  expect(await runtimeCapabilities(undefined, endpoint)).toBeNull();
  expect(healthReads).toBe(0);
});
