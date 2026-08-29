import { beforeEach, describe, expect, test } from 'bun:test';

import {
  buildCreatePayload,
  fingerprintOf,
  isRetryableError,
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

  // ── Final-review FIX 1 ───────────────────────────────────────────────────
  //
  // Before FIX 1, `provisionProjectStream` threw a bare `Error` with no
  // `.status`/`.code` — so on the default streaming path, `status` here was
  // ALWAYS `undefined`, and a 409 fell through every named branch straight to
  // `return message || '...'`, surfacing the server's raw text (which names
  // `idempotency_key` verbatim — see `PROVISION_IN_FLIGHT_CODE`'s own doc
  // comment, `packages/sdk/.../api-client.ts`) directly to the user.

  test('FIX 1: maps a 409 provision_in_flight to a sanitized message — never the raw server text', () => {
    const err = new ApiError('Another provision with this idempotency_key is in flight', {
      status: 409,
      code: PROVISION_IN_FLIGHT_CODE,
    });
    const msg = messageFor(err);
    expect(msg).not.toContain('idempotency_key');
    expect(msg).toBe(
      'Another attempt to create this workspace is already in progress. Please wait a moment and try again.',
    );
  });

  // ── Final-review FIX 2 ───────────────────────────────────────────────────
  //
  // `messageFor`'s 403 branch used to fire for ANY 403, including
  // `enforceProjectQuota`'s `project_limit_reached` (`apps/api/src/projects/
  // lib/access.ts`) — telling a free-tier user (FREE_TIER_PROJECT_LIMIT = 1,
  // `ensureFirstProject` auto-provisions everyone's first project) they lack
  // permissions they actually have.

  test('FIX 2: maps a 403 project_limit_reached to the server\'s own quota message, not the owner/admin explanation', () => {
    const err = new ApiError(
      'Free accounts are limited to 1 project. Upgrade to a paid plan to create more.',
      { status: 403, code: 'project_limit_reached' },
    );
    const msg = messageFor(err);
    expect(msg).not.toBe('You need owner or admin access in this account to create a workspace.');
    expect(msg).toBe('Free accounts are limited to 1 project. Upgrade to a paid plan to create more.');
  });

  test('FIX 2: a plain 403 with no quota code still gets the owner/admin explanation', () => {
    const err = new ApiError('Owner or admin role required', { status: 403 });
    expect(messageFor(err)).toBe(
      'You need owner or admin access in this account to create a workspace.',
    );
  });
});

