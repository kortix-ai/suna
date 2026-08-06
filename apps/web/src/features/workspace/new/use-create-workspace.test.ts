import { describe, expect, test } from 'bun:test';

import {
  buildCreatePayload,
  fingerprintOf,
  messageFor,
  RETRY_DELAY_MS,
  runCreateAttempt,
  type CreateWorkspaceClient,
} from './use-create-workspace';
import { INITIAL_FORM_STATE } from './new-workspace-form';
import { ApiError, PROVISION_IN_FLIGHT_CODE, type KortixAccount, type KortixProject } from '@kortix/sdk';

const OWNER_ACCOUNT: KortixAccount = { account_id: 'acct-owner', name: 'Owner Co', account_role: 'owner' };

function fakeProject(id: string): KortixProject {
  return {
    project_id: id,
    account_id: 'acct-owner',
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
