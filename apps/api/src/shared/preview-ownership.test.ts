import { beforeEach, describe, expect, mock, test } from 'bun:test';
import {
  accountGroupMembers,
  accountMembers,
  accounts,
  projectSessionGrants,
  projectSessions,
  serviceAccounts,
  sessionSandboxes,
} from '@kortix/db';

// PROD 76h window: 23,380 `[transcript-mirror] capture failed` (HTTP 401),
// 72% of sessions with no saved transcript. Root cause: `computeEntry`'s
// membership check only ever recognized a human in `account_members`. A
// trigger/automation session is attributed to the agent's SERVICE ACCOUNT
// (`project_sessions.created_by` = a `service_accounts` row, never an
// `account_members` row), so `resolvePreviewUserContext` returned null for
// every one of those sessions and the signed `X-Kortix-User-Context` header
// was never attached to the daemon's transcript-save request — a guaranteed,
// permanent 401 on every turn. This file exercises `computeEntry` (via its
// public wrappers) against a table-aware mock so each of the three lookups
// (sandbox ref, human membership, service-account membership) can be
// asserted independently.

let sandboxRefRow: Record<string, unknown> | null = null;
let accountMemberRow: Record<string, unknown> | null = null;
let serviceAccountRow: Record<string, unknown> | null = null;

// Observation points for the single-flight and read-ordering tests below.
// A gate holds a read open so a test can look at what else has started.
let sandboxRefReads = 0;
let accountMemberReads = 0;
let resolveAccountCalls = 0;
let sandboxRefGate: Promise<void> | null = null;
let sandboxRefFailure: Error | null = null;
let platformAdminGate: Promise<void> | null = null;
let platformAdmins = new Set<string>();
let projectSessionRow: Record<string, unknown> | null = null;
let projectSessionReads = 0;
let projectSessionGate: Promise<void> | null = null;
let projectSessionFailure: Error | null = null;
let shareSubjectReads = 0;

// `canAccessSandboxSession` awaits two of its reads without a `.limit()`.
async function unlimitedRows(table: unknown): Promise<unknown[]> {
  if (table === accountGroupMembers) {
    shareSubjectReads += 1;
    return [];
  }
  if (table === projectSessionGrants) return [];
  throw new Error('preview-ownership.test.ts: unexpected table awaited without limit()');
}

mock.module('./db', () => ({
  db: {
    select: () => ({
      from: (table: unknown) => ({
        where: () => ({
          then: (resolve: (rows: unknown[]) => unknown, reject: (reason: unknown) => unknown) =>
            unlimitedRows(table).then(resolve, reject),
          limit: async () => {
            if (table === sessionSandboxes) {
              sandboxRefReads += 1;
              await sandboxRefGate;
              if (sandboxRefFailure) throw sandboxRefFailure;
              return sandboxRefRow ? [sandboxRefRow] : [];
            }
            if (table === accountMembers) {
              accountMemberReads += 1;
              return accountMemberRow ? [accountMemberRow] : [];
            }
            if (table === serviceAccounts) return serviceAccountRow ? [serviceAccountRow] : [];
            if (table === projectSessions) {
              projectSessionReads += 1;
              await projectSessionGate;
              if (projectSessionFailure) throw projectSessionFailure;
              return projectSessionRow ? [projectSessionRow] : [];
            }
            // The account session-oversight policy: off.
            if (table === accounts) return [];
            throw new Error('preview-ownership.test.ts: unexpected table in db.select().from()');
          },
        }),
      }),
    }),
  },
}));

mock.module('./resolve-account', () => ({
  resolveAccountId: async (userId: string) => {
    resolveAccountCalls += 1;
    return userId;
  },
}));

mock.module('./platform-roles', () => ({
  isPlatformAdmin: async (accountId: string) => {
    await platformAdminGate;
    return platformAdmins.has(accountId);
  },
}));

const {
  resolvePreviewUserContext,
  canAccessPreviewSandbox,
  canAccessSandboxSession,
  clearPreviewOwnershipCache,
} = await import('./preview-ownership');

/** A promise and the function that settles it. */
function gate(): { held: Promise<void>; release: () => void } {
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { held, release };
}

