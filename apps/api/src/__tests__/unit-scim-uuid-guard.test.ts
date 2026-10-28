import { describe, expect, mock, test } from 'bun:test';
import { Hono } from 'hono';

// KRTX-211 (Better Stack pattern 97669531): SCIM's `:accountId` path param is
// the tenant the IdP configures into its base URL; a malformed one reached
// withDirectoryTransaction and the uuid-typed casts, dying as SQLSTATE 22P02
// -> an opaque 500. The router-boundary guard in ee/scim/app.ts answers 400
// before any handler. scimAuth runs first, so the guard is asserted behind a
// mocked-authenticated bearer. The route modules are NOT mounted here — this
// exercises the guard itself; a well-formed uuid falls through to the router's
// own 404.

mock.module('../ee/scim/scim-auth', () => ({
  scimAuth: async (c: any, next: any) => {
    c.set('accountId', c.req.param('accountId'));
    await next();
  },
  scimError: (c: any, status: number, detail: string) =>
    c.json(
      { schemas: ['urn:ietf:params:scim:api:messages:2.0:Error'], status: String(status), detail },
      status as 401,
    ),
}));

// `mock.module` replaces @kortix/db wholesale — every name ee/scim/app.ts's graph
// touches has to exist even where this suite never reads it.
const tables = [
  'accountGroupMembers',
  'accountInvitations',
  'accountScimUsers',
  'accountGroups',
  'roleAssignments',
  'iamRoles',
  'iamRoleActions',
  'auditEvents',
  'projectMembers',
  'projects',
  'accountMembers',
  'accountMemberships',
  // ee/scim/app.ts imports the iam membership/group read models (dev's directory
  // sync), and membership-read.ts reads the accounts view.
  'accounts',
] as const;
const tableStubs = Object.fromEntries(tables.map((name) => [name, { __table: name }]));

mock.module('@kortix/db', () => ({
  ...tableStubs,
  readStoredAgentGrant: (raw: unknown) => raw ?? null,
  eq: (a: unknown, b: unknown) => ({ a, b }),
  and: (...parts: unknown[]) => parts,
  isNull: (a: unknown) => ({ a }),
  sql: (...args: unknown[]) => ({ args }),
  // Imported by shared/pg-broadcast.ts (#10934); a stub without it breaks a later file in the same process.
  requiresTls: () => false,
}));

mock.module('../shared/db', () => ({
  hasDatabase: () => true,
  db: {
    select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }),
    insert: () => ({ values: () => ({ returning: async () => [] }) }),
    update: () => ({ set: () => ({ where: () => ({ limit: async () => [] }) }) }),
    delete: () => ({ where: () => ({ limit: async () => [] }) }),
    execute: async () => ({ rows: [] }),
  },
}));

mock.module('../shared/audit', () => ({ recordAuditEvent: async () => undefined }));

mock.module('../iam/email-trust', () => ({
  trustedEmailForUser: async () => '',
  emailTrustedSql: () => ({ args: ['true'] }),
}));

const { scimRouter } = await import('../ee/scim/app');

function createApp() {
  const app = new Hono();
  app.route('/scim/v2', scimRouter);
  return app;
}

describe('scim router uuid guard (KRTX-211)', () => {
  test('a malformed tenant segment is answered 400 before any handler', async () => {
    const res = await createApp().request('/scim/v2/accounts/directory/Groups', {
      method: 'GET',
      headers: { authorization: 'Bearer test' },
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(String(body.error)).toContain('not a valid account id');
  });

  test('a well-formed tenant segment falls through to the router', async () => {
    const res = await createApp().request(
      '/scim/v2/accounts/00000000-0000-4000-a000-000000000101/Groups',
      { method: 'GET', headers: { authorization: 'Bearer test' } },
    );
    // No routes are mounted in this suite; the point is that the guard did
    // not reject a well-formed uuid.
    expect(res.status).toBe(404);
  });
});
