/**
 * Integration test (real local DB): SSO only is enforced by `authorize` for
 * every credential of a person in the enforced domain (KRTX-1716). The web
 * sign-in form was the only gate; a JWT from a direct GoTrue password grant,
 * mobile or a social sign-in reached every route.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { PgClient } from './helpers/pg-client';
import { accountMembers, accountSessionActivity, accountSsoProviders, accounts, platformUserRoles, projects } from '@kortix/db';
import { db } from '../shared/db';
import { config } from '../config';
import { authorize, listAccessible, ssoRequiredFor } from '../iam/authorize';
import { actorForUser } from '../iam/actor';
import { PROJECT_ACTIONS } from '../iam';
import { invalidateIamCacheForAccount } from '../iam/cache-invalidation';
import { signOutNonSsoMembers } from '../repositories/sso';
import { getPlatformRole } from '../shared/platform-roles';
import { __setJwtLivenessLoaderForTests, confirmJwtLive, jwtLivenessCacheSize } from '../shared/jwt-liveness';
import { insertIntoView } from './helpers/compat-views';

const superuser = new PgClient({ connectionString: process.env.TEST_DATABASE_SUPERUSER_URL });
const ACCOUNT = crypto.randomUUID();
const PROJECT = crypto.randomUUID();
const IDP = crypto.randomUUID();
const DOMAIN = `sso-only-${crypto.randomUUID().slice(0, 8)}.test`;

/** An auth user and an account membership. `idp` makes it an identity of that IdP. */
async function person(email: string, opts: { role?: 'owner' | 'admin' | 'member'; superAdmin?: boolean; idp?: string } = {}) {
  const id = crypto.randomUUID();
  const appMeta = opts.idp ? { provider: `sso:${opts.idp}`, providers: [`sso:${opts.idp}`] } : { provider: 'email' };
  await superuser.query(
    `insert into auth.users (id, email, is_sso_user, raw_app_meta_data) values ($1, $2, $3, $4::jsonb)`,
    [id, email, !!opts.idp, JSON.stringify(appMeta)],
  );
  await insertIntoView(db, accountMembers, {
    userId: id,
    accountId: ACCOUNT,
    accountRole: opts.role ?? 'admin',
    ...(opts.superAdmin ? { isSuperAdmin: true } : {}),
  });
  return id;
}

async function enforce(enforceSso: boolean, verified: boolean) {
  await db
    .update(accountSsoProviders)
    .set({ enforceSso, domainVerifiedAt: verified ? new Date() : null })
    .where(eq(accountSsoProviders.accountId, ACCOUNT));
  await invalidateIamCacheForAccount(ACCOUNT);
}

const read = async (userId: string) =>
  authorize(actorForUser(userId, ACCOUNT), PROJECT_ACTIONS.PROJECT_READ, { type: 'project', id: PROJECT });

let passwordAdmin = '';
let passwordOwner = '';
let idpMember = '';
let otherDomain = '';
let otherIdp = '';

beforeAll(async () => {
  await superuser.connect();
  await db.insert(accounts).values({ accountId: ACCOUNT, name: 'sso-required-test' });
  await db.insert(projects).values({ projectId: PROJECT, accountId: ACCOUNT, name: 'p', repoUrl: 'https://example.com/p.git' });
  await db.insert(accountSsoProviders).values({
    accountId: ACCOUNT,
    supabaseSsoProviderId: IDP,
    name: 'Synthetic IdP',
    primaryDomain: DOMAIN,
    enforceSso: false,
  });
  passwordAdmin = await person(`admin@${DOMAIN}`);
  passwordOwner = await person(`owner@${DOMAIN}`, { role: 'owner', superAdmin: true });
  idpMember = await person(`member@${DOMAIN}`, { idp: IDP });
  otherDomain = await person(`someone@elsewhere-${crypto.randomUUID().slice(0, 8)}.test`);
  otherIdp = await person(`contractor@${DOMAIN}`, { idp: crypto.randomUUID() });
});

afterAll(async () => {
  await db.delete(projects).where(eq(projects.accountId, ACCOUNT));
  await db.delete(accounts).where(eq(accounts.accountId, ACCOUNT));
  await superuser.end();
});

