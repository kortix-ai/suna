import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

import type { KortixWorkspace, ProvisionWorkspaceInput } from '@kortix/sdk';

import type { EnsureFirstWorkspaceClient } from './ensure-first-workspace';

const provisionCalls: Array<Record<string, unknown>> = [];
let workspaces: Array<{ workspace_id: string; account_id: string; name: string }> = [];
let provisionError: Error | null = null;

mock.module('@kortix/sdk', () => ({
  listWorkspacesForAccount: async () => workspaces,
  provisionWorkspace: async (input: Record<string, unknown>) => {
    provisionCalls.push(input);
    if (provisionError) throw provisionError;
    const created = {
      workspace_id: '99999999-9999-4999-8999-999999999999',
      account_id: 'acct_1',
      name: 'My First Workspace',
    };
    workspaces = [created];
    return created;
  },
}));

const EXISTING = {
  workspace_id: '11111111-1111-4111-8111-111111111111',
  account_id: 'acct_1',
  name: 'Existing',
};
const OTHER = {
  workspace_id: '22222222-2222-4222-8222-222222222222',
  account_id: 'acct_1',
  name: 'Other',
};

describe('ensureFirstWorkspace provisioning', () => {
  beforeEach(() => {
    provisionCalls.length = 0;
    workspaces = [];
    provisionError = null;
  });

  test('provisions a starter workspace for an empty account', async () => {
    // Reverses the previous contract ("does not silently create a managed
    // repository"). Sign-up already provisioned a managed repo server-side, so
    // returning null here only ever produced a manual create-workspace step on
    // the path where the automatic one had failed.
    const { ensureFirstWorkspace } = await import('./ensure-first-workspace');

    await expect(ensureFirstWorkspace('acct_1')).resolves.toMatchObject({
      workspace_id: '99999999-9999-4999-8999-999999999999',
    });
    expect(provisionCalls).toHaveLength(1);
    expect(provisionCalls[0]).toMatchObject({
      account_id: 'acct_1',
      seed_starter: true,
      starter_template: 'general-knowledge-worker',
    });
    // Task 6: every provision attempt now carries a stable idempotency_key.
    expect(typeof provisionCalls[0].idempotency_key).toBe('string');
    expect((provisionCalls[0].idempotency_key as string).length).toBeGreaterThan(0);
  });

  test('never provisions when allowCreate is false', async () => {
    // The team-member (no PROJECT_CREATE) and just-deleted cases both land here.
    const { ensureFirstWorkspace } = await import('./ensure-first-workspace');

    await expect(ensureFirstWorkspace('acct_1', { allowCreate: false })).resolves.toBeNull();
    expect(provisionCalls).toEqual([]);
  });

  test('returns an existing workspace without provisioning', async () => {
    workspaces = [EXISTING];
    const { ensureFirstWorkspace } = await import('./ensure-first-workspace');

    await expect(ensureFirstWorkspace('acct_1')).resolves.toMatchObject({
      workspace_id: EXISTING.workspace_id,
    });
    expect(provisionCalls).toEqual([]);
  });

  test('opens the remembered workspace when the account has several', async () => {
    workspaces = [EXISTING, OTHER];
    const { ensureFirstWorkspace } = await import('./ensure-first-workspace');

    await expect(
      ensureFirstWorkspace('acct_1', { preferredWorkspaceId: OTHER.workspace_id }),
    ).resolves.toMatchObject({ workspace_id: OTHER.workspace_id });
    expect(provisionCalls).toEqual([]);
  });

  test('re-reads instead of failing when the workspace cap is already hit', async () => {
    // Losing a create race against another tab surfaces as project_limit_reached
    // while the account DOES now have a workspace. Erroring here would strand the
    // user on the landing door.
    provisionError = new Error('project_limit_reached');
    let call = 0;
    mock.module('@kortix/sdk', () => ({
      listWorkspacesForAccount: async () => (call++ === 0 ? [] : [EXISTING]),
      provisionWorkspace: async () => {
        throw new Error('project_limit_reached');
      },
    }));
    const { ensureFirstWorkspace } = await import('./ensure-first-workspace');

    await expect(ensureFirstWorkspace('acct_1')).resolves.toMatchObject({
      workspace_id: EXISTING.workspace_id,
    });
  });
});

