import { beforeEach, describe, expect, test } from 'bun:test';

import {
  buildCreatePayload,
  fingerprintOf,
  messageFor,
  RETRY_DELAY_MS,
  runCreate,
  runCreateAttempt,
  type CreateOrchestrationClient,
  type CreateWorkspaceClient,
} from './use-create-workspace';
import { attemptKeyFor, clearAttemptKey } from './create-workspace-key';
import { INITIAL_FORM_STATE } from './new-workspace-form';
import {
  ApiError,
  PROVISION_IN_FLIGHT_CODE,
  type KortixAccount,
  type KortixProject,
  type ProvisionProjectInput,
} from '@kortix/sdk';

const OWNER_ACCOUNT: KortixAccount = { account_id: 'acct-owner', name: 'Owner Co', account_role: 'owner' };

function fakeProject(id: string, accountId = 'acct-owner'): KortixProject {
  return {
    project_id: id,
    account_id: accountId,
    name: 'suna-web',
    repo_url: 'https://example.test/repo.git',
    default_branch: 'main',
    manifest_path: 'kortix.yaml',
    status: 'active',
    metadata: {},
    last_opened_at: null,
    created_at: '2026-08-06T00:00:00.000Z',
    updated_at: '2026-08-06T00:00:00.000Z',
  } as unknown as KortixProject;
}

function inFlightError(): ApiError {
  return new ApiError('Another provision with this idempotency_key is in flight', {
    status: 409,
    code: PROVISION_IN_FLIGHT_CODE,
  });
}

describe('fingerprintOf', () => {
  test('is stable for the exact same identity fields', () => {
    const state = { ...INITIAL_FORM_STATE, name: 'suna-web', accountId: 'a1' };
    expect(fingerprintOf(state)).toBe(fingerprintOf({ ...state }));
  });

  test('changes when the name changes', () => {
    const a = fingerprintOf({ ...INITIAL_FORM_STATE, name: 'suna-web' });
    const b = fingerprintOf({ ...INITIAL_FORM_STATE, name: 'kortix-api' });
    expect(a).not.toBe(b);
  });

  test('changes when the account changes', () => {
    const a = fingerprintOf({ ...INITIAL_FORM_STATE, name: 'x', accountId: 'a1' });
    const b = fingerprintOf({ ...INITIAL_FORM_STATE, name: 'x', accountId: 'a2' });
    expect(a).not.toBe(b);
  });

  test('changes when the template changes', () => {
    const a = fingerprintOf({ ...INITIAL_FORM_STATE, name: 'x', templateId: 't1' });
    const b = fingerprintOf({ ...INITIAL_FORM_STATE, name: 'x', templateId: 't2' });
    expect(a).not.toBe(b);
  });

  test('does NOT change when only the icon or default branch changes — those are refinements, not a new create', () => {
    const a = fingerprintOf({ ...INITIAL_FORM_STATE, name: 'x', defaultBranch: 'main' });
    const b = fingerprintOf({ ...INITIAL_FORM_STATE, name: 'x', defaultBranch: 'develop' });
    expect(a).toBe(b);
  });
});

describe('buildCreatePayload: account_id is always sent explicitly', () => {
  test('MANDATORY: falls back to the first creatable account when the picker is hidden (state.accountId is null)', () => {
    // This is the exact scenario `resolveAccountId`
    // (apps/api/src/shared/resolve-account.ts:117-129) gets wrong if account_id
    // is omitted: it picks the EARLIEST-JOINED membership with NO role check,
    // which can be a DIFFERENT account than the single creatable one the
    // picker hid. Omitting account_id here would 403.
    const payload = buildCreatePayload(
      { ...INITIAL_FORM_STATE, name: 'suna-web', accountId: null },
      [OWNER_ACCOUNT],
      'key-1',
    );
    expect(payload.account_id).toBe('acct-owner');
  });

  test('prefers the explicitly picked account over the creatableAccounts fallback', () => {
    const payload = buildCreatePayload(
      { ...INITIAL_FORM_STATE, name: 'suna-web', accountId: 'acct-picked' },
      [OWNER_ACCOUNT],
      'key-1',
    );
    expect(payload.account_id).toBe('acct-picked');
  });

  test('always carries the passed idempotency_key', () => {
    const payload = buildCreatePayload({ ...INITIAL_FORM_STATE, name: 'x' }, [OWNER_ACCOUNT], 'the-key');
    expect(payload.idempotency_key).toBe('the-key');
  });

  test('still delegates name-trimming and seed_starter to buildProvisionPayload', () => {
    const payload = buildCreatePayload(
      { ...INITIAL_FORM_STATE, name: '  suna-web  ' },
      [OWNER_ACCOUNT],
      'key-1',
    );
    expect(payload.name).toBe('suna-web');
    expect(payload.seed_starter).toBe(true);
  });
});