describe('SSO only, enforced by authorize', () => {
  test('nothing is required while enforcement is off or the domain is unverified', async () => {
    await enforce(false, true);
    expect((await read(passwordAdmin)).allowed).toBe(true);
    await enforce(true, false);
    expect((await read(passwordAdmin)).allowed).toBe(true);
  });

  test('on a verified enforced domain a password identity is denied sso_required, the owner included', async () => {
    await enforce(true, true);
    expect(await read(passwordAdmin)).toEqual({ allowed: false, reason: 'sso_required' });
    // The account creator's super-admin bit must not skip the gate.
    expect(await read(passwordOwner)).toEqual({ allowed: false, reason: 'sso_required' });
    expect(await ssoRequiredFor(actorForUser(passwordOwner, ACCOUNT))).toBe(true);
    expect(await listAccessible(actorForUser(passwordAdmin, ACCOUNT), PROJECT_ACTIONS.PROJECT_READ, 'project')).toEqual({
      mode: 'none',
      reason: 'sso_required',
    });
  });

  test("the account's own IdP identity and a member outside the domain are allowed", async () => {
    await enforce(true, true);
    expect((await read(idpMember)).allowed).toBe(true);
    expect((await read(otherDomain)).allowed).toBe(true);
    expect(await ssoRequiredFor(actorForUser(idpMember, ACCOUNT))).toBe(false);
  });

  test("another IdP's identity in the enforced domain is denied", async () => {
    await enforce(true, true);
    expect(await read(otherIdp)).toEqual({ allowed: false, reason: 'sso_required' });
  });

  test('break-glass: marking the domain unverified lifts enforcement at once', async () => {
    await enforce(true, true);
    expect((await read(passwordOwner)).allowed).toBe(false);
    await enforce(true, false);
    expect((await read(passwordOwner)).allowed).toBe(true);
  });
});

/** One GoTrue sign-in: the session, its refresh token, and the account's activity row. */
async function signIn(userId: string): Promise<string> {
  const sessionId = crypto.randomUUID();
  await superuser.query(`insert into auth.sessions (id, user_id) values ($1, $2)`, [sessionId, userId]);
  await superuser.query(`insert into auth.refresh_tokens (token, user_id, session_id) values ($1, $2, $3)`, [
    crypto.randomUUID(),
    userId,
    sessionId,
  ]);
  await db.insert(accountSessionActivity).values({ accountId: ACCOUNT, userId, sessionId });
  return sessionId;
}

const liveSessions = async (ids: string[]) =>
  (await superuser.query<{ id: string }>(`select id::text from auth.sessions where id = any($1::uuid[])`, [ids])).rows.map((r) => r.id);
const liveRefreshTokens = async (ids: string[]) =>
  (await superuser.query<{ session_id: string }>(`select session_id::text from auth.refresh_tokens where session_id = any($1::uuid[])`, [ids])).rows.map(
    (r) => r.session_id,
  );

