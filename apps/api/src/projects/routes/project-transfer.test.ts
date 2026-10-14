/**
 * `POST /v1/projects/:projectId/transfer` — the gate ORDER, not the movement.
 *
 * The movement itself is proven against a real database in
 * `../lib/project-transfer.integration.test.ts` (which also proves the real
 * `authorize()` verdicts these gates rely on). This suite pins the wiring the
 * criterion depends on: a caller refused on the TARGET account is refused
 * BEFORE the transfer service runs, so a member of the source organization
 * without rights on the target organization cannot trigger the transfer
 * (KRTX-1747 acceptance criterion 2) — and nothing partial ever happens.
 *
 * Drives the REAL handler through `projectsApp.request(...)` with every
 * collaborator stubbed. `mock.module` is process-global in bun:test, so this
 * runs in its own file (the test runner gives every file its own process).
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';

const PROJECT_ID = '00000000-0000-4000-a000-00000000b101';
const SOURCE_ACCOUNT = '00000000-0000-4000-a000-00000000b102';
const TARGET_ACCOUNT = '00000000-0000-4000-a000-00000000b103';

function projectRow(over: Record<string, unknown> = {}) {
  const now = new Date();
  return {
    projectId: PROJECT_ID,
    accountId: SOURCE_ACCOUNT,
    name: 'transferable',
    repoUrl: 'https://github.com/acme/transferable.git',
    defaultBranch: 'main',
    manifestPath: 'kortix.yaml',
    status: 'active',
    metadata: {},
    createdAt: now,
    updatedAt: now,
    ...over,
  };
}

let capabilityCalls: Array<{ userId: string; accountId: string; projectId: string; action: string }> = [];
let authorizeCalls: Array<{ accountId: string; action: string }> = [];
/** What the (stubbed) IAM engine answers for the TARGET-account authorize. */
let targetVerdict: { allowed: boolean; reason: string } = { allowed: false, reason: 'not_a_member' };
let quotaDenial: Record<string, unknown> | null = null;
let transferCalls: Array<{ projectId: string; fromAccountId: string; toAccountId: string }> = [];
let transferError: Error | null = null;
let targetExists = true;
let loadedProject: ReturnType<typeof projectRow> | null = projectRow();

// ── The collaborators. Stubs that THROW on unexpected use, so a wiring
// mistake fails loudly instead of silently returning undefined.
const realTransfer = await import('../lib/project-transfer');
mock.module('../lib/project-transfer', () => ({
  ...realTransfer,
  transferProjectOwnership: async (input: { projectId: string; fromAccountId: string; toAccountId: string }) => {
    transferCalls.push(input);
    if (transferError) throw transferError;
    return { projectId: input.projectId, accountId: input.toAccountId };
  },
}));

const realAccess = await import('../lib/access');
mock.module('../lib/access', () => ({
  ...realAccess,
  loadProjectForUser: async () => {
    if (!loadedProject) return null;
    return {
      userId: '00000000-0000-4000-a000-00000000b110',
      row: loadedProject,
      projectRole: 'manager',
      effectiveRole: 'manager',
    };
  },
  assertProjectCapability: async (
    _c: unknown,
    userId: string,
    accountId: string,
    projectId: string,
    action: string,
  ) => {
    capabilityCalls.push({ userId, accountId, projectId, action });
  },
}));

const realIam = await import('../../iam');
mock.module('../../iam', () => ({
  ...realIam,
  authorize: async (actor: { accountId: string }, action: string) => {
    authorizeCalls.push({ accountId: actor.accountId, action });
    // Only the TARGET gate reaches `authorize` in this handler.
    return targetVerdict;
  },
}));

mock.module('../../iam/actor', () => ({
  actorFor: async (_c: unknown, accountId: string) => ({
    userId: '00000000-0000-4000-a000-00000000b110',
    accountId,
    credential: { kind: 'jwt' },
    ctx: {},
  }),
}));

const realQuota = await import('../lib/project-quota');
mock.module('../lib/project-quota', () => ({
  ...realQuota,
  projectQuotaDenial: async () => quotaDenial,
}));