describe('isManagedGitUnavailableError', () => {
  test('true for a 503-status error', async () => {
    const { isManagedGitUnavailableError } = await import('./ensure-first-workspace');
    const err = new Error('nope');
    (err as Error & { status: number }).status = 503;
    expect(isManagedGitUnavailableError(err)).toBe(true);
  });

  test('true for the not-configured message with no status', async () => {
    const { isManagedGitUnavailableError } = await import('./ensure-first-workspace');
    expect(
      isManagedGitUnavailableError(
        new Error('Managed git provider "github" is not configured on this server'),
      ),
    ).toBe(true);
  });

  test('false for an unrelated error', async () => {
    const { isManagedGitUnavailableError } = await import('./ensure-first-workspace');
    expect(isManagedGitUnavailableError(new Error('network error'))).toBe(false);
  });
});

describe('isProvisionInFlightError', () => {
  test('true for a 409 with code provision_in_flight', async () => {
    const { isProvisionInFlightError } = await import('./ensure-first-workspace');
    const err = Object.assign(new Error('Another provision with this idempotency_key is in flight'), {
      status: 409,
      code: 'provision_in_flight',
    });
    expect(isProvisionInFlightError(err)).toBe(true);
  });

  test('true for the message with no code (plain Error, status 409)', async () => {
    const { isProvisionInFlightError } = await import('./ensure-first-workspace');
    const err = Object.assign(
      new Error('Another provision with this idempotency_key is in flight'),
      { status: 409 },
    );
    expect(isProvisionInFlightError(err)).toBe(true);
  });

  test('false for an unrelated 409', async () => {
    const { isProvisionInFlightError } = await import('./ensure-first-workspace');
    const err = Object.assign(new Error('conflict'), { status: 409, code: 'some_other_conflict' });
    expect(isProvisionInFlightError(err)).toBe(false);
  });

  test('false for an unrelated error', async () => {
    const { isProvisionInFlightError } = await import('./ensure-first-workspace');
    expect(isProvisionInFlightError(new Error('network error'))).toBe(false);
  });
});

/**
 * Task 6: the client no longer re-POSTs /provision on retry. These tests
 * inject the network client as a parameter (see EnsureFirstWorkspaceClient in
 * ensure-first-workspace.ts) instead of `mock.module('@kortix/sdk', ...)` — the
 * `mock.module` hazard is process-wide in this monorepo and leaks into
 * sibling test suites, so real behaviour here is exercised with plain fakes,
 * not module mocking.
 *
 * The persisted idempotency key lives in `localStorage`, which bun's test
 * runner does not provide by default. Each test installs an in-memory fake
 * directly on `globalThis` (same pattern as
 * src/stores/message-queue-store.test.ts) and removes it afterward so it
 * cannot leak into other test files in the same process.
 */
