import { beforeEach, describe, expect, test } from 'bun:test';

import {
  buildCreatePayload,
  fingerprintOf,
  isTransportFailure,
  messageFor,
  RETRY_DELAY_MS,
  runCreate,
  runCreateAttempt,
  runProvisionAttempt,
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
  type ProvisionPhase,
  type ProvisionProjectInput,
  type ProvisionStreamEvent,
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

  test('maps 502 to a retry hint, not the raw server text', () => {
    expect(messageFor(new ApiError('Bad Gateway', { status: 502 }))).toBe(
      'Could not create the workspace. Try again.',
    );
  });

  // This route's ONLY 503 is the managed-git-unavailable one
  // (`isManagedGitUnavailableError`, `ensure-first-project.ts`) — a server
  // configuration state, not a transient failure. Unlike 502, it must NOT
  // get the retry-hint message: nothing the user does changes the outcome.
  test('maps 503 to a server-config message distinct from the 502 retry hint', () => {
    const msg = messageFor(new ApiError('Service Unavailable', { status: 503 }));
    expect(msg).not.toBe('Could not create the workspace. Try again.');
    expect(msg).not.toContain('Try again');
    expect(msg).toBe(
      "Managed git isn't set up on this server. An admin needs to connect GitHub in Git settings before workspaces can be created.",
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
      // Unused by any test in THIS describe block — `runCreateAttempt` never
      // calls it — but required to satisfy `CreateWorkspaceClient`. Throwing
      // makes an accidental future call to it fail loudly instead of
      // resolving a project no test asked for.
      provisionProjectStream: async () => {
        throw new Error('provisionProjectStream should not be called by runCreateAttempt');
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
      // Default: the target account has no existing projects — this create
      // is treated as the account's first, so `shouldRunOnboarding` stays
      // `true` and the stamp never fires. Every test in THIS describe block
      // that doesn't care about onboarding gets that "first project" shape
      // for free; tests below that DO care override this explicitly.
      getExistingProjectCount: async () => 0,
      stampOnboardingComplete: async () => {},
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

  test('MANDATORY: on success, the key is cleared BEFORE cache priming, invalidation, the cookie write, the onboarding stamp, or navigation', async () => {
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
      // Forces `shouldRunOnboarding` to `false` (this is the account's
      // SECOND project) so the stamp step actually runs and takes its place
      // in the sequence below — with the default `noopClient` shape (count
      // 0) this step would be skipped entirely and could silently drift out
      // of order without failing this test.
      getExistingProjectCount: async () => 1,
      stampOnboardingComplete: async () => {
        order.push('stampOnboarding');
      },
    });

    // The exact sequence, not just "clearKey happened before navigate" —
    // a reorder among the other steps must fail this too. `stampOnboarding`
    // sits AFTER writeCookie and BEFORE navigate: see the placement comment
    // on the `stampOnboardingComplete` call in `runCreate` for why (it is a
    // fire-and-forget, non-blocking call, so its POSITION here reflects when
    // it is *kicked off*, not when it completes).
    expect(order).toEqual([
      'clearKey',
      'primeCache',
      'invalidate',
      'writeCookie',
      'stampOnboarding',
      'navigate',
    ]);
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
          // Unused here — this test exercises `runCreateAttempt`'s 409 retry,
          // not the streaming path — but required to satisfy
          // `CreateWorkspaceClient`.
          provisionProjectStream: async () => {
            throw new Error('provisionProjectStream should not be called by runCreateAttempt');
          },
          wait: async () => {},
        }),
      primeProjectCache: () => {},
      invalidateProjects: () => {},
      writeLastProjectId: () => {},
      navigate: () => {},
      now: () => 1_000,
      getExistingProjectCount: async () => 0,
      stampOnboardingComplete: async () => {},
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

  /**
   * The onboarding stamp (Task 20): after a successful create, if the target
   * account already had at least one project BEFORE this one,
   * `stampOnboardingComplete` marks the new project onboarded so
   * `ProjectOnboardingWizard`'s own self-gate (`metadata.
   * onboarding_completed_at`) skips it. First project in an account -> wizard
   * runs. Every later one -> straight into the workspace.
   *
   * Nested inside the parent describe (not a sibling) so it shares the
   * `beforeEach` that installs the fake `localStorage` — `noopClient()`'s
   * `attemptKeyFor`/`clearAttemptKey` are the REAL functions from
   * `create-workspace-key.ts` and need it, same as every other test above.
   */
  describe('onboarding stamp gate', () => {
    test('MANDATORY: reads the existing-project count BEFORE creating — never derives it from the just-created project', async () => {
      const order: string[] = [];

      await runCreate(
        { ...INITIAL_FORM_STATE, name: 'x', accountId: 'acct-owner' },
        [OWNER_ACCOUNT],
        'user-1',
        {
          attemptKeyFor,
          clearAttemptKey,
          primeProjectCache: () => {},
          invalidateProjects: () => {},
          writeLastProjectId: () => {},
          navigate: () => {},
          now: () => 1_000,
          stampOnboardingComplete: async () => {},
          getExistingProjectCount: async (accountId) => {
            order.push(`count:${accountId}`);
            return 1;
          },
          runCreateAttempt: async () => {
            order.push('create');
            return fakeProject('created-count-order');
          },
        },
      );

      // If this ever reads `2 | ['count:acct-owner', 'create']` reversed, the
      // count was derived AFTER the create — exactly the bug the brief warns
      // about: reading it post-create would always see at least the project
      // that was just made, and `shouldRunOnboarding` would never see 0 again.
      expect(order).toEqual(['count:acct-owner', 'create']);
    });

    test('stamps onboarding complete when the target account already has a project — NOT the first workspace', async () => {
      const stamped: string[] = [];

      const result = await runCreate(
        { ...INITIAL_FORM_STATE, name: 'x', accountId: 'acct-owner' },
        [OWNER_ACCOUNT],
        'user-1',
        {
          ...noopClient(),
          getExistingProjectCount: async () => 1,
          runCreateAttempt: async () => fakeProject('created-second'),
          stampOnboardingComplete: async (projectId) => {
            stamped.push(projectId);
          },
        },
      );

      expect(result.ok).toBe(true);
      expect(stamped).toEqual(['created-second']);
    });

    test("does NOT stamp onboarding complete for an account's first workspace — the wizard should still run", async () => {
      const stamped: string[] = [];

      await runCreate(
        { ...INITIAL_FORM_STATE, name: 'x', accountId: 'acct-owner' },
        [OWNER_ACCOUNT],
        'user-1',
        {
          ...noopClient(),
          getExistingProjectCount: async () => 0,
          runCreateAttempt: async () => fakeProject('created-first'),
          stampOnboardingComplete: async (projectId) => {
            stamped.push(projectId);
          },
        },
      );

      expect(stamped).toEqual([]);
    });

    test('MANDATORY: a failed stamp does not fail the create or block navigation — the workspace already exists', async () => {
      const navigated: string[] = [];
      const stampError = new Error('PATCH /projects/:id/onboarding failed');

      const result = await runCreate(
        { ...INITIAL_FORM_STATE, name: 'x', accountId: 'acct-owner' },
        [OWNER_ACCOUNT],
        'user-1',
        {
          ...noopClient(),
          getExistingProjectCount: async () => 1,
          runCreateAttempt: async () => fakeProject('created-stamp-fail'),
          stampOnboardingComplete: async () => {
            throw stampError;
          },
          navigate: (path) => navigated.push(path),
        },
      );

      expect(result.ok).toBe(true);
      expect(navigated).toEqual(['/projects/created-stamp-fail']);
    });

    test('MANDATORY: a failed stamp is swallowed and logged, never left as an unhandled rejection', async () => {
      const originalError = console.error;
      const errorCalls: unknown[][] = [];
      console.error = (...args: unknown[]) => {
        errorCalls.push(args);
      };
      const stampError = new Error('PATCH /projects/:id/onboarding failed');

      try {
        const result = await runCreate(
          { ...INITIAL_FORM_STATE, name: 'x', accountId: 'acct-owner' },
          [OWNER_ACCOUNT],
          'user-1',
          {
            ...noopClient(),
            getExistingProjectCount: async () => 1,
            runCreateAttempt: async () => fakeProject('created-stamp-log'),
            stampOnboardingComplete: async () => {
              throw stampError;
            },
          },
        );

        // The stamp is fire-and-forget (not awaited by `runCreate`), so its
        // rejection is handled on a later microtask than `runCreate`'s own
        // return. A macrotask boundary guarantees every pending microtask —
        // including the `.catch` this proves exists — has run.
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(result.ok).toBe(true);
        // This is the assertion that actually distinguishes "swallowed and
        // logged" from "swallowed and silently dropped": if `runCreate` ever
        // stops attaching a `.catch` (or stops logging), this goes to 0 while
        // `result.ok` above would still (wrongly) look fine.
        expect(errorCalls.length).toBeGreaterThan(0);
      } finally {
        console.error = originalError;
      }
    });

    test('a failed existing-project-count read falls back to "first project" (0) rather than throwing out of runCreate', async () => {
      const stamped: string[] = [];
      const navigated: string[] = [];

      const result = await runCreate(
        { ...INITIAL_FORM_STATE, name: 'x', accountId: 'acct-owner' },
        [OWNER_ACCOUNT],
        'user-1',
        {
          ...noopClient(),
          getExistingProjectCount: async () => {
            throw new Error('count fetch failed');
          },
          runCreateAttempt: async () => fakeProject('created-count-fail'),
          stampOnboardingComplete: async (projectId) => {
            stamped.push(projectId);
          },
          navigate: (path) => navigated.push(path),
        },
      );

      // Falls back to today's shipped default (wizard runs) — NOT to "skip
      // the wizard", which would be the more surprising failure mode for a
      // user who has never seen it before. The create itself must still
      // succeed and still navigate: a count-read failure is no more allowed
      // to break the create than a stamp failure is.
      expect(stamped).toEqual([]);
      expect(result.ok).toBe(true);
      expect(navigated).toEqual(['/projects/created-count-fail']);
    });
  });
});

/**
 * `isTransportFailure` is the ONLY signal `runProvisionAttempt` (below) is
 * allowed to use to decide the fallback is safe, and only in combination with
 * "zero events received". It must recognize exactly the transport-shaped
 * failures `provisionProjectStream`'s own doc comment
 * (`packages/sdk/src/core/rest/projects-client/projects.ts`) names — no
 * `response.body` (React Native), the stream route 404ing (an old server
 * build), and a raw network failure — and MUST NOT recognize a real server
 * rejection, even one that (like a transport failure) arrives before any
 * `onEvent` call.
 */
describe('isTransportFailure', () => {
  test('a raw network failure (fetch itself never got a response) is transport-shaped', () => {
    // Every fetch implementation (browser, undici/Node, Bun) throws a
    // TypeError, never a plain Error, when the request never reaches a
    // server — this IS the discriminator, not a message-string guess.
    expect(isTransportFailure(new TypeError('fetch failed'))).toBe(true);
    expect(isTransportFailure(new TypeError('Failed to fetch'))).toBe(true);
  });

  test('no response.body (the React Native case) is transport-shaped', () => {
    expect(
      isTransportFailure(new Error('Provision stream is unavailable on this runtime (no response body)')),
    ).toBe(true);
  });

  test('the stream route 404ing (an old server build without it) is transport-shaped', () => {
    expect(isTransportFailure(new Error('Provision failed: HTTP 404'))).toBe(true);
  });

  test('MANDATORY: a real pre-stream authorization denial is NOT transport-shaped', () => {
    // `provisionProjectStream` rejects a 403 the same way it rejects a
    // non-transport HTTP status — a plain `Error` carrying the SERVER's own
    // message, no `HTTP 404`, no "no response body", not a `TypeError`. This
    // is the exact shape that must NOT trigger the fallback: retrying it as
    // `provisionProject` would be pointless (same rejection) and, if the
    // classifier were as loose as "any zero-event failure", would blur the
    // line between "the stream is unavailable" and "the server said no".
    expect(isTransportFailure(new Error('Owner or admin role required'))).toBe(false);
  });

  test('MANDATORY: a real in-stream provisioning failure (ApiError with a status) is NOT transport-shaped', () => {
    expect(isTransportFailure(new ApiError('Bad Gateway', { status: 502 }))).toBe(false);
  });

  test('a non-Error throw is NOT transport-shaped', () => {
    expect(isTransportFailure('not even an Error')).toBe(false);
    expect(isTransportFailure(undefined)).toBe(false);
  });
});

/**
 * `runProvisionAttempt` is the fallback gate itself: try
 * `provisionProjectStream`; fall back to the plain `provisionProject` — via
 * `runCreateAttempt`, so the fallback keeps that function's own 409
 * `provision_in_flight` retry — ONLY when the stream never delivered a single
 * event AND the failure is transport-shaped. Any other failure rethrows
 * unchanged.
 *
 * The danger this gate exists to prevent: falling back after the stream
 * already did real work would run `POST /projects/provision` a SECOND time
 * for the same user intent, minting a second upstream managed repo. So the
 * two halves below are both MANDATORY, and deliberately adversarial to each
 * other — one proves an event must block the fallback even when the error
 * that follows LOOKS like a transport failure; the other proves a qualifying
 * transport failure with zero events actually falls back.
 */
describe('runProvisionAttempt', () => {
  function streamClient(overrides: Partial<CreateWorkspaceClient> = {}): CreateWorkspaceClient & {
    plainCalls: ProvisionProjectInput[];
    waits: number[];
  } {
    const plainCalls: ProvisionProjectInput[] = [];
    const waits: number[] = [];
    return {
      provisionProjectStream: async () => {
        throw new Error('this test must override provisionProjectStream');
      },
      provisionProject: async (input) => {
        plainCalls.push(input);
        return fakeProject('created-fallback');
      },
      wait: async (ms) => {
        waits.push(ms);
      },
      plainCalls,
      waits,
      ...overrides,
    };
  }

  test('the stream succeeds — resolves with its project, reports every phase, never touches provisionProject', async () => {
    const seenPhases: (ProvisionPhase | null)[] = [];
    const client = streamClient({
      provisionProjectStream: async (_input, onEvent) => {
        const events: ProvisionStreamEvent[] = [
          { type: 'phase', phase: 'validating' },
          { type: 'phase', phase: 'creating_repository' },
        ];
        for (const event of events) onEvent(event);
        return fakeProject('created-stream');
      },
    });

    const project = await runProvisionAttempt({ name: 'x', idempotency_key: 'key-1' }, (phase) => {
      seenPhases.push(phase);
    }, client);

    expect(project.project_id).toBe('created-stream');
    expect(seenPhases).toEqual(['validating', 'creating_repository']);
    expect(client.plainCalls).toEqual([]);
  });

  test('MANDATORY: an event fired, THEN the stream fails — rethrows the real failure and NEVER falls back', async () => {
    const err = new Error('Provision stream ended without a result');
    const client = streamClient({
      provisionProjectStream: async (_input, onEvent) => {
        // The stream delivered real progress before dying — a genuine
        // provisioning failure, not an unreached server.
        onEvent({ type: 'phase', phase: 'validating' });
        throw err;
      },
    });

    await expect(
      runProvisionAttempt({ name: 'x', idempotency_key: 'key-1' }, () => {}, client),
    ).rejects.toBe(err);
    expect(client.plainCalls).toEqual([]);
  });

  test('MANDATORY: an event fired via the terminal error frame itself still blocks the fallback', async () => {
    // The in-stream `error` event IS an `onEvent` call before
    // `provisionProjectStream` throws — even a failure on the very first
    // frame must not fall back, because the stream demonstrably reached the
    // server.
    const err = new Error('Owner or admin role required');
    const client = streamClient({
      provisionProjectStream: async (_input, onEvent) => {
        onEvent({ type: 'error', error: 'Owner or admin role required' });
        throw err;
      },
    });

    await expect(
      runProvisionAttempt({ name: 'x', idempotency_key: 'key-1' }, () => {}, client),
    ).rejects.toBe(err);
    expect(client.plainCalls).toEqual([]);
  });

  test('MANDATORY: zero events AND a transport-shaped failure — falls back to provisionProject with the SAME idempotency_key', async () => {
    const payload: ProvisionProjectInput = { name: 'suna-web', idempotency_key: 'stream-key-1' };
    const seenPhases: (ProvisionPhase | null)[] = [];
    const client = streamClient({
      provisionProjectStream: async () => {
        throw new TypeError('fetch failed');
      },
    });

    const project = await runProvisionAttempt(payload, (phase) => seenPhases.push(phase), client);

    expect(project.project_id).toBe('created-fallback');
    expect(client.plainCalls).toHaveLength(1);
    // The exact idempotency_key the streaming attempt would have sent — the
    // fallback is the SAME attempt continuing on a different transport, not
    // a freshly minted one. A re-minted key here is exactly the "second
    // upstream repo" bug this whole gate exists to prevent.
    expect(client.plainCalls[0]?.idempotency_key).toBe('stream-key-1');
    expect(client.plainCalls[0]).toBe(payload);
    // The UI's phase readout is reset, not frozen on stale/absent progress —
    // there is no real phase information once the fallback takes over.
    expect(seenPhases).toEqual([null]);
  });

  test('MANDATORY: zero events but a NON-transport failure (a real pre-stream denial) — does NOT fall back', async () => {
    // This is what separates the real rule ("zero events AND
    // transport-shaped") from the looser, wrong one ("zero events implies
    // fall back"): a pre-stream 403 also fires zero events, but retrying it
    // through a second code path is not what this gate is for.
    const err = new Error('Owner or admin role required');
    const client = streamClient({
      provisionProjectStream: async () => {
        throw err;
      },
    });

    await expect(
      runProvisionAttempt({ name: 'x', idempotency_key: 'key-1' }, () => {}, client),
    ).rejects.toBe(err);
    expect(client.plainCalls).toEqual([]);
  });

  test('the fallback goes through runCreateAttempt — it keeps the 409 provision_in_flight retry', async () => {
    // Proves the fallback is not a bare `provisionProject` call: routing it
    // through `runCreateAttempt` means the plain-POST path keeps its full
    // existing resilience even when reached through the stream.
    let plainAttempts = 0;
    const client = streamClient({
      provisionProjectStream: async () => {
        throw new TypeError('fetch failed');
      },
      provisionProject: async (input) => {
        plainAttempts += 1;
        if (plainAttempts === 1) {
          throw new ApiError('in flight', { status: 409, code: PROVISION_IN_FLIGHT_CODE });
        }
        return fakeProject('created-after-retry');
      },
    });

    const project = await runProvisionAttempt(
      { name: 'x', idempotency_key: 'key-1' },
      () => {},
      client,
    );

    expect(project.project_id).toBe('created-after-retry');
    expect(plainAttempts).toBe(2);
    expect(client.waits).toEqual([RETRY_DELAY_MS[0]]);
  });
});