describe('messageFor', () => {
  test('maps a 403 to an owner/admin explanation', () => {
    const err = new ApiError('Owner or admin role required', { status: 403 });
    expect(messageFor(err)).toBe(
      'You need owner or admin access in this account to create a workspace.',
    );
  });

  test('surfaces the server message for a 400', () => {
    const err = new ApiError('Name must be 1-64 characters', { status: 400 });
    expect(messageFor(err)).toBe('Name must be 1-64 characters');
  });

  test('falls back to a generic message for a 400 with no message text', () => {
    const err = new ApiError('', { status: 400 });
    expect(messageFor(err)).toBe('Check the workspace name and try again.');
  });

  test('maps 502/503 to a retry hint, not the raw server text', () => {
    expect(messageFor(new ApiError('Bad Gateway', { status: 502 }))).toBe(
      'Could not create the workspace. Try again.',
    );
    expect(messageFor(new ApiError('Service Unavailable', { status: 503 }))).toBe(
      'Could not create the workspace. Try again.',
    );
  });

  test('falls back to the plain Error message for an unrecognized status', () => {
    expect(messageFor(new Error('network error'))).toBe('network error');
  });

  test('falls back to the generic message for a non-Error throw', () => {
    expect(messageFor('not even an Error')).toBe('Could not create the workspace. Try again.');
  });
});

describe('runCreateAttempt', () => {
  function client(overrides: Partial<CreateWorkspaceClient> = {}): CreateWorkspaceClient & {
    calls: unknown[];
    waits: number[];
  } {
    const calls: unknown[] = [];
    const waits: number[] = [];
    return {
      provisionProject: async (input) => {
        calls.push(input);
        return fakeProject('created-1');
      },
      wait: async (ms) => {
        waits.push(ms);
      },
      calls,
      waits,
      ...overrides,
    };
  }

  test('succeeds on the first try — no retry, no wait', async () => {
    const c = client();
    const project = await runCreateAttempt(
      { name: 'x', idempotency_key: 'key-1' },
      c,
    );
    expect(project.project_id).toBe('created-1');
    expect(c.calls).toHaveLength(1);
    expect(c.waits).toEqual([]);
  });

  test('retries once on provision_in_flight, then succeeds', async () => {
    let attempt = 0;
    const c = client({
      provisionProject: async (input) => {
        attempt += 1;
        c.calls.push(input);
        if (attempt === 1) throw inFlightError();
        return fakeProject('created-2');
      },
    });

    const project = await runCreateAttempt({ name: 'x', idempotency_key: 'key-1' }, c);
    expect(project.project_id).toBe('created-2');
    expect(c.calls).toHaveLength(2);
    expect(c.waits).toEqual([RETRY_DELAY_MS[0]]);
  });

  test('exhausts the full retry budget then rejects with the last error', async () => {
    const err = inFlightError();
    const c = client({
      provisionProject: async (input) => {
        c.calls.push(input);
        throw err;
      },
    });

    await expect(runCreateAttempt({ name: 'x', idempotency_key: 'key-1' }, c)).rejects.toBe(err);
    // RETRY_DELAY_MS.length retries => RETRY_DELAY_MS.length + 1 total calls.
    expect(c.calls).toHaveLength(RETRY_DELAY_MS.length + 1);
    expect(c.waits).toEqual(RETRY_DELAY_MS);
  });

  test('does NOT retry a non-in-flight error (e.g. 403) — fails immediately', async () => {
    const err = new ApiError('Owner or admin role required', { status: 403 });
    const c = client({
      provisionProject: async (input) => {
        c.calls.push(input);
        throw err;
      },
    });

    await expect(runCreateAttempt({ name: 'x', idempotency_key: 'key-1' }, c)).rejects.toBe(err);
    expect(c.calls).toHaveLength(1);
    expect(c.waits).toEqual([]);
  });

  test('every retry of one attempt sends the IDENTICAL idempotency_key — never re-minted mid-retry', async () => {
    let attempt = 0;
    const c = client({
      provisionProject: async (input) => {
        attempt += 1;
        c.calls.push(input);
        if (attempt < 3) throw inFlightError();
        return fakeProject('created-3');
      },
    });

    await runCreateAttempt({ name: 'x', idempotency_key: 'stable-key' }, c);
    expect(c.calls).toHaveLength(3);
    for (const call of c.calls) {
      expect((call as { idempotency_key: string }).idempotency_key).toBe('stable-key');
    }
  });
});

