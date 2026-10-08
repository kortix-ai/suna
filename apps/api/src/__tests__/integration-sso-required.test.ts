/**
 * Integration test (real local DB): SSO only is enforced by `authorize` for
 * every credential of a person in the enforced domain (KRTX-1716). The web
 * sign-in form was the only gate; a JWT from a direct GoTrue password grant,
 * mobile or a social sign-in reached every route.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { PgClient } from './helpers/pg-client';
import { accountMembers, accountSsoProviders, accounts, projects } from '@kortix/db';
import { db } from '../shared/db';
import { authorize, listAccessible, ssoRequiredFor } from '../iam/authorize';
import { actorForUser } from '../iam/actor';
import { PROJECT_ACTIONS } from '../iam';
import { invalidateIamCacheForAccount } from '../iam/cache-invalidation';
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
