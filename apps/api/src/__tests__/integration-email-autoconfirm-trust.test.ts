/**
 * Integration test (real local DB): while Auth auto-confirms sign-ups
 * (`ENABLE_EMAIL_AUTOCONFIRM=true`, a self-host with no email provider), a
 * password identity's email proves nothing. Anyone who reaches the instance can
 * sign up as a colleague's address first (KRTX-1715 path C). So that email
 * does not claim a pending invite at sign-in, does not bind a SCIM user, and
 * does not resolve an add-by-email. An identity the account already holds as a
 * member, and an identity from the account's own IdP, still resolve inside that
 * account. With the fact unset (cloud), nothing changes.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { accountInvitations, accountMemberships, accountSsoProviders, accounts, creditAccounts } from '@kortix/db';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { config } from '../config';
import { db } from '../shared/db';
import { autoClaimPendingInvites } from '../accounts/core/app';
import { resolveAccountIdentityByEmail } from '../iam/account-identity';
import { trustedEmailForUser } from '../iam/email-trust';
import { createScimToken } from '../repositories/scim';
import { userIdByEmail } from '../scim/app';

const { app } = await import('../index');

const ACCOUNT = crypto.randomUUID();
// The account's standing owner. Deleting a test's last real Auth user would
// otherwise let the auth.users delete trigger reclaim the account mid-suite.
const ANCHOR_OWNER = crypto.randomUUID();
const OWN_IDP = crypto.randomUUID(); // the account's own Supabase sso_providers id
const ORIGINAL = config.ENABLE_EMAIL_AUTOCONFIRM;

const email = (slug: string) => `${slug}-${crypto.randomUUID()}@example.test`;

/** An auth user as Supabase writes it: a password sign-up, or a SAML sign-in through `idp`. */
async function authUser(address: string, idp?: string): Promise<string> {
  const id = crypto.randomUUID();
  const appMeta = idp
    ? { provider: `sso:${idp}`, providers: [`sso:${idp}`] }
    : { provider: 'email', providers: ['email'] };
  await db.execute(sql`
    INSERT INTO auth.users (id, email, is_sso_user, raw_app_meta_data, email_confirmed_at)
    VALUES (${id}::uuid, ${address}, ${Boolean(idp)}, ${JSON.stringify(appMeta)}::jsonb, now())
  `);
  return id;
}

async function invite(address: string): Promise<string> {
  const [row] = await db
    .insert(accountInvitations)
    .values({ accountId: ACCOUNT, email: address, expiresAt: new Date(Date.now() + 86_400_000) })
    .returning({ inviteId: accountInvitations.inviteId });
  return row!.inviteId;
}

async function isMember(userId: string): Promise<boolean> {
  const rows = await db
    .select({ userId: accountMemberships.userId })
    .from(accountMemberships)
    .where(and(eq(accountMemberships.accountId, ACCOUNT), eq(accountMemberships.userId, userId)));
  return rows.length === 1;
}

function autoconfirm(on: boolean) {
  (config as { ENABLE_EMAIL_AUTOCONFIRM: boolean }).ENABLE_EMAIL_AUTOCONFIRM = on;
}