describe('isRetryableError: 409 provision_in_flight', () => {
  test('FIX 1: a 409 is retryable — the concurrent attempt is external state that can resolve before a later click', () => {
    const err = new ApiError('in flight', { status: 409, code: PROVISION_IN_FLIGHT_CODE });
    expect(isRetryableError(err)).toBe(true);
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
 * invalidate -> write the cookie -> enter onboarding. `runCreateAttempt`
 * above only covers the provision sub-step; NONE of those tests would fail
 * if a future edit dropped `clearAttemptKey`, or moved it after
 * `enterOnboarding` — a stale key left behind is exactly what lets a later
 * create with the same name silently return the OLD project instead of
 * making a new one.
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
      createGitHubRepoProject: async () => fakeProject('created-github'),
      importGitHubRepoProject: async () => fakeProject('imported-github'),
      primeProjectCache: () => {},
      invalidateProjects: () => {},
      writeLastProjectId: () => {},
      enterOnboarding: () => {},
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

  test('MANDATORY: on success, the key is cleared BEFORE cache priming, invalidation, the cookie write, or entering onboarding', async () => {
    const order: string[] = [];
    const state = { ...INITIAL_FORM_STATE, name: 'suna-web', accountId: 'acct-owner' };

    await runCreate(state, [OWNER_ACCOUNT], 'user-1', {
      attemptKeyFor,
      clearAttemptKey: (fingerprint) => {
        order.push('clearKey');
        clearAttemptKey(fingerprint);
      },
      runCreateAttempt: async () => fakeProject('created-order'),
      createGitHubRepoProject: async () => fakeProject('created-order'),
      importGitHubRepoProject: async () => fakeProject('created-order'),
      primeProjectCache: () => order.push('primeCache'),
      invalidateProjects: () => order.push('invalidate'),
      writeLastProjectId: () => order.push('writeCookie'),
      enterOnboarding: () => order.push('enterOnboarding'),
      now: () => 1_000,
    });

    // The exact sequence, not just "clearKey happened before enterOnboarding"
    // — a reorder among the other steps must fail this too.
    expect(order).toEqual([
      'clearKey',
      'primeCache',
      'invalidate',
      'writeCookie',
      'enterOnboarding',
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
      createGitHubRepoProject: async () => fakeProject('created-retry-mint'),
      importGitHubRepoProject: async () => fakeProject('created-retry-mint'),
      primeProjectCache: () => {},
      invalidateProjects: () => {},
      writeLastProjectId: () => {},
      enterOnboarding: () => {},
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

  test('enters onboarding on /new for the created project, and does not leave /new', async () => {
    const entered: string[] = [];
    const client = {
      ...noopClient(),
      runCreateAttempt: async () => fakeProject('created-nav'),
      enterOnboarding: (projectId: string) => entered.push(projectId),
    };
    await runCreate(
      { ...INITIAL_FORM_STATE, name: 'x', accountId: 'acct-owner' },
      [OWNER_ACCOUNT],
      'user-1',
      client,
    );
    expect(entered).toEqual(['created-nav']);
  });

  // A create must NOT stamp the new project onboarded — stamping is what made
  // the wizard render `null` on arrival. The guard against the stamping seam
  // coming back is `CreateOrchestrationClient` not declaring it, which `tsc`
  // enforces at every call site; this test proves the orchestration runs to
  // completion through the seams that client DOES declare.
  test('does not mark the new project onboarded', async () => {
    const client = { ...noopClient(), runCreateAttempt: async () => fakeProject('created') };
    const result = await runCreate(
      { ...INITIAL_FORM_STATE, name: 'x', accountId: 'acct-owner' },
      [OWNER_ACCOUNT],
      'user-1',
      client,
    );
    expect(result.ok).toBe(true);
  });

  test('a non-retryable failure never touches the cache, the cookie, or onboarding', async () => {
    const err = new ApiError('Bad Gateway', { status: 502 });
    const primeCalls: unknown[] = [];
    const cookieCalls: unknown[] = [];
    const entered: string[] = [];

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
        enterOnboarding: (projectId) => entered.push(projectId),
      },
    );

    expect(result.ok).toBe(false);
    expect(primeCalls).toEqual([]);
    expect(cookieCalls).toEqual([]);
    expect(entered).toEqual([]);
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
   * The two GitHub sources. Before this work `runCreate` had ONE network call
   * (`/projects/provision`) and the page refused to submit anything else, so
   * "Create in GitHub" and "Import from GitHub" were rendered `disabled`.
   * These tests pin the routing — which call each source makes, and what each
   * one is handed — because getting it wrong means creating a workspace
   * against the wrong upstream repository, which is not recoverable by a
   * retry.
   */
  test('github-create routes to create-repo, never to provision', async () => {
    const state = {
      ...INITIAL_FORM_STATE,
      name: "Ana's agents",
      accountId: 'acct-owner',
      source: 'github-create' as const,
      installationId: '84',
    };
    let provisionCalls = 0;
    const created: unknown[] = [];

    const result = await runCreate(state, [OWNER_ACCOUNT], 'user-1', {
      ...noopClient(),
      runCreateAttempt: async () => {
        provisionCalls += 1;
        return fakeProject('should-not-happen');
      },
      createGitHubRepoProject: async (payload) => {
        created.push(payload);
        return fakeProject('created-in-github');
      },
    });

    expect(result.ok).toBe(true);
    expect(provisionCalls).toBe(0);
    expect(created).toHaveLength(1);
    // The slug for GitHub, the typed name for the workspace.
    expect(created[0]).toMatchObject({
      name: 'Ana-s-agents',
      project_name: "Ana's agents",
      installation_id: '84',
      account_id: 'acct-owner',
    });
  });

  test('github-import routes to link-repository, never to provision', async () => {
    const state = {
      ...INITIAL_FORM_STATE,
      name: 'Portal',
      accountId: 'acct-owner',
      source: 'github-import' as const,
      installationId: '84',
      repoFullName: 'acme/portal',
      defaultBranch: 'trunk',
    };
    let provisionCalls = 0;
    const imported: unknown[] = [];

    const result = await runCreate(state, [OWNER_ACCOUNT], 'user-1', {
      ...noopClient(),
      runCreateAttempt: async () => {
        provisionCalls += 1;
        return fakeProject('should-not-happen');
      },
      importGitHubRepoProject: async (payload) => {
        imported.push(payload);
        return fakeProject('imported-from-github');
      },
    });

    expect(result.ok).toBe(true);
    expect(provisionCalls).toBe(0);
    expect(imported[0]).toMatchObject({
      repo_full_name: 'acme/portal',
      installation_id: '84',
      default_branch: 'trunk',
      account_id: 'acct-owner',
    });
  });

  test('a GitHub source mints no idempotency key — neither route accepts one', async () => {
    // A minted-but-never-sent key would persist for its full TTL and never be
    // cleared, so a LATER managed create with the same fingerprint would reuse
    // a key that no request ever carried.
    const state = {
      ...INITIAL_FORM_STATE,
      name: 'suna-web',
      accountId: 'acct-owner',
      source: 'github-create' as const,
      installationId: '84',
    };
    const mintCalls: string[] = [];

    await runCreate(state, [OWNER_ACCOUNT], 'user-1', {
      ...noopClient(),
      attemptKeyFor: (fingerprint, now) => {
        mintCalls.push(fingerprint);
        return attemptKeyFor(fingerprint, now);
      },
    });

    expect(mintCalls).toEqual([]);
  });

  test('every source runs the SAME success path — cache, invalidate, cookie, onboarding', async () => {
    // The routing differs; what happens after a project exists must not.
    for (const state of [
      { ...INITIAL_FORM_STATE, name: 'a', accountId: 'acct-owner', source: 'managed' as const },
      {
        ...INITIAL_FORM_STATE,
        name: 'b',
        accountId: 'acct-owner',
        source: 'github-create' as const,
        installationId: '84',
      },
      {
        ...INITIAL_FORM_STATE,
        name: 'c',
        accountId: 'acct-owner',
        source: 'github-import' as const,
        installationId: '84',
        repoFullName: 'acme/portal',
      },
    ]) {
      const order: string[] = [];
      const result = await runCreate(state, [OWNER_ACCOUNT], 'user-1', {
        ...noopClient(),
        primeProjectCache: () => order.push('primeCache'),
        invalidateProjects: () => order.push('invalidate'),
        writeLastProjectId: () => order.push('writeCookie'),
        enterOnboarding: () => order.push('enterOnboarding'),
      });
      expect(result.ok).toBe(true);
      expect(order).toEqual(['primeCache', 'invalidate', 'writeCookie', 'enterOnboarding']);
    }
  });

  test('a failed GitHub create surfaces the error like any other source', async () => {
    const err = new ApiError('Install the Kortix GitHub App before creating GitHub-backed projects', {
      status: 409,
    });
    const result = await runCreate(
      {
        ...INITIAL_FORM_STATE,
        name: 'suna-web',
        accountId: 'acct-owner',
        source: 'github-create' as const,
        installationId: '84',
      },
      [OWNER_ACCOUNT],
      'user-1',
      {
        ...noopClient(),
        createGitHubRepoProject: async () => {
          throw err;
        },
      },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe(err);
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

  // ── Final-review FIX 1, consequence 3 ────────────────────────────────────
  //
  // `emit('validating')` is the FIRST statement of `runProvision`
  // (`apps/api/src/projects/provision-core.ts`), so by the time a 409
  // `provision_in_flight` frame can possibly arrive, the stream has ALWAYS
  // already delivered at least one phase event. Under the plain
  // "any event blocks fallback" rule, that made the backoff retry
  // unreachable on the primary streaming path — the exact "409 backoff is
  // dead" finding from the final review.
  //
  // DECISION: a 409 provision_in_flight is not a genuine provisioning
  // failure the way a 502/503 is — by construction it means another attempt
  // carrying this SAME idempotency_key is already running. Replaying it
  // through `runCreateAttempt` (identical key) is exactly what that
  // function's own backoff loop is for, and it is safe regardless of
  // `eventsReceived`: the server either hands back the SAME project once the
  // in-flight attempt commits, or 409s again and the loop keeps waiting.
  // Nothing about "the stream did real work" makes that unsafe — unlike a
  // genuine 502/503/plain-error rethrow, this never risks a second upstream
  // repo.
  test('CONSEQUENCE 3: an in-band 409 provision_in_flight, even after a phase event fired, reaches the backoff retry via runCreateAttempt', async () => {
    let plainAttempts = 0;
    const client = streamClient({
      provisionProjectStream: async (_input, onEvent) => {
        // The real-world shape: `validating` always fires before any error
        // can possibly arrive, so `eventsReceived > 0` is always true here.
        onEvent({ type: 'phase', phase: 'validating' });
        onEvent({
          type: 'error',
          error: 'Another provision with this idempotency_key is in flight',
          code: PROVISION_IN_FLIGHT_CODE,
          status: 409,
        });
        throw new ApiError('Another provision with this idempotency_key is in flight', {
          status: 409,
          code: PROVISION_IN_FLIGHT_CODE,
        });
      },
      provisionProject: async (input) => {
        plainAttempts += 1;
        if (plainAttempts === 1) {
          throw new ApiError('in flight', { status: 409, code: PROVISION_IN_FLIGHT_CODE });
        }
        return fakeProject('created-after-inflight-retry');
      },
    });

    const project = await runProvisionAttempt(
      { name: 'x', idempotency_key: 'key-1' },
      () => {},
      client,
    );

    expect(project.project_id).toBe('created-after-inflight-retry');
    expect(plainAttempts).toBe(2);
    expect(client.waits).toEqual([RETRY_DELAY_MS[0]]);
  });

  test('CONSEQUENCE 3: a genuine post-event failure that is NOT provision_in_flight still never falls back', async () => {
    // Adversarial pair to the test above: proves the new escape hatch is
    // narrow — keyed on the code, not just "any error after events fired".
    const err = new ApiError('Bad Gateway', { status: 502 });
    const client = streamClient({
      provisionProjectStream: async (_input, onEvent) => {
        onEvent({ type: 'phase', phase: 'validating' });
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
