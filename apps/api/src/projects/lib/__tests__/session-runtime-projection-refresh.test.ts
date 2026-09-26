// refreshRuntimeProjection() must store the projection BEFORE it caches the
// daemon etag.
//
// The defect: `etags.set()` ran before `saveRuntimeProjection()`. When the
// store write failed the poisoned etag stayed cached, so every later refresh
// sent If-None-Match, got a 304, and returned `not_modified` without ever
// storing the document — the projection store was silently skipped until the
// daemon document changed.
//
// Mocks `../../shared/db`, `./session-runtime-transport` and
// `./session-runtime-projection` via `mock.module` — process-global in
// bun:test, so this file runs isolated (`bun test --isolate`, as CI does).
import { beforeEach, describe, expect, mock, test } from 'bun:test';

type StateResponse =
  | { ok: true; status: 200; doc: Record<string, unknown>; etag: string | null }
  | { ok: true; status: 304; etag: string | null }
  | { ok: false; reason: string; status: number | null };

let sandboxRows: Array<{ externalId: string | null; status: string }> = [
  { externalId: 'sbx-1', status: 'active' },
];

type StateCall = { ifNoneMatch: string | null };
let stateCalls: StateCall[] = [];
let stateResponses: StateResponse[] = [];
let saveCalls: Array<Record<string, unknown>> = [];
let saveError: Error | null = null;
let saveResult: 'stored' | 'ignored' = 'stored';

mock.module('../../../shared/db', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => sandboxRows,
        }),
      }),
    }),
  },
}));

mock.module('../session-runtime-transport', () => ({
  fetchRuntimeState: async (_target: unknown, options: { ifNoneMatch?: string | null } = {}) => {
    stateCalls.push({ ifNoneMatch: options.ifNoneMatch ?? null });
    const next = stateResponses.shift();
    if (!next) throw new Error('test: no scripted fetchRuntimeState response');
    return next;
  },
}));

mock.module('../session-runtime-projection', () => ({
  saveRuntimeProjection: async (input: Record<string, unknown>) => {
    saveCalls.push(input);
    if (saveError) throw saveError;
    return saveResult;
  },
}));

const { refreshRuntimeProjection, __resetRuntimeProjectionRefreshForTests } = await import(
  '../session-runtime-projection-refresh'
);

const TARGET = {
  sessionId: 'sess-1',
  projectId: 'proj-1',
  accountId: 'acct-1',
  userId: 'user-1',
};

const DOC = { epoch: 'e1', seq: 1, built_at: '2026-09-26T00:00:00.000Z' } as Record<
  string,
  unknown
>;

function state200(etag: string | null, doc: Record<string, unknown> = DOC): StateResponse {
  return { ok: true, status: 200, doc, etag };
}

beforeEach(() => {
  __resetRuntimeProjectionRefreshForTests();
  sandboxRows = [{ externalId: 'sbx-1', status: 'active' }];
  stateCalls = [];
  stateResponses = [];
  saveCalls = [];
  saveError = null;
  saveResult = 'stored';
});

describe('refreshRuntimeProjection etag ordering', () => {
  test('a failed store does not cache the etag: the next refresh re-fetches without If-None-Match', async () => {
    stateResponses = [state200('v1'), state200('v1'), { ok: true, status: 304, etag: 'v1' }];

    saveError = new Error('db write failed');
    const failed = await refreshRuntimeProjection(TARGET, { force: true });
    expect(failed).toEqual({ refreshed: false, reason: 'db write failed' });
    expect(saveCalls.length).toBe(1);

    // The failed write must not have left the etag cached.
    saveError = null;
    const retried = await refreshRuntimeProjection(TARGET, { force: true });
    expect(retried).toEqual({ refreshed: true, etag: 'v1', stored: 'stored' });

    // Call 1 (the failing one) had no prior etag; call 2 MUST re-fetch, not
    // send If-None-Match. caches the etag only after this successful store.
    expect(stateCalls.map((c) => c.ifNoneMatch)).toEqual([null, null]);

    // The successful store now caches the etag, so the next read 304-skips.
    const third = await refreshRuntimeProjection(TARGET, { force: true });
    expect(third).toEqual({ refreshed: false, reason: 'not_modified' });
    expect(stateCalls.map((c) => c.ifNoneMatch)).toEqual([null, null, 'v1']);
  });

  test('a successful store caches the etag for the next refresh', async () => {
    stateResponses = [state200('v7'), { ok: true, status: 304, etag: 'v7' }];

    const first = await refreshRuntimeProjection(TARGET, { force: true });
    expect(first).toEqual({ refreshed: true, etag: 'v7', stored: 'stored' });

    const second = await refreshRuntimeProjection(TARGET, { force: true });
    expect(second).toEqual({ refreshed: false, reason: 'not_modified' });
    expect(stateCalls.map((c) => c.ifNoneMatch)).toEqual([null, 'v7']);
  });

  test('an ignored store still caches the etag (the daemon document is current)', async () => {
    stateResponses = [state200('v9'), { ok: true, status: 304, etag: 'v9' }];
    saveResult = 'ignored';

    const first = await refreshRuntimeProjection(TARGET, { force: true });
    expect(first).toEqual({ refreshed: true, etag: 'v9', stored: 'ignored' });

    await refreshRuntimeProjection(TARGET, { force: true });
    expect(stateCalls.map((c) => c.ifNoneMatch)).toEqual([null, 'v9']);
  });

  test('a daemon document with no etag is never sent as If-None-Match', async () => {
    stateResponses = [state200(null), state200(null)];

    await refreshRuntimeProjection(TARGET, { force: true });
    await refreshRuntimeProjection(TARGET, { force: true });

    expect(stateCalls.map((c) => c.ifNoneMatch)).toEqual([null, null]);
  });

  test('a non-active sandbox never touches the transport or the store', async () => {
    sandboxRows = [{ externalId: 'sbx-1', status: 'stopped' }];
    const outcome = await refreshRuntimeProjection(TARGET, { force: true });
    expect(outcome).toEqual({ refreshed: false, reason: 'sandbox_stopped' });
    expect(stateCalls.length).toBe(0);
    expect(saveCalls.length).toBe(0);
  });
});
