/**
 * Dependency-injected, database-free tests for the POST /v1/projects/provision
 * dedupe. Every seam here is a plain function parameter — no `mock.module`,
 * which is process-wide in this app and leaks into sibling suites.
 *
 * The ordering half of the contract (the lookup MUST run before
 * `backend.createRepo`, or a deduped retry still leaves an orphaned upstream
 * repo behind) is not expressible here; it is guarded at the source level by
 * `../routes/r1-provision-idempotency.test.ts`.
 */
import { describe, expect, test } from 'bun:test';

import {
  PROVISION_IDEMPOTENCY_KEY_MAX_LENGTH,
  PROVISION_IDEMPOTENCY_UNIQUE_INDEX,
  describeProvisionedRepo,
  findIdempotentProvision,
  isProvisionIdempotencyConflict,
  provisionReplayResponse,
  readProvisionIdempotencyKey,
  type ProvisionIdempotencyLookup,
} from './provision-idempotency';
import type { ProjectRow } from './serializers';

const ACCOUNT = '00000000-0000-4000-a000-000000005001';
const OTHER_ACCOUNT = '00000000-0000-4000-a000-000000005002';
const KEY = 'onboarding-8f1c0f6e-1a2b-4c3d-9e8f-000000000001';

function projectRow(over: Partial<ProjectRow> = {}): ProjectRow {
  const now = new Date('2026-08-05T12:00:00.000Z');
  return {
    projectId: '00000000-0000-4000-a000-0000000050ff',
    accountId: ACCOUNT,
    name: 'My First Project',
    repoUrl: 'https://github.com/kortix-managed/my-first-project.git',
    defaultBranch: 'main',
    manifestPath: 'kortix.yaml',
    status: 'active',
    secretDefaultStrategy: 'runtime',
    metadata: {},
    idempotencyKey: KEY,
    sandboxProviderGeneration: 0,
    lastOpenedAt: null,
    createdAt: now,
    updatedAt: now,
    ...over,
  };
}

/**
 * A real (if tiny) store, not a stub that returns a canned value: it holds
 * rows and answers by the same (account_id, idempotency_key) pair the partial
 * unique index is built on, so a test that passes here would pass against
 * Postgres for the same inputs.
 */
function fakeStore(rows: ReturnType<typeof projectRow>[] = []) {
  const calls: Array<{ accountId: string; key: string }> = [];
  const lookup: ProvisionIdempotencyLookup = async (accountId, key) => {
    calls.push({ accountId, key });
    return rows.find((r) => r.accountId === accountId && r.idempotencyKey === key) ?? null;
  };
  return { rows, calls, lookup };
}

describe('readProvisionIdempotencyKey', () => {
  test('reads the snake_case body field', () => {
    expect(readProvisionIdempotencyKey({ idempotency_key: KEY })).toEqual({ ok: true, key: KEY });
  });

  test('reads the camelCase body field, like every other field on this route', () => {
    expect(readProvisionIdempotencyKey({ idempotencyKey: KEY })).toEqual({ ok: true, key: KEY });
  });

  test('trims surrounding whitespace so " k " and "k" are one key, not two', () => {
    expect(readProvisionIdempotencyKey({ idempotency_key: `  ${KEY}\n` })).toEqual({
      ok: true,
      key: KEY,
    });
  });

  test('an absent key is legal — provision without one keeps working', () => {
    expect(readProvisionIdempotencyKey({ name: 'My First Project' })).toEqual({
      ok: true,
      key: null,
    });
  });

  test('an empty or whitespace-only key is absent, not a key every retry shares', () => {
    // The dangerous reading would be `''`: two unrelated creates would then
    // collide on one key and the second would be handed the first's project.
    expect(readProvisionIdempotencyKey({ idempotency_key: '' })).toEqual({ ok: true, key: null });
    expect(readProvisionIdempotencyKey({ idempotency_key: '   ' })).toEqual({ ok: true, key: null });
  });

  test('a non-string key is rejected rather than coerced', () => {
    for (const value of [42, true, ['a'], { a: 1 }]) {
      const result = readProvisionIdempotencyKey({ idempotency_key: value });
      expect(result.ok).toBe(false);
      expect(result.ok === false && result.error).toContain('idempotency_key');
    }
  });

  test('a key at the length limit is accepted and one character over is rejected', () => {
    const atLimit = 'k'.repeat(PROVISION_IDEMPOTENCY_KEY_MAX_LENGTH);
    expect(readProvisionIdempotencyKey({ idempotency_key: atLimit })).toEqual({
      ok: true,
      key: atLimit,
    });

    const overLimit = 'k'.repeat(PROVISION_IDEMPOTENCY_KEY_MAX_LENGTH + 1);
    const result = readProvisionIdempotencyKey({ idempotency_key: overLimit });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain(
      String(PROVISION_IDEMPOTENCY_KEY_MAX_LENGTH),
    );
  });

  test('rejects characters outside the documented alphabet', () => {
    for (const value of ['has space', 'new\nline', 'sémantique', 'quote"d', 'tab\there']) {
      expect(readProvisionIdempotencyKey({ idempotency_key: value }).ok).toBe(false);
    }
  });

  test('accepts the shapes clients actually send', () => {
    for (const value of [
      '8f1c0f6e-1a2b-4c3d-9e8f-000000000001',
      'onboarding:first-project:v1',
      'web_onboarding.2026-08-05',
    ]) {
      expect(readProvisionIdempotencyKey({ idempotency_key: value })).toEqual({
        ok: true,
        key: value,
      });
    }
  });

  test('snake_case wins when both spellings arrive', () => {
    expect(
      readProvisionIdempotencyKey({ idempotency_key: 'snake-one', idempotencyKey: 'camel-two' }),
    ).toEqual({ ok: true, key: 'snake-one' });
  });
});

