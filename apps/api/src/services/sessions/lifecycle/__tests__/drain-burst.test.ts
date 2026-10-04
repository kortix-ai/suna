// The targeted drain's burst handling: the 250 ms wait and the sibling sweep
// run only where sends can race. Runs on its own under `--isolate`
// (`mock.module` is process-global in bun:test).
import { beforeEach, expect, mock, test } from 'bun:test';
import type { SessionLifecycleCommandRow } from '../store';

const realStore = await import('../store');
const realInboxRows = await import('../inbox-rows');

let claims: Array<{ idempotencyKey?: string }> = [];
let sweeps: string[] = [];

/** An unsupported command type: the drain fails it without touching a sandbox. */
const row = {
  commandId: 'cmd-1',
  commandType: 'noop',
  sessionId: 'sess-1',
  attempts: 1,
  payload: {},
} as unknown as SessionLifecycleCommandRow;

mock.module('../store', () => ({
  ...realStore,
  claimDueLifecycleCommands: async (input: { idempotencyKey?: string }) => {
    claims.push(input);
    return [row];
  },
  markCommandFailed: async () => undefined,
}));
mock.module('../inbox-rows', () => ({
  ...realInboxRows,
  claimDueSessionInboxSiblings: async (input: { sessionId: string }) => {
    sweeps.push(input.sessionId);
    return [];
  },
}));
mock.module('../command-lease', () => ({
  LIFECYCLE_CLAIM_LOCK_MS: 300_000,
  withCommandLeaseHeartbeat: (_row: unknown, run: () => Promise<void>) => run(),
}));

const { drainSessionLifecycleQueue } = await import('../drain');

async function timed(input: Parameters<typeof drainSessionLifecycleQueue>[0]): Promise<number> {
  const startedAt = performance.now();
  await drainSessionLifecycleQueue(input);
  return performance.now() - startedAt;
}

beforeEach(() => {
  claims = [];
  sweeps = [];
});

test('a lone send is claimed at once: no burst wait, no sibling sweep', async () => {
  const elapsed = await timed({ idempotencyKey: 'prompt:sess-1:a', burst: false });
  expect(elapsed).toBeLessThan(200);
  expect(claims).toHaveLength(1);
  expect(sweeps).toEqual([]);
});

test('a possible burst waits for the stragglers and sweeps the session', async () => {
  const elapsed = await timed({ idempotencyKey: 'prompt:sess-1:b', burst: true });
  expect(elapsed).toBeGreaterThanOrEqual(240);
  expect(sweeps).toEqual(['sess-1']);
});

test('a caller that says nothing keeps the wait and the sweep', async () => {
  const elapsed = await timed({ idempotencyKey: 'prompt:sess-1:c' });
  expect(elapsed).toBeGreaterThanOrEqual(240);
  expect(sweeps).toEqual(['sess-1']);
});

test('a completion wake skips the wait and still sweeps', async () => {
  const elapsed = await timed({ idempotencyKey: 'prompt:sess-1:d', coalesce: false });
  expect(elapsed).toBeLessThan(200);
  expect(sweeps).toEqual(['sess-1']);
});
