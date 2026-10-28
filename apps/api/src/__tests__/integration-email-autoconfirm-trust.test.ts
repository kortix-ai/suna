/**
 * Integration test (real local DB): while Auth auto-confirms sign-ups
 * (`ENABLE_EMAIL_AUTOCONFIRM=true`, a self-host with no email provider), a
 * password identity's email proves nothing. Anyone who reaches the instance can
 * sign up as a colleague's address first (KRTX-1715 path C). So that email
 * does not claim a pending invite at sign-in, does not bind a SCIM user, and
 * does not resolve an add-by-email. The SCIM invite created instead is not
 * listed to, accepted or declined by that email either. An identity the
 * account already holds as a member, and an identity from the account's own
 * IdP, still resolve inside that account. With the fact unset (cloud), nothing
 * changes.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { accountInvitations, accountMemberships, accountSsoProviders, accounts, creditAccounts } from '@kortix/db';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { config } from '../config';
import { db } from '../shared/db';
import { autoClaimPendingInvites } from '../accounts/core/app';
import { resolveAccountIdentityByEmail } from '../iam/account-identity';
import { trustedEmailForUser } from '../iam/email-trust';
import { createAccountToken } from '../repositories/account-tokens';
import { createScimToken } from '../repositories/scim';
import { assignRole, SYSTEM_ACTOR } from '../iam/assignments';
import { userIdByEmail } from '../ee/scim/app';

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

/** An invite a person sent (Members → Invite), as accounts/core/invites.ts writes it. */
async function invite(address: string): Promise<string> {
  const [row] = await db
    .insert(accountInvitations)
    .values({ accountId: ACCOUNT, email: address, invitedBy: ANCHOR_OWNER, expiresAt: new Date(Date.now() + 86_400_000) })
    .returning({ inviteId: accountInvitations.inviteId });
  return row!.inviteId;
}

// Personal accounts of the callers below, deleted with their tokens in afterAll.
const callerAccounts: string[] = [];

/** `user`'s own API client: a PAT on a personal account of theirs, never on ACCOUNT. */
async function caller(user: string) {
  await db.insert(accounts).values({ accountId: user, name: 'autoconfirm-invitee-personal' });
  await db.insert(accountMemberships).values({ accountId: user, userId: user });
  callerAccounts.push(user);
  const { secretKey } = await createAccountToken({ accountId: user, userId: user, name: 'autoconfirm-invitee' });
  return async (method: 'GET' | 'POST', path: string) => {
    const res = await app.request(path, { method, headers: { Authorization: `Bearer ${secretKey}` } });
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };
}

async function inviteIdFor(address: string): Promise<string> {
  const [row] = await db
    .select({ inviteId: accountInvitations.inviteId })
    .from(accountInvitations)
    .where(and(eq(accountInvitations.accountId, ACCOUNT), eq(accountInvitations.email, address)));
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
  await db.insert(creditAccounts).values({ accountId: ACCOUNT, tier: 'enterprise' });
  await db.execute(sql`INSERT INTO auth.users (id, email) VALUES (${ANCHOR_OWNER}::uuid, ${email('anchor')})`);
  await db.insert(accountMemberships).values({ accountId: ACCOUNT, userId: ANCHOR_OWNER });
  await assignRole(SYSTEM_ACTOR, ACCOUNT, {
    principal: { type: 'user', id: ANCHOR_OWNER },
    roleKey: 'owner',
    scope: { type: 'account' },
    exclusive: true,
  });
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
  if (callerAccounts.length > 0) {
    await db.execute(sql`DELETE FROM kortix.account_tokens WHERE account_id IN (${sql.join(callerAccounts.map((id) => sql`${id}::uuid`), sql`, `)})`);
    await db.delete(accounts).where(inArray(accounts.accountId, callerAccounts));
  }
  await db.execute(sql`DELETE FROM kortix.account_tokens WHERE account_id=${ACCOUNT}::uuid`);
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
});