/** SCIM POST /Users, as the account's IdP sends it. */
async function scimCreateUser(address: string): Promise<Response> {
  const { secret } = await createScimToken({ accountId: ACCOUNT, name: `autoconfirm-${crypto.randomUUID()}`, createdBy: ANCHOR_OWNER });
  return app.request(`/scim/v2/accounts/${ACCOUNT}/Users`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/scim+json' },
    body: JSON.stringify({ schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'], userName: address, active: true }),
  });
}

async function pendingInvites(address: string): Promise<number> {
  const rows = await db
    .select({ inviteId: accountInvitations.inviteId })
    .from(accountInvitations)
    .where(and(eq(accountInvitations.accountId, ACCOUNT), eq(accountInvitations.email, address), isNull(accountInvitations.acceptedAt)));
  return rows.length;
}

beforeAll(async () => {
  await db.insert(accounts).values({ accountId: ACCOUNT, name: 'email-autoconfirm-trust' });
  // SCIM needs the Enterprise `scim` entitlement.
  await db.insert(creditAccounts).values({ accountId: ACCOUNT, demoEnterprise: true });
  await db.execute(sql`INSERT INTO auth.users (id, email) VALUES (${ANCHOR_OWNER}::uuid, ${email('anchor')})`);
  await db.insert(accountMemberships).values({ accountId: ACCOUNT, userId: ANCHOR_OWNER });
  // The account's own IdP, with its domain NOT verified: inside its own account
  // the IdP and the admin are the same authority.
  await db.insert(accountSsoProviders).values({
    ssoProviderId: crypto.randomUUID(),
    accountId: ACCOUNT,
    supabaseSsoProviderId: OWN_IDP,
    name: 'Own IdP',
    primaryDomain: 'example.test',
  });
});

afterEach(() => autoconfirm(ORIGINAL));

afterAll(async () => {
  autoconfirm(ORIGINAL);
  await db.delete(accounts).where(eq(accounts.accountId, ACCOUNT));
  await db.execute(sql`DELETE FROM auth.users WHERE id=${ANCHOR_OWNER}::uuid`);
});

describe('email autoconfirm off (cloud, or a self-host with email)', () => {
  test('a password email binds SCIM, resolves add-by-email, and claims its invite at sign-in', async () => {
    autoconfirm(false);
    const address = email('colleague');
    const user = await authUser(address);
    await invite(address);

    expect(await userIdByEmail(address, ACCOUNT)).toBe(user);
    expect(await resolveAccountIdentityByEmail(ACCOUNT, address)).toEqual({ userId: user, ambiguous: false });
    expect(await trustedEmailForUser(user)).toBe(address);
    expect(await autoClaimPendingInvites(user, address)).toBe(1);
    expect(await isMember(user)).toBe(true);
  });
});

describe('email autoconfirm on (a self-host with no email provider)', () => {
  test('a password email is unproven: no SCIM bind, no add-by-email match, no invite claimed at sign-in', async () => {
    autoconfirm(true);
    const address = email('stranger-as-colleague');
    const stranger = await authUser(address);
    const inviteId = await invite(address);

    expect(await userIdByEmail(address, ACCOUNT)).toBeNull();
    expect(await userIdByEmail(address)).toBeNull();
    expect(await resolveAccountIdentityByEmail(ACCOUNT, address)).toEqual({ userId: null, ambiguous: false });
    expect(await trustedEmailForUser(stranger)).toBe('');
    expect(await autoClaimPendingInvites(stranger, address)).toBe(0);
    expect(await isMember(stranger)).toBe(false);
    const [row] = await db
      .select({ acceptedAt: accountInvitations.acceptedAt })
      .from(accountInvitations)
      .where(eq(accountInvitations.inviteId, inviteId));
    expect(row?.acceptedAt).toBeNull();
  });

  test('an identity the account already holds as a member still resolves inside that account', async () => {
    autoconfirm(true);
    const address = email('member');
    const member = await authUser(address);
    await db.insert(accountMemberships).values({ accountId: ACCOUNT, userId: member });

    // Add-by-email answers "already a member" instead of a second invite, and
    // SCIM links the member it already has.
    expect(await resolveAccountIdentityByEmail(ACCOUNT, address)).toEqual({ userId: member, ambiguous: false });
    expect(await userIdByEmail(address, ACCOUNT)).toBe(member);
    // Outside that account the email still proves nothing.
    expect(await userIdByEmail(address)).toBeNull();
    expect(await trustedEmailForUser(member)).toBe('');
  });

  test("an identity from the account's own IdP still resolves", async () => {
    autoconfirm(true);
    const address = email('own-idp');
    const viaOwnIdp = await authUser(address, OWN_IDP);

    expect(await resolveAccountIdentityByEmail(ACCOUNT, address)).toEqual({ userId: viaOwnIdp, ambiguous: false });
    expect(await userIdByEmail(address, ACCOUNT)).toBe(viaOwnIdp);
  });

  test('the explicit invite routes still read the email (an open decision, KRTX-1715)', async () => {
    autoconfirm(true);
    const address = email('explicit');
    const user = await authUser(address);

    expect(await trustedEmailForUser(user, { allowAutoconfirmed: true })).toBe(address);
  });
});

describe('SCIM POST /Users over HTTP', () => {
  test('autoconfirm off: the password identity is bound as a member → 201', async () => {
    autoconfirm(false);
    const address = email('scim-off');
    const user = await authUser(address);

    const res = await scimCreateUser(address);
    expect(res.status).toBe(201);
    expect(((await res.json()) as { id: string }).id).toBe(user);
    expect(await isMember(user)).toBe(true);
    expect(await pendingInvites(address)).toBe(0);
  });

  test('autoconfirm on: an address held only by a password identity → 201 with a pending invite, no membership', async () => {
    autoconfirm(true);
    const address = email('scim-on');
    const stranger = await authUser(address);

    const res = await scimCreateUser(address);
    expect(res.status).toBe(201);
    expect(((await res.json()) as { id: string }).id).not.toBe(stranger);
    expect(await isMember(stranger)).toBe(false);
    expect(await pendingInvites(address)).toBe(1);
  });
});