describe('findIdempotentProvision', () => {
  test('a repeat with the same key resolves to the project the first call created', async () => {
    const existing = projectRow();
    const store = fakeStore([existing]);

    const found = await findIdempotentProvision(store.lookup, ACCOUNT, KEY);

    expect(found).toBe(existing);
    expect(store.calls).toEqual([{ accountId: ACCOUNT, key: KEY }]);
  });

  test('the first call with a fresh key resolves to nothing, so provisioning proceeds', async () => {
    const store = fakeStore([]);
    expect(await findIdempotentProvision(store.lookup, ACCOUNT, KEY)).toBeNull();
  });

  test('no key means no lookup at all — the database is never touched', async () => {
    const store = fakeStore([projectRow()]);

    expect(await findIdempotentProvision(store.lookup, ACCOUNT, null)).toBeNull();
    expect(store.calls).toEqual([]);
  });

  test('the dedupe is account-scoped — another account cannot claim this key', async () => {
    const store = fakeStore([projectRow()]);

    expect(await findIdempotentProvision(store.lookup, OTHER_ACCOUNT, KEY)).toBeNull();
  });

  test('two calls with one key yield one project and one shared project_id', async () => {
    // The acceptance criterion, driven through the same seam the route uses.
    // `create` stands in for everything provision does after the check —
    // minting the upstream repo and inserting the row — so its call count is
    // the number of managed repos this pair of calls would create.
    const store = fakeStore([]);
    let reposCreated = 0;
    const provision = async (key: string | null) => {
      const existing = await findIdempotentProvision(store.lookup, ACCOUNT, key);
      if (existing) return { projectId: existing.projectId, created: false };
      reposCreated += 1;
      const row = projectRow({
        projectId: `00000000-0000-4000-a000-00000000${String(reposCreated).padStart(4, '0')}`,
        idempotencyKey: key,
      });
      store.rows.push(row);
      return { projectId: row.projectId, created: true };
    };

    const first = await provision(KEY);
    const second = await provision(KEY);

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.projectId).toBe(first.projectId);
    expect(reposCreated).toBe(1);
    expect(store.rows).toHaveLength(1);
  });

  test('two calls with no key still create two projects — same name, deliberate duplicate', async () => {
    const store = fakeStore([]);
    let reposCreated = 0;
    const provision = async (key: string | null) => {
      const existing = await findIdempotentProvision(store.lookup, ACCOUNT, key);
      if (existing) return { created: false };
      reposCreated += 1;
      store.rows.push(projectRow({ projectId: `p-${reposCreated}`, idempotencyKey: key }));
      return { created: true };
    };

    expect((await provision(null)).created).toBe(true);
    expect((await provision(null)).created).toBe(true);
    expect(reposCreated).toBe(2);
  });

  test('different keys create different projects', async () => {
    const store = fakeStore([projectRow()]);
    expect(await findIdempotentProvision(store.lookup, ACCOUNT, 'a-different-key')).toBeNull();
  });
});