/** Let every already-runnable continuation run; a held gate stays held. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  sandboxRefRow = {
    sandboxId: 'sbx-1',
    accountId: 'acct-1',
    projectId: 'proj-1',
  };
  accountMemberRow = null;
  serviceAccountRow = null;
  sandboxRefReads = 0;
  accountMemberReads = 0;
  resolveAccountCalls = 0;
  sandboxRefGate = null;
  sandboxRefFailure = null;
  platformAdminGate = null;
  platformAdmins = new Set();
  projectSessionRow = null;
  projectSessionReads = 0;
  projectSessionGate = null;
  projectSessionFailure = null;
  shareSubjectReads = 0;
  clearPreviewOwnershipCache();
});

describe('resolvePreviewUserContext — service-account attributed sessions', () => {
  test('a human account member gets a signed context, as before', async () => {
    accountMemberRow = { accountId: 'acct-1' };

    const context = await resolvePreviewUserContext('sbx-1', 'user-human-1');

    expect(context).toEqual({
      userId: 'user-human-1',
      sandboxId: 'sbx-1',
      sandboxRole: 'member',
      scopes: ['*'],
    });
  });

  test('an agent service account of the SAME account gets a signed context', async () => {
    serviceAccountRow = { serviceAccountId: 'sa-agent-1' };

    const context = await resolvePreviewUserContext('sbx-1', 'sa-agent-1');

    expect(context).toEqual({
      userId: 'sa-agent-1',
      sandboxId: 'sbx-1',
      sandboxRole: 'member',
      scopes: ['*'],
    });
  });

  test('before the fix this returned null for a service-account-attributed session — now it must not', async () => {
    serviceAccountRow = { serviceAccountId: 'sa-agent-1' };

    expect(await resolvePreviewUserContext('sbx-1', 'sa-agent-1')).not.toBeNull();
    expect(await canAccessPreviewSandbox({ previewSandboxId: 'sbx-1', userId: 'sa-agent-1' })).toBe(
      true,
    );
  });

  test('neither a member nor a service account row (e.g. disabled, or a different account) is refused', async () => {
    accountMemberRow = null;
    serviceAccountRow = null;

    expect(await resolvePreviewUserContext('sbx-1', 'stranger')).toBeNull();
  });
});

// A page load fires its proxied requests together. On a cold cache every one of
// them used to run the whole check: 4 to 6 statements each, one after another.
describe('cold ownership check — one check per (sandbox, user), reads in parallel', () => {
  test('concurrent checks for one (sandbox, user) run the lookups once', async () => {
    accountMemberRow = { accountId: 'acct-1' };
    const { held, release } = gate();
    sandboxRefGate = held;

    const checks = [
      resolvePreviewUserContext('sbx-1', 'user-human-1'),
      resolvePreviewUserContext('sbx-1', 'user-human-1'),
      canAccessPreviewSandbox({ previewSandboxId: 'sbx-1', userId: 'user-human-1' }),
      canAccessPreviewSandbox({ previewSandboxId: 'sbx-1', userId: 'user-human-1' }),
      resolvePreviewUserContext('sbx-1', 'user-human-1'),
    ];
    await settle();
    release();
    const [first, second, allowedA, allowedB, last] = await Promise.all(checks);

    expect(sandboxRefReads).toBe(1);
    expect(resolveAccountCalls).toBe(1);
    expect(accountMemberReads).toBe(1);
    expect(first).toEqual({
      userId: 'user-human-1',
      sandboxId: 'sbx-1',
      sandboxRole: 'member',
      scopes: ['*'],
    });
    expect(second).toEqual(first);
    expect(last).toEqual(first);
    expect(allowedA).toBe(true);
    expect(allowedB).toBe(true);
  });

  test('two users on one sandbox never share a check in flight', async () => {
    platformAdmins = new Set(['user-admin-1']);
    const { held, release } = gate();
    sandboxRefGate = held;

    const admin = resolvePreviewUserContext('sbx-1', 'user-admin-1');
    const stranger = resolvePreviewUserContext('sbx-1', 'stranger');
    await settle();
    release();

    expect(await admin).toEqual({
      userId: 'user-admin-1',
      sandboxId: 'sbx-1',
      sandboxRole: 'platform_admin',
      scopes: ['*'],
    });
    expect(await stranger).toBeNull();
    expect(sandboxRefReads).toBe(2);
    expect(resolveAccountCalls).toBe(2);
  });

  test('a failed check is not kept: every waiter gets the error, the next call reads again', async () => {
    accountMemberRow = { accountId: 'acct-1' };
    const { held, release } = gate();
    sandboxRefGate = held;
    sandboxRefFailure = new Error('connection reset');

    const failing = [
      resolvePreviewUserContext('sbx-1', 'user-human-1'),
      resolvePreviewUserContext('sbx-1', 'user-human-1'),
    ];
    const outcomes = Promise.allSettled(failing);
    await settle();
    release();
    expect((await outcomes).map((o) => o.status)).toEqual(['rejected', 'rejected']);
    expect(sandboxRefReads).toBe(1);

    sandboxRefGate = null;
    sandboxRefFailure = null;
    expect(await resolvePreviewUserContext('sbx-1', 'user-human-1')).not.toBeNull();
    expect(sandboxRefReads).toBe(2);
  });

  test('a check that was in flight when the cache was cleared is not cached', async () => {
    accountMemberRow = { accountId: 'acct-1' };
    const { held, release } = gate();
    sandboxRefGate = held;

    const before = resolvePreviewUserContext('sbx-1', 'user-human-1');
    await settle();
    clearPreviewOwnershipCache();
    release();
    expect(await before).not.toBeNull();

    // The member was removed after the clear: the next check must read it.
    accountMemberRow = null;
    expect(await resolvePreviewUserContext('sbx-1', 'user-human-1')).toBeNull();
    expect(sandboxRefReads).toBe(2);
  });

  test('the account read does not wait for the sandbox row, nor the membership read for the admin verdict', async () => {
    accountMemberRow = { accountId: 'acct-1' };
    const sandboxRow = gate();
    const adminVerdict = gate();
    sandboxRefGate = sandboxRow.held;
    platformAdminGate = adminVerdict.held;

    const check = resolvePreviewUserContext('sbx-1', 'user-human-1');
    await settle();
    // The sandbox row is still out; the caller's account is already resolved.
    expect(sandboxRefReads).toBe(1);
    expect(resolveAccountCalls).toBe(1);
    expect(accountMemberReads).toBe(0);

    sandboxRow.release();
    await settle();
    // The admin verdict is still out; the membership read has started.
    expect(accountMemberReads).toBe(1);

    adminVerdict.release();
    expect(await check).toEqual({
      userId: 'user-human-1',
      sandboxId: 'sbx-1',
      sandboxRole: 'member',
      scopes: ['*'],
    });
  });

  test('no sandbox row: the membership tables are not read and only a platform admin passes', async () => {
    sandboxRefRow = null;
    platformAdmins = new Set(['user-admin-1']);

    expect(await canAccessPreviewSandbox({ previewSandboxId: 'sbx-1', userId: 'stranger' })).toBe(false);
    expect(await canAccessPreviewSandbox({ previewSandboxId: 'sbx-1', userId: 'user-admin-1' })).toBe(true);
    expect(accountMemberReads).toBe(0);
  });
});

// The session-visibility verdict is cached for 10 s, so it is cold on most page
// loads, and a page load fires its daemon-port requests together.
describe('canAccessSandboxSession — one read per caller key', () => {
  // The verdict cache has no reset, so every test uses its own session id.
  const access = (sessionId: string, userId: string, callerSessionId: string | null = null) =>
    canAccessSandboxSession({
      sessionId,
      projectId: 'proj-1',
      accountId: 'acct-1',
      userId,
      callerSessionId,
      boundCredentialSessionId: null,
    });
  const privateSessionOf = (ownerId: string) => ({
    visibility: 'private',
    createdBy: ownerId,
    origin: 'user',
    metadata: {},
    initiatorType: 'member',
  });

  test('concurrent checks of one caller on one session read the session once', async () => {
    projectSessionRow = privateSessionOf('user-owner');
    const { held, release } = gate();
    projectSessionGate = held;

    const checks = Array.from({ length: 5 }, () => access('sess-flight-1', 'user-owner'));
    await settle();
    release();

    expect(await Promise.all(checks)).toEqual([true, true, true, true, true]);
    expect(projectSessionReads).toBe(1);
    expect(shareSubjectReads).toBe(1);
  });

  test('two users, or two caller sessions of one user, never share a verdict in flight', async () => {
    projectSessionRow = privateSessionOf('user-owner');
    const { held, release } = gate();
    projectSessionGate = held;

    const owner = access('sess-flight-2', 'user-owner');
    const other = access('sess-flight-2', 'user-other');
    const ownerFromAnotherSession = access('sess-flight-2', 'user-owner', 'sess-caller-9');
    await settle();
    release();

    expect(await owner).toBe(true);
    expect(await other).toBe(false);
    await ownerFromAnotherSession;
    expect(projectSessionReads).toBe(3);
  });

  test('a failed read is not kept: every waiter gets the error, the next call reads again', async () => {
    projectSessionRow = privateSessionOf('user-owner');
    const { held, release } = gate();
    projectSessionGate = held;
    projectSessionFailure = new Error('connection reset');

    const outcomes = Promise.allSettled([
      access('sess-flight-3', 'user-owner'),
      access('sess-flight-3', 'user-owner'),
    ]);
    await settle();
    release();
    expect((await outcomes).map((o) => o.status)).toEqual(['rejected', 'rejected']);
    expect(projectSessionReads).toBe(1);

    projectSessionGate = null;
    projectSessionFailure = null;
    expect(await access('sess-flight-3', 'user-owner')).toBe(true);
    expect(projectSessionReads).toBe(2);
  });
});