/**
 * `runCreate` is the full sequence `create()` actually runs: mint/reuse the
 * key -> provision -> on success, clear the key -> prime the cache ->
 * invalidate -> write the cookie -> navigate. `runCreateAttempt` above only
 * covers the provision sub-step; NONE of those tests would fail if a future
 * edit dropped `clearAttemptKey`, or moved it after `navigate` — a stale key
 * left behind is exactly what lets a later create with the same name
 * silently return the OLD project instead of making a new one.
 *
 * Every seam is injected (`CreateOrchestrationClient`), never
 * `mock.module('@kortix/sdk', ...)` — process-wide in this monorepo and a
 * hazard for sibling suites. `attemptKeyFor`/`clearAttemptKey` are the REAL
 * functions from `create-workspace-key.ts` (with a fake `localStorage`
 * installed, same pattern as that module's own test), not spies — so "the
 * key was cleared" is proven by the key's own persistence behaviour
 * changing, not by a mock recording a call that might not do anything.
 */
describe('runCreate: the full create() orchestration', () => {
  const store = new Map<string, string>();

  beforeEach(() => {
    store.clear();
    (globalThis as { localStorage?: Storage }).localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
      key: () => null,
      length: 0,
    } as Storage;
  });

  function noopClient(overrides: Partial<CreateOrchestrationClient> = {}): CreateOrchestrationClient {
    return {
      attemptKeyFor,
      clearAttemptKey,
      runCreateAttempt: async () => fakeProject('created'),
      primeProjectCache: () => {},
      invalidateProjects: () => {},
      writeLastProjectId: () => {},
      navigate: () => {},
      now: () => 1_000,
      ...overrides,
    };
  }

  test('MANDATORY: success clears the persisted key — a later call with the SAME fingerprint mints a genuinely different key', async () => {
    const state = { ...INITIAL_FORM_STATE, name: 'suna-web', accountId: 'acct-owner' };
    const fingerprint = fingerprintOf(state);
    const sentKeys: string[] = [];

    await runCreate(state, [OWNER_ACCOUNT], 'user-1', {
      ...noopClient(),
      runCreateAttempt: async (payload) => {
        sentKeys.push(payload.idempotency_key ?? '');
        return fakeProject('created-clear');
      },
    });

    expect(sentKeys).toHaveLength(1);
    // Still well within the 1h TTL — if the key survived, this would return
    // the SAME value instead of minting a fresh one.
    const nextKey = attemptKeyFor(fingerprint, 1_001);
    expect(nextKey).not.toBe(sentKeys[0]);
  });

  test('MANDATORY: on success, the key is cleared BEFORE cache priming, invalidation, the cookie write, or navigation', async () => {
    const order: string[] = [];
    const state = { ...INITIAL_FORM_STATE, name: 'suna-web', accountId: 'acct-owner' };

    await runCreate(state, [OWNER_ACCOUNT], 'user-1', {
      attemptKeyFor,
      clearAttemptKey: (fingerprint) => {
        order.push('clearKey');
        clearAttemptKey(fingerprint);
      },
      runCreateAttempt: async () => fakeProject('created-order'),
      primeProjectCache: () => order.push('primeCache'),
      invalidateProjects: () => order.push('invalidate'),
      writeLastProjectId: () => order.push('writeCookie'),
      navigate: () => order.push('navigate'),
      now: () => 1_000,
    });

    // The exact sequence, not just "clearKey happened before navigate" —
    // a reorder among the OTHER three steps must fail this too.
    expect(order).toEqual(['clearKey', 'primeCache', 'invalidate', 'writeCookie', 'navigate']);
  });

  test('a terminal failure preserves the key — a retry with the same state reuses it, not a fresh one', async () => {
    const state = { ...INITIAL_FORM_STATE, name: 'suna-web', accountId: 'acct-owner' };
    const err = new ApiError('Owner or admin role required', { status: 403 });
    const firstAttemptKeys: string[] = [];

    const first = await runCreate(state, [OWNER_ACCOUNT], 'user-1', {
      ...noopClient(),
      runCreateAttempt: async (payload) => {
        firstAttemptKeys.push(payload.idempotency_key ?? '');
        throw err;
      },
    });
    expect(first.ok).toBe(false);
    if (!first.ok) expect(first.error).toBe(err);

    // Retry: identical state, called again shortly after (still within TTL)
    // — must reuse the exact key the failed attempt sent, not mint a new one
    // (a fresh key here would mean a second upstream repo on retry).
    const retryKeys: string[] = [];
    await runCreate(state, [OWNER_ACCOUNT], 'user-1', {
      ...noopClient(),
      now: () => 1_500,
      runCreateAttempt: async (payload) => {
        retryKeys.push(payload.idempotency_key ?? '');
        return fakeProject('created-retry');
      },
    });

    expect(retryKeys[0]).toBe(firstAttemptKeys[0]);
  });

  test('409 retries inside runCreateAttempt reuse the SAME key — create() mints it exactly once', async () => {
    const state = { ...INITIAL_FORM_STATE, name: 'suna-web', accountId: 'acct-owner' };
    const mintCalls: Array<[string, number]> = [];
    let provisionCalls = 0;
    const idempotencyKeysSeen: string[] = [];

    const result = await runCreate(state, [OWNER_ACCOUNT], 'user-1', {
      attemptKeyFor: (fingerprint, now) => {
        mintCalls.push([fingerprint, now]);
        return attemptKeyFor(fingerprint, now);
      },
      clearAttemptKey,
      // Composes the REAL retry engine (already covered by its own suite
      // above) with a fake low-level provisionProject/wait, so this proves
      // genuine retry behaviour, not a restated assumption.
      runCreateAttempt: (payload) =>
        runCreateAttempt(payload, {
          provisionProject: async (input) => {
            provisionCalls += 1;
            idempotencyKeysSeen.push(input.idempotency_key ?? '');
            if (provisionCalls < 3) {
              throw new ApiError('in flight', { status: 409, code: PROVISION_IN_FLIGHT_CODE });
            }
            return fakeProject('created-retry-mint');
          },
          wait: async () => {},
        }),
      primeProjectCache: () => {},
      invalidateProjects: () => {},
      writeLastProjectId: () => {},
      navigate: () => {},
      now: () => 1_000,
    });

    expect(result.ok).toBe(true);
    expect(provisionCalls).toBe(3);
    // Three provision calls, but attemptKeyFor was invoked exactly once —
    // the mint happens in create()'s orchestration, retries happen beneath it.
    expect(mintCalls).toHaveLength(1);
    expect(new Set(idempotencyKeysSeen).size).toBe(1);
  });

  test('on success, writes the last-project cookie with the current user id and primes the cache for the account actually used', async () => {
    const project = fakeProject('created-cookie', 'acct-used');
    const primeCalls: Array<[string, KortixProject]> = [];
    const cookieCalls: Array<[string | null | undefined, string]> = [];

    await runCreate(
      { ...INITIAL_FORM_STATE, name: 'x', accountId: null },
      [{ ...OWNER_ACCOUNT, account_id: 'acct-used' }],
      'user-42',
      {
        ...noopClient(),
        runCreateAttempt: async () => project,
        primeProjectCache: (accountId, p) => primeCalls.push([accountId, p]),
        writeLastProjectId: (userId, projectId) => cookieCalls.push([userId, projectId]),
      },
    );

    expect(primeCalls).toEqual([['acct-used', project]]);
    expect(cookieCalls).toEqual([['user-42', 'created-cookie']]);
  });

  test('navigates to the created project on success', async () => {
    const navigated: string[] = [];
    await runCreate({ ...INITIAL_FORM_STATE, name: 'x', accountId: 'acct-owner' }, [OWNER_ACCOUNT], 'user-1', {
      ...noopClient(),
      runCreateAttempt: async () => fakeProject('created-nav'),
      navigate: (path) => navigated.push(path),
    });

    expect(navigated).toEqual(['/projects/created-nav']);
  });

  test('a non-retryable failure never touches the cache, the cookie, or navigation', async () => {
    const err = new ApiError('Bad Gateway', { status: 502 });
    const primeCalls: unknown[] = [];
    const cookieCalls: unknown[] = [];
    const navigated: string[] = [];

    const result = await runCreate(
      { ...INITIAL_FORM_STATE, name: 'x', accountId: 'acct-owner' },
      [OWNER_ACCOUNT],
      'user-1',
      {
        ...noopClient(),
        runCreateAttempt: async () => {
          throw err;
        },
        primeProjectCache: () => primeCalls.push('called'),
        writeLastProjectId: () => cookieCalls.push('called'),
        navigate: (path) => navigated.push(path),
      },
    );

    expect(result.ok).toBe(false);
    expect(primeCalls).toEqual([]);
    expect(cookieCalls).toEqual([]);
    expect(navigated).toEqual([]);
  });

  test('always resolves the account_id through buildCreatePayload — sends the fallback account even with no explicit pick', async () => {
    const sentPayloads: ProvisionProjectInput[] = [];
    await runCreate(
      { ...INITIAL_FORM_STATE, name: 'x', accountId: null },
      [OWNER_ACCOUNT],
      'user-1',
      {
        ...noopClient(),
        runCreateAttempt: async (payload) => {
          sentPayloads.push(payload);
          return fakeProject('created-account-id');
        },
      },
    );

    expect(sentPayloads[0]?.account_id).toBe('acct-owner');
  });
});