describe('isProvisionIdempotencyConflict', () => {
  test('recognises the unique violation drizzle wraps as `cause`', () => {
    const error = Object.assign(new Error('Failed query: insert into "kortix"."projects" …'), {
      cause: { code: '23505', constraint_name: PROVISION_IDEMPOTENCY_UNIQUE_INDEX },
    });
    expect(isProvisionIdempotencyConflict(error)).toBe(true);
  });

  test('recognises the same code on the top-level error', () => {
    const error = Object.assign(new Error('duplicate key value'), {
      code: '23505',
      constraint_name: PROVISION_IDEMPOTENCY_UNIQUE_INDEX,
    });
    expect(isProvisionIdempotencyConflict(error)).toBe(true);
  });

  test('a unique violation on a DIFFERENT constraint is not ours', () => {
    // Critical: the caller responds by DELETING the managed repo it just
    // minted. Treating an unrelated conflict as ours would destroy a repo the
    // dedupe has no claim over.
    const error = Object.assign(new Error('Failed query'), {
      cause: { code: '23505', constraint_name: 'idx_project_git_connections_project' },
    });
    expect(isProvisionIdempotencyConflict(error)).toBe(false);
  });

  test('a non-unique-violation database error is not ours', () => {
    const error = Object.assign(new Error('Failed query'), {
      cause: { code: '23503', constraint_name: PROVISION_IDEMPOTENCY_UNIQUE_INDEX },
    });
    expect(isProvisionIdempotencyConflict(error)).toBe(false);
  });

  test('ordinary errors and non-objects are not ours', () => {
    expect(isProvisionIdempotencyConflict(new Error('boom'))).toBe(false);
    expect(isProvisionIdempotencyConflict(null)).toBe(false);
    expect(isProvisionIdempotencyConflict(undefined)).toBe(false);
    expect(isProvisionIdempotencyConflict('23505')).toBe(false);
  });
});

describe('provisionReplayResponse', () => {
  const seededRow = projectRow({
    metadata: { git: { repo_id: '987654321', seed: { seeded: true, expected: true } } },
  });

  test('returns the same project_id the original create returned', () => {
    expect(provisionReplayResponse(seededRow).project_id).toBe(seededRow.projectId);
  });

  test('carries the create response fields the caller lost', () => {
    expect(provisionReplayResponse(seededRow)).toMatchObject({
      account_id: ACCOUNT,
      name: 'My First Project',
      repo_id: '987654321',
      seeded: true,
      status: 'active',
      project_role: 'manager',
      effective_project_role: 'manager',
    });
  });

  test('never mints a push credential as a side effect of a retry', () => {
    // A retry is a read. The one-shot push token belongs to the create that
    // produced it; a caller that needs one after a retry asks
    // POST /v1/projects/:projectId/git-token for it.
    const replay = provisionReplayResponse(seededRow);
    expect(replay.push_token).toBeNull();
    expect(replay.git_username).toBeNull();
  });

  test('does not leak the idempotency key back to the caller', () => {
    // It is an input, not part of the project representation, and the response
    // contract (@kortix/api-contract ProjectSchema) has no field for it.
    expect(JSON.stringify(provisionReplayResponse(seededRow))).not.toContain(KEY);
  });

  test('reports an unseeded project honestly rather than claiming success', () => {
    const unseeded = projectRow({
      metadata: { git: { repo_id: '1', seed: { seeded: false, expected: true } } },
    });
    expect(provisionReplayResponse(unseeded).seeded).toBe(false);
  });
});

describe('describeProvisionedRepo', () => {
  test('reports the repo id and the verified seed state a create response carries', () => {
    const row = projectRow({
      metadata: { git: { repo_id: '987654321', seed: { seeded: true, expected: true } } },
    });
    expect(describeProvisionedRepo(row)).toEqual({ repoId: '987654321', seeded: true });
  });

  test('an unseeded project reports seeded:false, not a missing field', () => {
    const row = projectRow({
      metadata: { git: { repo_id: '1', seed: { seeded: false, expected: false } } },
    });
    expect(describeProvisionedRepo(row)).toEqual({ repoId: '1', seeded: false });
  });

  test('metadata written before this shape existed degrades to nulls, never throws', () => {
    expect(describeProvisionedRepo(projectRow({ metadata: {} }))).toEqual({
      repoId: null,
      seeded: false,
    });
    expect(describeProvisionedRepo(projectRow({ metadata: null }))).toEqual({
      repoId: null,
      seeded: false,
    });
    expect(describeProvisionedRepo(projectRow({ metadata: { git: 'not-an-object' } }))).toEqual({
      repoId: null,
      seeded: false,
    });
    expect(describeProvisionedRepo(projectRow({ metadata: { git: { seed: 7 } } }))).toEqual({
      repoId: null,
      seeded: false,
    });
  });

  test('a non-string repo id is normalised to a string, matching the create response', () => {
    const row = projectRow({ metadata: { git: { repo_id: 987654321 } } });
    expect(describeProvisionedRepo(row)).toEqual({ repoId: '987654321', seeded: false });
  });
});
