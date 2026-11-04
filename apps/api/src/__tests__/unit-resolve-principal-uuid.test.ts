import { describe, expect, mock, test } from 'bun:test';

// KRTX-211 (Better Stack pattern 97669531): a malformed account id reaching
// the IAM engine's baseline read joined uuid-typed columns and died as
// SQLSTATE 22P02 -> an opaque 500 on every account-scoped route the engine
// authorizes. resolvePrincipalUncached must answer "no membership" for a
// malformed id without touching the database. The db shim throws the 22P02
// error on ANY read, so a regression lands as the prod 500, not a quiet deny.

function uuidError(): Error {
  return Object.assign(new Error('invalid input syntax for type uuid: "directory"'), {
    code: '22P02',
  });
}

const throwingDb = {
  select: () => {
    throw uuidError();
  },
  insert: () => {
    throw uuidError();
  },
  update: () => {
    throw uuidError();
  },
  delete: () => {
    throw uuidError();
  },
  execute: async () => {
    throw uuidError();
  },
};

mock.module('../shared/db', () => ({ hasDatabase: () => true, db: throwingDb }));

// The identity tables the engine's baseline read joins. `mock.module` replaces
// @kortix/db WHOLESALE, so every name on the import graph has to exist even
// where this suite never reads it.
const tables = [
  'accounts',
  'accountMembers',
  'accountMemberships',
  'accountGroups',
  'accountGroupMembers',
  'accountInvitations',
  'accountSessionActivity',
  'accountTokens',
  'auditEvents',
  'iamRoles',
  'iamRoleActions',
  'objectPolicies',
  'permissions',
  'projectMembers',
  'projectSessions',
  'roleAssignments',
  'serviceAccounts',
] as const;
const tableStubs = Object.fromEntries(tables.map((name) => [name, { __table: name }]));

mock.module('@kortix/db', () => ({
  ...tableStubs,
  readStoredAgentGrant: (raw: unknown) => raw ?? null,
  // Imported by shared/pg-broadcast.ts (#10934); a stub without it breaks a later file in the same process.
  requiresTls: () => false,
}));

mock.module('../lib/server-timing', () => ({
  timeStage: async <T>(_stage: string, fn: () => Promise<T>) => fn(),
}));

const { resolvePrincipal } = await import('../iam/authorize');

describe('resolvePrincipal with a malformed account id (KRTX-211)', () => {
  test('answers "no membership" without touching the database', async () => {
    const record = await resolvePrincipal({ type: 'user', id: '00000000-0000-4000-a000-000000000001' }, 'directory');
    expect(record).toBeNull();
  });

  test('an empty account id stays "no membership" too', async () => {
    const record = await resolvePrincipal({ type: 'user', id: '00000000-0000-4000-a000-000000000001' }, '');
    expect(record).toBeNull();
  });
});