describe('ensureFirstWorkspace retry safety with an injected client (Task 6)', () => {
  const ACCOUNT = 'acct_retry';
  const STORAGE_KEY = `kortix:onboarding-provision-key:${ACCOUNT}`;

  function fakeStorage(seed: Record<string, string> = {}) {
    const map = new Map(Object.entries(seed));
    return {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => {
        map.set(k, v);
      },
      removeItem: (k: string) => {
        map.delete(k);
      },
      clear: () => map.clear(),
      key: (i: number) => Array.from(map.keys())[i] ?? null,
      get length() {
        return map.size;
      },
    } as unknown as Storage;
  }

  function installStorage(storage: Storage | undefined) {
    (globalThis as { localStorage?: Storage }).localStorage = storage as Storage;
  }

  afterEach(() => {
    delete (globalThis as { localStorage?: Storage }).localStorage;
  });

  function fakeWorkspace(id: string): KortixWorkspace {
    return {
      workspace_id: id,
      account_id: ACCOUNT,
      name: 'My First Workspace',
    } as unknown as KortixWorkspace;
  }

  function inFlightError() {
    return Object.assign(
      new Error('Another provision with this idempotency_key is in flight'),
      { status: 409, code: 'provision_in_flight' },
    );
  }

  test('getOrCreateProvisionAttemptKey persists per account; clearProvisionAttemptKey resets it', async () => {
    installStorage(fakeStorage());
    const { getOrCreateProvisionAttemptKey, clearProvisionAttemptKey } = await import(
      './ensure-first-workspace'
    );

    const key1 = getOrCreateProvisionAttemptKey(ACCOUNT);
    // Same account, second read — reuses the persisted value.
    expect(getOrCreateProvisionAttemptKey(ACCOUNT)).toBe(key1);

    // A different account never shares the first account's key.
    expect(getOrCreateProvisionAttemptKey('acct_other')).not.toBe(key1);

    // Resolution clears it — a later, distinct attempt for the SAME account
    // mints a fresh key rather than replaying the settled one.
    clearProvisionAttemptKey(ACCOUNT);
    expect(getOrCreateProvisionAttemptKey(ACCOUNT)).not.toBe(key1);
  });

  test('without usable storage, a fresh key is minted per call (documented degradation)', async () => {
    installStorage(undefined);
    const { getOrCreateProvisionAttemptKey } = await import('./ensure-first-workspace');

    expect(getOrCreateProvisionAttemptKey(ACCOUNT)).not.toBe(
      getOrCreateProvisionAttemptKey(ACCOUNT),
    );
  });

  test('a retry whose list has not caught up yet sends the SAME idempotency_key both times', async () => {
    // Models a lost response mid-provision: the first call's POST is still
    // being processed (or its result is not yet client-visible), so the
    // retry's own list-first check is STILL empty and it has to POST again.
    // Client-side safety here means: send the identical key, so the
    // server-side dedupe (provision-idempotency.ts) — not this client — is
    // what stops the second POST from minting a second repo.
    installStorage(fakeStorage());
    const { ensureFirstWorkspace } = await import('./ensure-first-workspace');

    const keysSent: string[] = [];
    let call = 0;
    const client: EnsureFirstWorkspaceClient = {
      listWorkspacesForAccount: async () => [],
      provisionWorkspace: async (input) => {
        call += 1;
        keysSent.push(input.idempotency_key ?? '');
        if (call === 1) throw new Error('network error: response lost');
        return fakeWorkspace('created-1');
      },
    };

    await expect(ensureFirstWorkspace(ACCOUNT, {}, client)).rejects.toThrow('response lost');
    await expect(ensureFirstWorkspace(ACCOUNT, {}, client)).resolves.toMatchObject({
      workspace_id: 'created-1',
    });

    expect(keysSent).toHaveLength(2);
    expect(keysSent[0]).toBeTruthy();
    expect(keysSent[1]).toBe(keysSent[0]);
  });

  test('a lost-response retry resolves to the existing workspace and issues exactly one create call', async () => {
    installStorage(fakeStorage());
    const { ensureFirstWorkspace } = await import('./ensure-first-workspace');

    let created: KortixWorkspace | null = null;
    const provisionCalls: ProvisionWorkspaceInput[] = [];
    const client: EnsureFirstWorkspaceClient = {
      listWorkspacesForAccount: async () => (created ? [created] : []),
      provisionWorkspace: async (input) => {
        provisionCalls.push(input);
        created = fakeWorkspace('created-2');
        return created;
      },
    };

    const first = await ensureFirstWorkspace(ACCOUNT, {}, client);
    expect(first?.workspace_id).toBe('created-2');

    // The retry: a reload, or the OTHER entry point, calling ensureFirstWorkspace
    // again after the client lost the first call's response.
    const second = await ensureFirstWorkspace(ACCOUNT, {}, client);
    expect(second?.workspace_id).toBe('created-2');

    expect(provisionCalls).toHaveLength(1);
  });

  test('provision_in_flight (409) resolves to the concurrent winner once its row is visible', async () => {
    installStorage(fakeStorage());
    const { ensureFirstWorkspace } = await import('./ensure-first-workspace');

    const winner = fakeWorkspace('winner');
    let listCall = 0;
    const provisionCalls: ProvisionWorkspaceInput[] = [];
    const client: EnsureFirstWorkspaceClient = {
      listWorkspacesForAccount: async () => {
        listCall += 1;
        // Call 1 = the top-of-function check (still empty). Call 2 = the
        // re-check inside the catch, after the concurrent winner's row landed.
        return listCall === 1 ? [] : [winner];
      },
      provisionWorkspace: async (input) => {
        provisionCalls.push(input);
        throw inFlightError();
      },
    };

    await expect(ensureFirstWorkspace(ACCOUNT, {}, client)).resolves.toMatchObject({
      workspace_id: 'winner',
    });
    expect(provisionCalls).toHaveLength(1);
  });

  test('provision_in_flight (409) with no visible row yet re-throws so the caller can retry', async () => {
    // The row genuinely is not visible yet (the concurrent winner is still
    // mid-provision). This must NOT be swallowed as success and must NOT be
    // reported as an unrelated failure — it re-throws the SAME recognizable
    // error so the caller (start/page.tsx) can tell it apart from a real
    // failure and keep waiting, using the SAME persisted key on its retry.
    installStorage(fakeStorage());
    const { ensureFirstWorkspace, isProvisionInFlightError } = await import(
      './ensure-first-workspace'
    );

    const err = inFlightError();
    const client: EnsureFirstWorkspaceClient = {
      listWorkspacesForAccount: async () => [],
      provisionWorkspace: async () => {
        throw err;
      },
    };

    let caught: unknown;
    try {
      await ensureFirstWorkspace(ACCOUNT, {}, client);
    } catch (thrown) {
      caught = thrown;
    }
    expect(caught).toBe(err);
    expect(isProvisionInFlightError(caught)).toBe(true);
  });

  test('the existing isWorkspaceLimitError recovery still works with an injected client', async () => {
    installStorage(fakeStorage());
    const { ensureFirstWorkspace } = await import('./ensure-first-workspace');

    const existing = fakeWorkspace('limit-existing');
    let listCall = 0;
    const client: EnsureFirstWorkspaceClient = {
      listWorkspacesForAccount: async () => {
        listCall += 1;
        return listCall === 1 ? [] : [existing];
      },
      provisionWorkspace: async () => {
        throw new Error('project_limit_reached');
      },
    };

    await expect(ensureFirstWorkspace(ACCOUNT, {}, client)).resolves.toMatchObject({
      workspace_id: 'limit-existing',
    });
  });

  test('a successful create clears the persisted attempt key', async () => {
    installStorage(
      fakeStorage({
        [STORAGE_KEY]: JSON.stringify({
          key: 'stale-key-from-a-prior-attempt',
          mintedAt: Date.now(),
        }),
      }),
    );
    const { ensureFirstWorkspace } = await import('./ensure-first-workspace');

    const client: EnsureFirstWorkspaceClient = {
      listWorkspacesForAccount: async () => [],
      provisionWorkspace: async (input) => {
        // Proves the STALE key was reused (not discarded and re-minted) for
        // this retry of the same attempt, then cleared once it resolves.
        expect(input.idempotency_key).toBe('stale-key-from-a-prior-attempt');
        return fakeWorkspace('created-3');
      },
    };

    await ensureFirstWorkspace(ACCOUNT, {}, client);

    expect((globalThis as { localStorage?: Storage }).localStorage?.getItem(STORAGE_KEY)).toBeNull();
  });

  /**
   * `clearProvisionAttemptKey` alone is a weaker guarantee than the doc
   * comment claimed: it only runs inside `ensureFirstWorkspace`, which is
   * reached from `/workspaces/start` and from `/workspaces` with zero workspaces.
   * A provision that COMMITS server-side while every client attempt errors
   * therefore strands the key in `localStorage` forever — and the server's
   * `lookupProvisionByIdempotencyKey` deliberately does not filter by status,
   * so replaying it after the user archives that workspace returns the ARCHIVED
   * row instead of creating a new workspace. The TTL is the bound that holds
   * whether or not anything clears the key.
   */
  describe('the attempt key expires on its own (PROVISION_ATTEMPT_TTL_MS)', () => {
    test('a key minted within the TTL is reused', async () => {
      const { getOrCreateProvisionAttemptKey, PROVISION_ATTEMPT_TTL_MS } = await import(
        './ensure-first-workspace'
      );
      const now = 1_800_000_000_000;
      installStorage(
        fakeStorage({
          [STORAGE_KEY]: JSON.stringify({ key: 'live-key', mintedAt: now }),
        }),
      );

      expect(getOrCreateProvisionAttemptKey(ACCOUNT, now)).toBe('live-key');
      expect(getOrCreateProvisionAttemptKey(ACCOUNT, now + PROVISION_ATTEMPT_TTL_MS - 1)).toBe(
        'live-key',
      );
    });

    test('a key older than the TTL is discarded and replaced, not replayed', async () => {
      const { getOrCreateProvisionAttemptKey, PROVISION_ATTEMPT_TTL_MS } = await import(
        './ensure-first-workspace'
      );
      const now = 1_800_000_000_000;
      installStorage(
        fakeStorage({
          [STORAGE_KEY]: JSON.stringify({
            key: 'abandoned-key',
            mintedAt: now - PROVISION_ATTEMPT_TTL_MS,
          }),
        }),
      );

      const minted = getOrCreateProvisionAttemptKey(ACCOUNT, now);
      expect(minted).not.toBe('abandoned-key');
      expect(minted).toStartWith('onboarding-first-workspace:');
      // The replacement is persisted, so the retries of THIS attempt still
      // agree with each other.
      expect(getOrCreateProvisionAttemptKey(ACCOUNT, now)).toBe(minted);
    });

    test('liveProvisionAttemptKey rejects every non-record value', async () => {
      const { liveProvisionAttemptKey, PROVISION_ATTEMPT_TTL_MS } = await import(
        './ensure-first-workspace'
      );
      const now = 1_800_000_000_000;

      expect(liveProvisionAttemptKey(null, now)).toBeNull();
      // The pre-TTL bare-string format: not a record, so not trusted.
      expect(liveProvisionAttemptKey('onboarding-first-workspace:legacy', now)).toBeNull();
      expect(liveProvisionAttemptKey('{not json', now)).toBeNull();
      expect(liveProvisionAttemptKey(JSON.stringify({ key: '', mintedAt: now }), now)).toBeNull();
      expect(liveProvisionAttemptKey(JSON.stringify({ key: 'k' }), now)).toBeNull();
      // A future timestamp is a moved clock or an edited value — no evidence
      // the attempt is still live.
      expect(liveProvisionAttemptKey(JSON.stringify({ key: 'k', mintedAt: now + 1 }), now)).toBeNull();
      expect(
        liveProvisionAttemptKey(
          JSON.stringify({ key: 'k', mintedAt: now - PROVISION_ATTEMPT_TTL_MS }),
          now,
        ),
      ).toBeNull();
      expect(liveProvisionAttemptKey(JSON.stringify({ key: 'k', mintedAt: now }), now)).toBe('k');
    });
  });

  test('allowCreate: false never provisions and never touches the attempt key', async () => {
    installStorage(fakeStorage());
    const { ensureFirstWorkspace } = await import('./ensure-first-workspace');

    const client: EnsureFirstWorkspaceClient = {
      listWorkspacesForAccount: async () => [],
      provisionWorkspace: async () => {
        throw new Error('must not be called');
      },
    };

    await expect(
      ensureFirstWorkspace(ACCOUNT, { allowCreate: false }, client),
    ).resolves.toBeNull();

    expect((globalThis as { localStorage?: Storage }).localStorage?.getItem(STORAGE_KEY)).toBeNull();
  });
});