describe('turning SSO only on ends the sign-ins the gate refuses', () => {
  test('ends exactly the sign-ins of the people authorize denies sso_required, once', async () => {
    // An in-domain password identity that is not a member: the gate never sees it.
    const nonMember = crypto.randomUUID();
    await superuser.query(`insert into auth.users (id, email, raw_app_meta_data) values ($1, $2, '{"provider":"email"}'::jsonb)`, [
      nonMember,
      `outsider@${DOMAIN}`,
    ]);
    const people = { passwordAdmin, passwordOwner, idpMember, otherDomain, otherIdp, nonMember };
    const sessions: Record<string, string[]> = {};
    for (const [name, id] of Object.entries(people)) sessions[name] = [await signIn(id)];
    sessions.passwordAdmin.push(await signIn(passwordAdmin)); // two devices
    const all = Object.values(sessions).flat();

    await enforce(false, true);
    expect(await signOutNonSsoMembers(ACCOUNT, passwordOwner)).toBe(0);
    await enforce(true, false);
    expect(await signOutNonSsoMembers(ACCOUNT, passwordOwner)).toBe(0);
    expect((await liveSessions(all)).sort()).toEqual([...all].sort());

    await enforce(true, true);
    // A cached liveness answer for an ended sign-in must not outlive it on this replica.
    const ttl = config.SUPABASE_JWT_LIVENESS_TTL_MS;
    (config as { SUPABASE_JWT_LIVENESS_TTL_MS: number }).SUPABASE_JWT_LIVENESS_TTL_MS = 60_000;
    __setJwtLivenessLoaderForTests(async () => ({ id: passwordAdmin, email: `admin@${DOMAIN}` }));
    try {
      await confirmJwtLive('synthetic-access-token', undefined);
      expect(jwtLivenessCacheSize()).toBe(1);
      expect(await signOutNonSsoMembers(ACCOUNT, passwordOwner)).toBe(4);
      expect(jwtLivenessCacheSize()).toBe(0);
    } finally {
      (config as { SUPABASE_JWT_LIVENESS_TTL_MS: number }).SUPABASE_JWT_LIVENESS_TTL_MS = ttl;
      __setJwtLivenessLoaderForTests(null);
    }

    const ended = [...sessions.passwordAdmin, ...sessions.passwordOwner, ...sessions.otherIdp];
    const kept = [...sessions.idpMember, ...sessions.otherDomain, ...sessions.nonMember];
    const live = await liveSessions(all);
    expect([...live].sort()).toEqual([...kept].sort());
    // Deleting the session cascades to its refresh tokens: those sign-ins cannot renew.
    expect((await liveRefreshTokens(all)).sort()).toEqual([...kept].sort());
    // The ended set is the set the gate refuses, member by member.
    for (const name of ['passwordAdmin', 'passwordOwner', 'idpMember', 'otherDomain', 'otherIdp'] as const) {
      const refused = (await read(people[name])).reason === 'sso_required';
      expect({ name, ended: sessions[name].every((s) => !live.includes(s)) }).toEqual({ name, ended: refused });
    }

    const activity = await db
      .select({ sessionId: accountSessionActivity.sessionId, reason: accountSessionActivity.revokedReason, by: accountSessionActivity.revokedBy })
      .from(accountSessionActivity)
      .where(eq(accountSessionActivity.accountId, ACCOUNT));
    for (const row of activity) {
      expect(row).toEqual(
        ended.includes(row.sessionId)
          ? { sessionId: row.sessionId, reason: 'sso_enforced', by: passwordOwner }
          : { sessionId: row.sessionId, reason: null, by: null },
      );
    }

    // Idempotent: nothing is left to end, and break-glass restores nothing.
    expect(await signOutNonSsoMembers(ACCOUNT, passwordOwner)).toBe(0);
    await enforce(true, false);
    expect((await liveSessions(all)).sort()).toEqual([...kept].sort());
  });
});

describe('a platform admin keeps the sign-in break-glass needs', () => {
  test('the rule of getPlatformRole exempts the sign-in; the gate still refuses it on the account', async () => {
    const staff = await person(`staff@${DOMAIN}`);
    const operator = await person(`operator@${DOMAIN}`);
    await db.insert(platformUserRoles).values({ accountId: staff, role: 'admin' });
    const sessions = [staff, operator, otherIdp, passwordAdmin].map(async (id) => [id, await signIn(id)] as const);
    const sessionOf = Object.fromEntries(await Promise.all(sessions));
    const allowlist = process.env.KORTIX_PLATFORM_ADMIN_EMAILS;
    // The other IdP's contractor is allowlisted too, but an SSO identity never
    // matches the allowlist, so it stays a user and is signed out.
    process.env.KORTIX_PLATFORM_ADMIN_EMAILS = `operator@${DOMAIN}, contractor@${DOMAIN}`;
    try {
      expect(await Promise.all([staff, operator, otherIdp, passwordAdmin].map(getPlatformRole))).toEqual(['admin', 'admin', 'user', 'user']);
      await enforce(true, true);
      expect(await signOutNonSsoMembers(ACCOUNT, passwordOwner)).toBe(2);
    } finally {
      if (allowlist === undefined) delete process.env.KORTIX_PLATFORM_ADMIN_EMAILS;
      else process.env.KORTIX_PLATFORM_ADMIN_EMAILS = allowlist;
      await db.delete(platformUserRoles).where(eq(platformUserRoles.accountId, staff));
    }
    expect((await liveSessions(Object.values(sessionOf))).sort()).toEqual([sessionOf[staff], sessionOf[operator]].sort());
    expect(await read(staff)).toEqual({ allowed: false, reason: 'sso_required' });
    expect(await read(operator)).toEqual({ allowed: false, reason: 'sso_required' });
  });
});
