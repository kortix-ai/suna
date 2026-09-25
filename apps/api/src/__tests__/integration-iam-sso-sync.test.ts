/**
 * Integration test (real local DB): the Azure AD / Entra directory-sync chain,
 * end to end. This is the "SSO/directory-sync with Azure works" proof.
 *
 * Chain: SAML JWT (Entra `memberOf` claim) → syncSsoMembership JIT-provisions the
 * account member + syncs IAM group memberships from the mapped claim values →
 * the group's project_group_grants confer a project role → authorize lets the
 * user act. Removing the claim (removed from the group in Entra) revokes it.
 *
 * Fully isolated: a fresh account + project + SSO provider + group mapping seeded
 * here and torn down after.
 */
import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import { and, eq, sql } from 'drizzle-orm';
import {
  accountGroupMembers,
  accountGroups,
  accountMemberships,
  accountScimUsers,
  accountSecretGrants,
  accountSecretResources,
  accountMembers,
  accountSsoGroupMappings,
  accountSsoProviders,
  accounts,
  projectGroupGrants,
  projects,
  projectSessions,
} from '@kortix/db';
import { db } from '../shared/db';
import { syncSsoMembership } from '../iam/sso-sync';
import { assignRole, SYSTEM_ACTOR } from '../iam/assignments';
import { resolveAccountIdentityByEmail } from '../iam/account-identity';
import { authorize } from '../iam/authorize';
import { actorForUser } from '../iam/actor';
import { PROJECT_ACTIONS } from '../iam';

const ACCOUNT = crypto.randomUUID();
const PROJECT = crypto.randomUUID();
const SUPA_SSO = crypto.randomUUID(); // stands in for the Supabase auth.sso_providers id
const MKT_GROUP = crypto.randomUUID();
const AAD_CLAIM = 'Marketing-AAD'; // what Entra ships in the memberOf claim

// A real-shape Supabase SAML JWT: the auth sso_providers id rides in
// `app_metadata.provider` as "sso:<uuid>" (NOT a bare provider_id — no real
// Supabase token sets that), and the SAML group attribute (Entra `memberOf`)
// is wrapped under app_metadata.
const jwt = (memberOf: string[]) => ({
  app_metadata: {
    provider: `sso:${SUPA_SSO}`,
    providers: [`sso:${SUPA_SSO}`],
    memberOf,
  },
});

const canWrite = async (userId: string) =>
  (await authorize(actorForUser(userId, ACCOUNT), PROJECT_ACTIONS.PROJECT_WRITE, { type: 'project', id: PROJECT })).allowed;

beforeAll(async () => {
  await db.insert(accounts).values({ accountId: ACCOUNT, name: 'sso-sync-test' });
  await db.insert(projects).values({ projectId: PROJECT, accountId: ACCOUNT, name: 'p', repoUrl: 'https://example.com/p.git' });
  await db.insert(accountGroups).values({ groupId: MKT_GROUP, accountId: ACCOUNT, name: 'Marketing', source: 'sso' });
  // The group grants MANAGER on the project — this is the admin-configured
  // group→project→role binding the synced membership rides on.
  await db.insert(projectGroupGrants).values({ projectId: PROJECT, groupId: MKT_GROUP, accountId: ACCOUNT, role: 'manager' });
  await db.insert(accountSsoProviders).values({
    ssoProviderId: crypto.randomUUID(),
    accountId: ACCOUNT,
    supabaseSsoProviderId: SUPA_SSO,
    name: 'Azure AD',
    primaryDomain: 'acme-inc.com',
    groupClaimName: 'memberOf',
    autoCreateMembers: true,
    // Identity merges trust the asserted email only on a verified domain.
    domainVerifiedAt: new Date(),
  });
  await db.insert(accountSsoGroupMappings).values({
    accountId: ACCOUNT,
    ssoProviderId: (await db.select({ id: accountSsoProviders.ssoProviderId }).from(accountSsoProviders).where(eq(accountSsoProviders.accountId, ACCOUNT)).limit(1))[0]!.id,
    claimValue: AAD_CLAIM,
    groupId: MKT_GROUP,
  });
});

afterAll(async () => {
  await db.delete(projects).where(eq(projects.accountId, ACCOUNT));
  await db.delete(accounts).where(eq(accounts.accountId, ACCOUNT)); // cascades sso/mappings/groups/members
});

