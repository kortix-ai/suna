/**
 * Every write that can make SSO only effective ends the sign-ins it refuses
 * (KRTX-1716): saving the provider, DNS domain verification, and an operator
 * verifying the domain. The audit event records how many. When ending them
 * fails, the write is already committed and the gate already refuses those
 * people: the event records `revoked_sessions: null` and the route answers 500
 * `sso_sign_out_failed`, and repeating the request retries. The query itself
 * is proven against real Postgres in `integration-sso-required.test.ts`.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { Hono } from 'hono';
import * as realSsoRepository from '../repositories/sso';

mock.module('../iam', () => ({
  ACCOUNT_ACTIONS: { ACCOUNT_READ: 'account.read', ACCOUNT_WRITE: 'account.write' },
  assertAuthorized: async () => {},
}));

const audits: Array<{ action: string; after: Record<string, unknown> | null }> = [];
mock.module('../shared/audit', () => ({
  recordAuditEvent: async (event: { action: string; after: Record<string, unknown> | null }) => {
    audits.push(event);
  },
}));

mock.module('../billing/services/entitlements', () => ({
  accountHasEntitlement: async () => true,
}));

mock.module('../accounts/iam/ee/sso-provisioning', () => ({
  syncSupabaseSamlAttributeMapping: async () => ({ ok: true }),
  registerSupabaseSamlProvider: async () => ({ ok: false, status: 400, error: 'unused' }),
  deleteSupabaseSamlProvider: async () => ({ ok: true }),
}));

// The admin router's gate: a platform admin, signed in.
mock.module('../middleware/auth', () => ({
  supabaseAuth: async (c: any, next: any) => {
    c.set('userId', 'operator-1');
    await next();
  },
}));
mock.module('../middleware/require-admin', () => ({
  requireAdmin: async (_c: any, next: any) => {
    await next();
  },
}));

let txtRecords: string[][] = [];
mock.module('node:dns/promises', () => ({
  Resolver: class {
    async resolveTxt() {
      return txtRecords;
    }
  },
}));

const provider = {
  ssoProviderId: 'sp-1',
  accountId: 'acct-1',
  supabaseSsoProviderId: '11111111-1111-1111-1111-111111111111',
  name: 'Synthetic IdP',
  primaryDomain: 'example.test',
  groupClaimName: 'groups',
  autoCreateMembers: true,
  autoProvisionGroups: false,
  enforceSso: true,
  domainVerificationToken: 'token',
  domainVerifiedAt: new Date('2026-01-01T00:00:00Z') as Date | null,
  createdBy: null,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
};
let current = { ...provider };
let signOut: () => Promise<number> = async () => 0;
const signOutCalls: Array<[string, string | null]> = [];
mock.module('../repositories/sso', () => ({
  ...realSsoRepository,
  isPersonalAccount: async () => false,
  getSsoProvider: async () => current,
  upsertSsoProvider: async () => current,
  domainVerifiedByOtherAccount: async () => false,
  setSsoDomainVerified: async (_accountId: string, verified: boolean) =>
    (current = { ...current, domainVerifiedAt: verified ? new Date('2026-01-02T00:00:00Z') : null }),
  signOutNonSsoMembers: async (accountId: string, revokedBy: string | null) => {
    signOutCalls.push([accountId, revokedBy]);
    return signOut();
  },
}));

const { iamRouter } = await import('../accounts/iam/app');
(await import('../accounts/iam/ee/sso')).registerIamSsoRoutes();
const { adminApp } = await import('../admin');

const ACCOUNT = '00000000-0000-4000-a000-000000000001';
const app = new Hono();
app.use('*', async (c: any, next: any) => {
  c.set('userId', 'admin-1');
  await next();
});
app.route('/', iamRouter);

const failing = async (): Promise<number> => {
  throw new Error('synthetic database failure');
};

const save = () =>
  app.request(`/${ACCOUNT}/iam/sso/provider`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      supabase_sso_provider_id: provider.supabaseSsoProviderId,
      name: provider.name,
      primary_domain: provider.primaryDomain,
      enforce_sso: true,
    }),
  });
const verifyDomain = () => app.request(`/${ACCOUNT}/iam/sso/provider/verify-domain`, { method: 'POST' });
const operatorSets = (verified: boolean) =>
  adminApp.request(`/api/accounts/${ACCOUNT}/sso-domain-verification`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ verified }),
  });
const audited = () => audits.map((a) => [a.action, a.after?.revoked_sessions, a.after?.domain_verified]);

beforeEach(() => {
  audits.length = 0;
  signOutCalls.length = 0;
  signOut = async () => 0;
  current = { ...provider };
  txtRecords = [];
});

describe('PUT /iam/sso/provider ends the sign-ins SSO only refuses', () => {
  test('the audit event records the number of sign-ins ended', async () => {
    signOut = async () => 3;
    const res = await save();
    expect(res.status).toBe(200);
    expect(signOutCalls).toEqual([[ACCOUNT, 'admin-1']]);
    expect(audits.map((a) => [a.action, a.after?.revoked_sessions, a.after?.enforce_sso])).toEqual([
      ['iam.sso.provider.update', 3, true],
    ]);
  });

  test('a failed sign-out still audits the save, with revoked_sessions null, and answers 500', async () => {
    signOut = failing;
    const res = await save();
    expect(res.status).toBe(500);
    expect((await res.json()).code).toBe('sso_sign_out_failed');
    expect(audits.map((a) => [a.action, a.after?.revoked_sessions])).toEqual([['iam.sso.provider.update', null]]);
  });
});

describe('POST /iam/sso/provider/verify-domain ends the sign-ins SSO only refuses', () => {
  const unverified = () => {
    current = { ...provider, domainVerifiedAt: null };
    txtRecords = [[realSsoRepository.ssoDomainVerificationRecordValue(provider.domainVerificationToken)]];
  };

  test('DNS verification with enforce_sso on ends them and records the number', async () => {
    unverified();
    signOut = async () => 2;
    const res = await verifyDomain();
    expect(res.status).toBe(200);
    expect((await res.json()).provider.domain_verified).toBe(true);
    expect(signOutCalls).toEqual([[ACCOUNT, 'admin-1']]);
    expect(audited()).toEqual([['iam.sso.provider.domain_verify', 2, true]]);
  });

  test('a failed sign-out keeps the verification, audits revoked_sessions null, and answers 500', async () => {
    unverified();
    signOut = failing;
    const res = await verifyDomain();
    expect(res.status).toBe(500);
    expect((await res.json()).code).toBe('sso_sign_out_failed');
    expect(current.domainVerifiedAt).not.toBeNull();
    expect(audited()).toEqual([['iam.sso.provider.domain_verify', null, true]]);
  });

  test('a repeat on the verified domain retries the sign-out and audits what it ended', async () => {
    signOut = failing;
    const failed = await verifyDomain();
    expect(failed.status).toBe(500);
    expect((await failed.json()).code).toBe('sso_sign_out_failed');

    signOut = async () => 2;
    expect((await verifyDomain()).status).toBe(200);
    expect(audited()).toEqual([['iam.sso.provider.domain_verify', 2, true]]);
    expect(audits[0].after?.method).toBe('retry');

    // Nothing left to end: 200, and no audit event.
    signOut = async () => 0;
    expect((await verifyDomain()).status).toBe(200);
    expect(audits).toHaveLength(1);
    expect(signOutCalls).toHaveLength(3);
  });
});

describe('PUT /admin/api/accounts/:id/sso-domain-verification', () => {
  test('verifying ends the sign-ins and records the number', async () => {
    current = { ...provider, domainVerifiedAt: null };
    signOut = async () => 4;
    const res = await operatorSets(true);
    expect(res.status).toBe(200);
    expect(signOutCalls).toEqual([[ACCOUNT, 'operator-1']]);
    expect(audited()).toEqual([['admin.account.sso_domain.set', 4, true]]);
  });

  test('a failed sign-out keeps the verification, audits revoked_sessions null, and answers 500', async () => {
    current = { ...provider, domainVerifiedAt: null };
    signOut = failing;
    const res = await operatorSets(true);
    expect(res.status).toBe(500);
    expect((await res.json()).code).toBe('sso_sign_out_failed');
    expect(current.domainVerifiedAt).not.toBeNull();
    expect(audited()).toEqual([['admin.account.sso_domain.set', null, true]]);
  });

  test('break-glass (unverify) runs no sign-out, so a database fault there cannot turn it into a 500', async () => {
    signOut = failing;
    const res = await operatorSets(false);
    expect(res.status).toBe(200);
    expect((await res.json()).domain_verified).toBe(false);
    expect(signOutCalls).toEqual([]);
    expect(audited()).toEqual([['admin.account.sso_domain.set', 0, false]]);
  });
});
