import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { accountMembers, projectSessions, serviceAccounts, sessionSandboxes } from '@kortix/db';

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

mock.module('./db', () => ({
  db: {
    select: () => ({
      from: (table: unknown) => ({
        where: () => ({
          limit: async () => {
            if (table === sessionSandboxes) return sandboxRefRow ? [sandboxRefRow] : [];
            if (table === accountMembers) return accountMemberRow ? [accountMemberRow] : [];
            if (table === serviceAccounts) return serviceAccountRow ? [serviceAccountRow] : [];
            if (table === projectSessions) return [];
            throw new Error('preview-ownership.test.ts: unexpected table in db.select().from()');
          },
        }),
      }),
    }),
  },
}));

mock.module('./resolve-account', () => ({
  resolveAccountId: async (userId: string) => userId,
}));

mock.module('./platform-roles', () => ({
  isPlatformAdmin: async () => false,
}));

const { resolvePreviewUserContext, canAccessPreviewSandbox, clearPreviewOwnershipCache } =
  await import('./preview-ownership');

beforeEach(() => {
  sandboxRefRow = {
    sandboxId: 'sbx-1',
    accountId: 'acct-1',
    projectId: 'proj-1',
  };
  accountMemberRow = null;
  serviceAccountRow = null;
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