describe('the invitee routes (/v1/account-invites) over HTTP', () => {
  test('autoconfirm on: the invite SCIM created for an address is not listed, described, accepted or declined by the password identity that holds it', async () => {
    autoconfirm(true);
    const address = email('scim-invite-stranger');
    const stranger = await authUser(address);
    expect((await scimCreateUser(address)).status).toBe(201);
    const inviteId = await inviteIdFor(address);
    const as = await caller(stranger);

    const list = await as('GET', '/v1/account-invites');
    expect(list.status).toBe(200);
    expect(list.body.invites.map((i: { invite_id: string }) => i.invite_id)).not.toContain(inviteId);
    const described = await as('GET', `/v1/account-invites/${inviteId}`);
    expect(described.status).toBe(200);
    // The describe names the way in: the account's own IdP, whatever the address's domain.
    expect(described.body).toMatchObject({
      email_matches_caller: false,
      account_id: null,
      email: null,
      reason: 'email_unconfirmed',
      sso_provider_id: OWN_IDP,
    });

    const accept = await as('POST', `/v1/account-invites/${inviteId}/accept`);
    expect(accept.status).toBe(403);
    expect(accept.body.code).toBe('email_unconfirmed');
    expect(await isMember(stranger)).toBe(false);
    const decline = await as('POST', `/v1/account-invites/${inviteId}/decline`);
    expect(decline.status).toBe(403);
    expect(decline.body.code).toBe('email_unconfirmed');
    expect(await pendingInvites(address)).toBe(1);
  });

  test('autoconfirm on: an invite a person sent is still listed and accepted by the password identity that holds the address', async () => {
    // The residual KRTX-1715 keeps: whoever signed up first as the address
    // accepts it. The /docs/host#unconfirmed-email-addresses page says so.
    autoconfirm(true);
    const address = email('person-invite');
    const holder = await authUser(address);
    const inviteId = await invite(address);
    const as = await caller(holder);

    expect((await as('GET', '/v1/account-invites')).body.invites.map((i: { invite_id: string }) => i.invite_id)).toContain(inviteId);
    expect((await as('GET', `/v1/account-invites/${inviteId}`)).body.email_matches_caller).toBe(true);
    expect((await as('POST', `/v1/account-invites/${inviteId}/accept`)).status).toBe(200);
    expect(await isMember(holder)).toBe(true);
  });

  test("autoconfirm on: an identity from the account's own IdP accepts the SCIM invite for an address outside the IdP's domain", async () => {
    // A directory guest: the IdP holds them under another company's address,
    // so the sign-in page cannot find the IdP from the address.
    autoconfirm(true);
    const address = `guest-${crypto.randomUUID()}@guest-company.test`;
    expect((await scimCreateUser(address)).status).toBe(201);
    const inviteId = await inviteIdFor(address);
    const guest = await authUser(address, OWN_IDP);
    const as = await caller(guest);

    const described = await as('GET', `/v1/account-invites/${inviteId}`);
    expect(described.body).toMatchObject({ email_matches_caller: true, email: address });
    expect(described.body.reason).toBeUndefined();
    expect((await as('POST', `/v1/account-invites/${inviteId}/accept`)).status).toBe(200);
    expect(await isMember(guest)).toBe(true);
  });

  test('autoconfirm on: an SSO identity from another IdP does not take the SCIM invite', async () => {
    autoconfirm(true);
    const address = email('other-idp');
    expect((await scimCreateUser(address)).status).toBe(201);
    const inviteId = await inviteIdFor(address);
    const outsider = await authUser(address, crypto.randomUUID());
    const as = await caller(outsider);

    expect((await as('GET', `/v1/account-invites/${inviteId}`)).body.email_matches_caller).toBe(false);
    expect((await as('POST', `/v1/account-invites/${inviteId}/accept`)).status).toBe(403);
    expect(await isMember(outsider)).toBe(false);
  });

  test("autoconfirm on: an admin's resend makes the SCIM invite one a person shares, and the password identity accepts it", async () => {
    autoconfirm(true);
    const address = email('scim-resent');
    expect((await scimCreateUser(address)).status).toBe(201);
    const inviteId = await inviteIdFor(address);
    const holder = await authUser(address);
    const as = await caller(holder);
    expect((await as('POST', `/v1/account-invites/${inviteId}/accept`)).status).toBe(403);

    const { secretKey } = await createAccountToken({ accountId: ACCOUNT, userId: ANCHOR_OWNER, name: 'autoconfirm-admin' });
    const resend = await app.request(`/v1/accounts/${ACCOUNT}/invites/${inviteId}/resend`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${secretKey}` },
    });
    expect(resend.status).toBe(200);

    expect((await as('GET', `/v1/account-invites/${inviteId}`)).body.email_matches_caller).toBe(true);
    expect((await as('POST', `/v1/account-invites/${inviteId}/accept`)).status).toBe(200);
    expect(await isMember(holder)).toBe(true);
  });

  test('a caller signed in as another address gets wrong_account and no SSO provider', async () => {
    autoconfirm(true);
    const address = email('scim-other-caller');
    expect((await scimCreateUser(address)).status).toBe(201);
    const inviteId = await inviteIdFor(address);
    const as = await caller(await authUser(email('someone-else')));

    expect((await as('GET', `/v1/account-invites/${inviteId}`)).body).toMatchObject({
      email_matches_caller: false,
      reason: 'wrong_account',
      sso_provider_id: null,
    });
    const accept = await as('POST', `/v1/account-invites/${inviteId}/accept`);
    expect(accept.status).toBe(403);
    expect(accept.body.code).toBe('wrong_account');
  });

  test('autoconfirm off: the invite SCIM created before the person signed up is listed and accepted', async () => {
    autoconfirm(false);
    const address = email('scim-invite-off');
    expect((await scimCreateUser(address)).status).toBe(201);
    const inviteId = await inviteIdFor(address);
    const user = await authUser(address);
    const as = await caller(user);

    expect((await as('GET', '/v1/account-invites')).body.invites.map((i: { invite_id: string }) => i.invite_id)).toContain(inviteId);
    expect((await as('POST', `/v1/account-invites/${inviteId}/accept`)).status).toBe(200);
    expect(await isMember(user)).toBe(true);
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