// The handler reads the target account through `db.select(...)`.
mock.module('../../shared/db', () => ({
  hasDatabase: true,
  db: {
    select: () => ({
      from: () => ({
        where: async () => (targetExists ? [{ accountId: TARGET_ACCOUNT }] : []),
      }),
    }),
  },
}));

const { projectsApp } = await import('../lib/app');
(await import('./project-settings')).registerProjectSettingsRoutes();

function post(body: unknown) {
  return projectsApp.request(`/${PROJECT_ID}/transfer`, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  capabilityCalls = [];
  authorizeCalls = [];
  transferCalls = [];
  transferError = null;
  targetVerdict = { allowed: false, reason: 'not_a_member' };
  quotaDenial = null;
  targetExists = true;
  loadedProject = projectRow();
});

describe('POST /v1/projects/:projectId/transfer', () => {
  test('a caller refused on the target account is 403’d BEFORE the transfer runs', async () => {
    // Default: the stubbed engine answers not_a_member for the target.
    const res = await post({ account_id: TARGET_ACCOUNT });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/target account/i);
    expect(authorizeCalls).toEqual([
      { accountId: TARGET_ACCOUNT, action: 'project.create' },
    ]);
    expect(transferCalls).toEqual([]);
  });

  test('the source capability gate runs before anything else moves', async () => {
    targetVerdict = { allowed: true, reason: 'role' };
    await post({ account_id: TARGET_ACCOUNT });
    expect(capabilityCalls).toEqual([
      {
        userId: '00000000-0000-4000-a000-00000000b110',
        accountId: SOURCE_ACCOUNT,
        projectId: PROJECT_ID,
        action: 'project.delete',
      },
    ]);
    expect(transferCalls).toEqual([
      { projectId: PROJECT_ID, fromAccountId: SOURCE_ACCOUNT, toAccountId: TARGET_ACCOUNT },
    ]);
  });

  test('a happy transfer answers ok with the new account', async () => {
    targetVerdict = { allowed: true, reason: 'role' };
    const res = await post({ account_id: TARGET_ACCOUNT });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, project_id: PROJECT_ID, account_id: TARGET_ACCOUNT });
  });

  test('the target entitlement cap refuses before the movement', async () => {
    targetVerdict = { allowed: true, reason: 'role' };
    quotaDenial = {
      error: 'Free accounts are limited to 1 project. Upgrade to a paid plan to create more.',
      code: 'project_limit_reached',
      limit: 1,
      count: 1,
    };
    const res = await post({ account_id: TARGET_ACCOUNT });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual(quotaDenial);
    expect(transferCalls).toEqual([]);
  });

  test('a missing target account is 404 before any gate evaluates', async () => {
    targetExists = false;
    const res = await post({ account_id: TARGET_ACCOUNT });
    expect(res.status).toBe(404);
    expect(transferCalls).toEqual([]);
  });

  test('the same account is refused', async () => {
    const res = await post({ account_id: SOURCE_ACCOUNT });
    expect(res.status).toBe(400);
    expect(transferCalls).toEqual([]);
  });

  test('an archived project is 404 and never reaches the gates', async () => {
    loadedProject = projectRow({ status: 'archived' });
    const res = await post({ account_id: TARGET_ACCOUNT });
    expect(res.status).toBe(404);
    expect(capabilityCalls).toEqual([]);
    expect(transferCalls).toEqual([]);
  });

  test('a non-uuid account_id is 400', async () => {
    const res = await post({ account_id: 'not-a-uuid' });
    expect(res.status).toBe(400);
    expect(authorizeCalls).toEqual([]);
  });

  test('a missing body account_id is 400', async () => {
    const res = await post({});
    expect(res.status).toBe(400);
  });

  test('a concurrent move is mapped to 409 with the service message', async () => {
    targetVerdict = { allowed: true, reason: 'role' };
    transferError = new realTransfer.ProjectTransferError('concurrent_move', 'Project was already transferred');
    const res = await post({ account_id: TARGET_ACCOUNT });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('Project was already transferred');
  });
});