describe('Azure AD directory-sync → authorization', () => {
  test('first SAML login JITs the member, syncs the group, and confers the group role', async () => {
    const user = crypto.randomUUID();
    // Denied before any login (no member, no group).
    expect(await canWrite(user)).toBe(false);

    const out = await syncSsoMembership({ userId: user, email: 'jo@acme-inc.com', jwtPayload: jwt([AAD_CLAIM]) });
    expect(out.skipped).toBe(false);
    expect(out.memberCreated).toBe(true);
    expect(out.groupsAdded).toEqual([MKT_GROUP]);

    // Member + group rows now exist.
    const [member] = await db.select().from(accountMembers).where(and(eq(accountMembers.accountId, ACCOUNT), eq(accountMembers.userId, user)));
    expect(member).toBeTruthy();
    const gm = await db.select().from(accountGroupMembers).where(and(eq(accountGroupMembers.groupId, MKT_GROUP), eq(accountGroupMembers.userId, user)));
    expect(gm.length).toBe(1);

    // Full chain authorizes: Entra group → mapping → Kortix group → project grant.
    expect(await canWrite(user)).toBe(true);

    // Entra removes the user from the group → claim disappears on next login →
    // membership revoked (syncSsoMembership busts the cache), access gone.
    const out2 = await syncSsoMembership({ userId: user, email: 'jo@acme-inc.com', jwtPayload: jwt([]) });
    expect(out2.groupsRemoved).toEqual([MKT_GROUP]);
    expect(await canWrite(user)).toBe(false);
  });

  test('case-insensitive: Entra shipping a different casing still syncs the group', async () => {
    const user = crypto.randomUUID();
    const out = await syncSsoMembership({ userId: user, email: 'al@acme-inc.com', jwtPayload: jwt(['MARKETING-AAD']) });
    expect(out.groupsAdded).toEqual([MKT_GROUP]);
    expect(await canWrite(user)).toBe(true);
  });

  test('an unmapped claim value confers nothing (and still creates the member)', async () => {
    const user = crypto.randomUUID();
    const out = await syncSsoMembership({ userId: user, email: 'sam@acme-inc.com', jwtPayload: jwt(['Finance-AAD']) });
    expect(out.memberCreated).toBe(true);
    expect(out.groupsAdded ?? []).toEqual([]);
    expect(await canWrite(user)).toBe(false);
  });

  test('autoCreateMembers=false: an uninvited SSO user is not provisioned', async () => {
    await db.update(accountSsoProviders).set({ autoCreateMembers: false }).where(eq(accountSsoProviders.accountId, ACCOUNT));
    try {
      const user = crypto.randomUUID();
      const out = await syncSsoMembership({ userId: user, email: 'ghost@acme-inc.com', jwtPayload: jwt([AAD_CLAIM]) });
      expect(out.memberCreated).toBe(false);
      const rows = await db.select().from(accountMembers).where(and(eq(accountMembers.accountId, ACCOUNT), eq(accountMembers.userId, user)));
      expect(rows.length).toBe(0);
    } finally {
      await db.update(accountSsoProviders).set({ autoCreateMembers: true }).where(eq(accountSsoProviders.accountId, ACCOUNT));
    }
  });

  test('an active SCIM person moves from the old Auth id to the SSO Auth id', async () => {
    await db.update(accountSsoProviders).set({ autoCreateMembers: false }).where(eq(accountSsoProviders.accountId, ACCOUNT));
    const oldUser = crypto.randomUUID();
    const ssoUser = crypto.randomUUID();
    const sessionId = crypto.randomUUID();
    const secretId = crypto.randomUUID();
    try {
      await db.insert(accountMemberships).values({ accountId: ACCOUNT, userId: oldUser });
      await db.insert(accountSecretResources).values({
        secretId,
        accountId: ACCOUNT,
        label: 'Migrated provider key',
        name: 'PROVIDER_KEY',
        valueEnc: 'encrypted-test-value',
        consumer: 'sandbox',
        strategy: 'runtime',
        createdBy: oldUser,
      });
      await db.insert(accountSecretGrants).values({
        secretId,
        accountId: ACCOUNT,
        userId: oldUser,
        grantedBy: oldUser,
      });
      await db.insert(accountGroupMembers).values({ groupId: MKT_GROUP, userId: oldUser });
      await db.insert(accountScimUsers).values({
        accountId: ACCOUNT,
        scimId: crypto.randomUUID(),
        userId: oldUser,
        userName: 'linked@acme-inc.com',
        active: true,
      });
      await db.insert(projectSessions).values({
        sessionId,
        accountId: ACCOUNT,
        projectId: PROJECT,
        branchName: `identity-${sessionId}`,
        createdBy: oldUser,
        status: 'stopped',
      });

      const out = await syncSsoMembership({ userId: ssoUser, email: 'LINKED@acme-inc.com', jwtPayload: jwt([AAD_CLAIM]) });
      expect(out.memberCreated).toBe(true);
      expect((await db.select().from(accountMembers).where(and(eq(accountMembers.accountId, ACCOUNT), eq(accountMembers.userId, oldUser)))).length).toBe(0);
      expect((await db.select().from(accountMembers).where(and(eq(accountMembers.accountId, ACCOUNT), eq(accountMembers.userId, ssoUser)))).length).toBe(1);
      expect((await db.select().from(accountGroupMembers).where(and(eq(accountGroupMembers.groupId, MKT_GROUP), eq(accountGroupMembers.userId, oldUser)))).length).toBe(0);
      expect((await db.select().from(accountGroupMembers).where(and(eq(accountGroupMembers.groupId, MKT_GROUP), eq(accountGroupMembers.userId, ssoUser)))).length).toBe(1);
      expect((await db.select().from(accountScimUsers).where(and(eq(accountScimUsers.accountId, ACCOUNT), eq(accountScimUsers.userId, ssoUser)))).length).toBe(1);
      expect((await db.select().from(projectSessions).where(and(eq(projectSessions.sessionId, sessionId), eq(projectSessions.createdBy, ssoUser)))).length).toBe(1);
      expect((await db.select().from(accountSecretGrants).where(and(eq(accountSecretGrants.secretId, secretId), eq(accountSecretGrants.userId, oldUser)))).length).toBe(0);
      expect((await db.select().from(accountSecretGrants).where(and(eq(accountSecretGrants.secretId, secretId), eq(accountSecretGrants.userId, ssoUser)))).length).toBe(1);
    } finally {
      await db.update(accountSsoProviders).set({ autoCreateMembers: true }).where(eq(accountSsoProviders.accountId, ACCOUNT));
    }
  });

  test('one existing account member with the same email moves to the SSO Auth id', async () => {
    await db.update(accountSsoProviders).set({ autoCreateMembers: false }).where(eq(accountSsoProviders.accountId, ACCOUNT));
    const oldUser = crypto.randomUUID();
    const ssoUser = crypto.randomUUID();
    const email = `manual-${oldUser}@acme-inc.com`;
    try {
      await db.execute(sql`INSERT INTO auth.users (id, email) VALUES (${oldUser}::uuid, ${email})`);
      await db.insert(accountMemberships).values({ accountId: ACCOUNT, userId: oldUser });

      const out = await syncSsoMembership({ userId: ssoUser, email: email.toUpperCase(), jwtPayload: jwt([]) });
      expect(out.memberCreated).toBe(true);
      expect((await db.select().from(accountMembers).where(and(eq(accountMembers.accountId, ACCOUNT), eq(accountMembers.userId, oldUser)))).length).toBe(0);
      expect((await db.select().from(accountMembers).where(and(eq(accountMembers.accountId, ACCOUNT), eq(accountMembers.userId, ssoUser)))).length).toBe(1);
    } finally {
      await db.execute(sql`DELETE FROM auth.users WHERE id=${oldUser}::uuid`);
      await db.update(accountSsoProviders).set({ autoCreateMembers: true }).where(eq(accountSsoProviders.accountId, ACCOUNT));
    }
  });

  test('every legacy Auth id for one email moves to the current SSO Auth id', async () => {
    await db.update(accountSsoProviders).set({ autoCreateMembers: false }).where(eq(accountSsoProviders.accountId, ACCOUNT));
    const oldUsers = [crypto.randomUUID(), crypto.randomUUID()];
    const ssoUser = crypto.randomUUID();
    const email = `duplicates-${ssoUser}@acme-inc.com`;
    const sessionIds: string[] = oldUsers.map(() => crypto.randomUUID());
    try {
      for (const [index, oldUser] of oldUsers.entries()) {
        await db.execute(sql`
          INSERT INTO auth.users (id, email, is_sso_user)
          VALUES (${oldUser}::uuid, ${email}, ${index === 1})
        `);
        await db.insert(accountMemberships).values({ accountId: ACCOUNT, userId: oldUser });
      }
      await db.insert(projectSessions).values(oldUsers.map((oldUser, index) => {
        const sessionId = sessionIds[index];
        if (!sessionId) throw new Error(`Missing session id at index ${index}`);
        return {
          sessionId,
          accountId: ACCOUNT,
          projectId: PROJECT,
          branchName: `identity-${sessionId}`,
          createdBy: oldUser,
          status: 'stopped' as const,
        };
      }));

      const out = await syncSsoMembership({ userId: ssoUser, email: email.toUpperCase(), jwtPayload: jwt([]) });
      expect(out.memberCreated).toBe(true);
      for (const oldUser of oldUsers) {
        expect((await db.select().from(accountMembers).where(and(eq(accountMembers.accountId, ACCOUNT), eq(accountMembers.userId, oldUser)))).length).toBe(0);
      }
      expect((await db.select().from(accountMembers).where(and(eq(accountMembers.accountId, ACCOUNT), eq(accountMembers.userId, ssoUser)))).length).toBe(1);
      expect((await db.select().from(projectSessions).where(and(eq(projectSessions.accountId, ACCOUNT), eq(projectSessions.createdBy, ssoUser)))).filter((session) => sessionIds.includes(session.sessionId)).length).toBe(2);
    } finally {
      await db.execute(sql`DELETE FROM auth.users WHERE id IN (${sql.join(oldUsers.map((id) => sql`${id}::uuid`), sql`, `)})`);
      await db.update(accountSsoProviders).set({ autoCreateMembers: true }).where(eq(accountSsoProviders.accountId, ACCOUNT));
    }
  });

  test('a migrated session owner without a membership moves on first SSO login', async () => {
    await db.update(accountSsoProviders).set({ autoCreateMembers: false }).where(eq(accountSsoProviders.accountId, ACCOUNT));
    const oldUser = crypto.randomUUID();
    const ssoUser = crypto.randomUUID();
    const sessionId = crypto.randomUUID();
    const email = `orphan-owner-${ssoUser}@acme-inc.com`;
    try {
      await db.execute(sql`INSERT INTO auth.users (id, email) VALUES (${oldUser}::uuid, ${email})`);
      await db.insert(projectSessions).values({
        sessionId,
        accountId: ACCOUNT,
        projectId: PROJECT,
        branchName: `identity-${sessionId}`,
        createdBy: oldUser,
        status: 'stopped',
      });

      const out = await syncSsoMembership({ userId: ssoUser, email, jwtPayload: jwt([]) });
      expect(out.memberCreated).toBe(true);
      expect((await db.select().from(accountMembers).where(and(eq(accountMembers.accountId, ACCOUNT), eq(accountMembers.userId, ssoUser)))).length).toBe(1);
      expect((await db.select().from(projectSessions).where(and(eq(projectSessions.sessionId, sessionId), eq(projectSessions.createdBy, ssoUser)))).length).toBe(1);
    } finally {
      await db.execute(sql`DELETE FROM auth.users WHERE id=${oldUser}::uuid`);
      await db.update(accountSsoProviders).set({ autoCreateMembers: true }).where(eq(accountSsoProviders.accountId, ACCOUNT));
    }
  });

  test('an unverified domain never merges an existing identity into the SSO identity', async () => {
    await db.update(accountSsoProviders).set({ domainVerifiedAt: null }).where(eq(accountSsoProviders.accountId, ACCOUNT));
    const oldUser = crypto.randomUUID();
    const ssoUser = crypto.randomUUID();
    const email = `unverified-${ssoUser}@acme-inc.com`;
    try {
      await db.execute(sql`INSERT INTO auth.users (id, email) VALUES (${oldUser}::uuid, ${email})`);
      await db.insert(accountMemberships).values({ accountId: ACCOUNT, userId: oldUser });

      const out = await syncSsoMembership({ userId: ssoUser, email, jwtPayload: jwt([]) });
      expect(out.memberCreated).toBe(true);
      expect((await db.select().from(accountMembers).where(and(eq(accountMembers.accountId, ACCOUNT), eq(accountMembers.userId, oldUser)))).length).toBe(1);
      expect((await db.select().from(accountMembers).where(and(eq(accountMembers.accountId, ACCOUNT), eq(accountMembers.userId, ssoUser)))).length).toBe(1);
    } finally {
      await db.execute(sql`DELETE FROM auth.users WHERE id=${oldUser}::uuid`);
      await db.update(accountSsoProviders).set({ domainVerifiedAt: new Date() }).where(eq(accountSsoProviders.accountId, ACCOUNT));
    }
  });

  test('an owner or a super-admin with the same email is never merged into the SSO identity', async () => {
    const owner = crypto.randomUUID();
    const superAdmin = crypto.randomUUID();
    const ownerSso = crypto.randomUUID();
    const superAdminSso = crypto.randomUUID();
    const ownerEmail = `owner-${owner}@acme-inc.com`;
    const superAdminEmail = `super-${superAdmin}@acme-inc.com`;
    try {
      await db.execute(sql`INSERT INTO auth.users (id, email) VALUES (${owner}::uuid, ${ownerEmail}), (${superAdmin}::uuid, ${superAdminEmail})`);
      await db.insert(accountMemberships).values({ accountId: ACCOUNT, userId: owner });
      await assignRole(SYSTEM_ACTOR, ACCOUNT, {
        principal: { type: 'user', id: owner },
        roleKey: 'owner',
        scope: { type: 'account' },
        exclusive: true,
      });
      await db.insert(accountMemberships).values({ accountId: ACCOUNT, userId: superAdmin, isSuperAdmin: true });

      await syncSsoMembership({ userId: ownerSso, email: ownerEmail, jwtPayload: jwt([]) });
      await syncSsoMembership({ userId: superAdminSso, email: superAdminEmail, jwtPayload: jwt([]) });

      const [ownerRow] = await db.select().from(accountMembers).where(and(eq(accountMembers.accountId, ACCOUNT), eq(accountMembers.userId, owner)));
      expect(ownerRow?.accountRole).toBe('owner');
      const [ownerSsoRow] = await db.select().from(accountMembers).where(and(eq(accountMembers.accountId, ACCOUNT), eq(accountMembers.userId, ownerSso)));
      expect(ownerSsoRow?.accountRole).toBe('member');
      const [superRow] = await db.select().from(accountMembers).where(and(eq(accountMembers.accountId, ACCOUNT), eq(accountMembers.userId, superAdmin)));
      expect(superRow?.isSuperAdmin).toBe(true);
      const [superSsoRow] = await db.select().from(accountMembers).where(and(eq(accountMembers.accountId, ACCOUNT), eq(accountMembers.userId, superAdminSso)));
      expect(superSsoRow?.isSuperAdmin).toBe(false);
    } finally {
      await db.execute(sql`DELETE FROM kortix.role_assignments WHERE account_id=${ACCOUNT}::uuid AND principal_id IN (${owner}::uuid, ${superAdmin}::uuid, ${ownerSso}::uuid, ${superAdminSso}::uuid)`);
      await db.execute(sql`DELETE FROM auth.users WHERE id IN (${owner}::uuid, ${superAdmin}::uuid)`);
    }
  });

  test('email admission ignores another account\'s SSO identity whose domain is unverified', async () => {
    const foreignAccount = crypto.randomUUID();
    const foreignProvider = crypto.randomUUID();
    const foreignSsoUser = crypto.randomUUID();
    const email = `foreign-${foreignSsoUser}@elsewhere.test`;
    try {
      await db.insert(accounts).values({ accountId: foreignAccount, name: 'foreign-idp' });
      await db.insert(accountSsoProviders).values({
        accountId: foreignAccount,
        supabaseSsoProviderId: foreignProvider,
        name: 'Foreign IdP',
        primaryDomain: 'foreign-idp.test',
      });
      await db.execute(sql`
        INSERT INTO auth.users (id, email, is_sso_user, raw_app_meta_data)
        VALUES (${foreignSsoUser}::uuid, ${email}, true, ${JSON.stringify({ provider: `sso:${foreignProvider}`, providers: [`sso:${foreignProvider}`] })}::jsonb)
      `);
      expect(await resolveAccountIdentityByEmail(ACCOUNT, email)).toEqual({ userId: null, ambiguous: false });

      // Verified, but for a different domain than the email's: still not proof.
      await db.update(accountSsoProviders).set({ domainVerifiedAt: new Date() }).where(eq(accountSsoProviders.accountId, foreignAccount));
      expect(await resolveAccountIdentityByEmail(ACCOUNT, email)).toEqual({ userId: null, ambiguous: false });

      // Verified for the email's own domain: the IdP vouches for the address.
      await db.update(accountSsoProviders).set({ primaryDomain: 'elsewhere.test' }).where(eq(accountSsoProviders.accountId, foreignAccount));
      expect(await resolveAccountIdentityByEmail(ACCOUNT, email)).toEqual({ userId: foreignSsoUser, ambiguous: false });
    } finally {
      await db.execute(sql`DELETE FROM auth.users WHERE id=${foreignSsoUser}::uuid`);
      await db.delete(accounts).where(eq(accounts.accountId, foreignAccount));
    }
  });

  test('email admission resolves the account SSO identity before a manual Auth identity', async () => {
    const manualUser = crypto.randomUUID();
    const ssoUser = crypto.randomUUID();
    const email = `resolve-${ssoUser}@acme-inc.com`;
    try {
      await db.execute(sql`
        INSERT INTO auth.users (id, email, is_sso_user, raw_app_meta_data)
        VALUES
          (${manualUser}::uuid, ${email}, false, '{}'::jsonb),
          (${ssoUser}::uuid, ${email}, true, ${JSON.stringify({ provider: `sso:${SUPA_SSO}`, providers: [`sso:${SUPA_SSO}`] })}::jsonb)
      `);
      await db.insert(accountMemberships).values({ accountId: ACCOUNT, userId: manualUser });
      await db.insert(accountScimUsers).values({
        accountId: ACCOUNT,
        scimId: crypto.randomUUID(),
        userId: manualUser,
        userName: email,
        active: true,
      });

      expect(await resolveAccountIdentityByEmail(ACCOUNT, email.toUpperCase())).toEqual({
        userId: ssoUser,
        ambiguous: false,
      });
    } finally {
      await db.execute(sql`DELETE FROM auth.users WHERE id IN (${manualUser}::uuid, ${ssoUser}::uuid)`);
    }
  });

  test('autoProvisionGroups: an UNMAPPED claim auto-creates the IAM group + mapping and joins the user', async () => {
    await db.update(accountSsoProviders).set({ autoProvisionGroups: true }).where(eq(accountSsoProviders.accountId, ACCOUNT));
    try {
      const user = crypto.randomUUID();
      const claim = 'Engineering-AAD'; // not mapped by beforeAll — auto-provision must create it

      const out = await syncSsoMembership({ userId: user, email: 'eng@acme-inc.com', jwtPayload: jwt([claim]) });
      expect(out.memberCreated).toBe(true);

      // A group named after the claim was auto-created with source 'sso'.
      const [grp] = await db
        .select()
        .from(accountGroups)
        .where(and(eq(accountGroups.accountId, ACCOUNT), eq(accountGroups.name, claim)));
      expect(grp).toBeTruthy();
      expect(grp.source).toBe('sso');

      // A claim->group mapping was created, and the user joined the group this run.
      const [map] = await db
        .select()
        .from(accountSsoGroupMappings)
        .where(and(eq(accountSsoGroupMappings.accountId, ACCOUNT), eq(accountSsoGroupMappings.claimValue, claim)));
      expect(map?.groupId).toBe(grp.groupId);
      expect(out.groupsAdded).toEqual([grp.groupId]);
      const gm = await db.select().from(accountGroupMembers).where(and(eq(accountGroupMembers.groupId, grp.groupId), eq(accountGroupMembers.userId, user)));
      expect(gm.length).toBe(1);

      // Idempotent: a second user with the same claim reuses the one group — no duplicate.
      await syncSsoMembership({ userId: crypto.randomUUID(), email: 'eng2@acme-inc.com', jwtPayload: jwt([claim]) });
      const groups = await db.select().from(accountGroups).where(and(eq(accountGroups.accountId, ACCOUNT), eq(accountGroups.name, claim)));
      expect(groups.length).toBe(1);
    } finally {
      await db.update(accountSsoProviders).set({ autoProvisionGroups: false }).where(eq(accountSsoProviders.accountId, ACCOUNT));
    }
  });
});
