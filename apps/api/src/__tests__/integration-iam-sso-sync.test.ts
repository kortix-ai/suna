/**
 * Integration test (real local DB): the Azure AD / Entra directory-sync chain,
 * end to end. This is the "SSO/directory-sync with Azure works" proof.
 *
 * Chain: SAML JWT (Entra `memberOf` claim) → syncSsoMembership JIT-provisions the
 * account member + syncs IAM group memberships from the mapped claim values →
 * the group's project_group_grants confer a project role → authorizeV2 lets the
 * user act. Removing the claim (removed from the group in Entra) revokes it.
 *
 * Fully isolated: a fresh account + project + SSO provider + group mapping seeded
 * here and torn down after.
 */
import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import { and, eq } from 'drizzle-orm';
import {
  accountGroupMembers,
  accountGroups,
  accountMembers,
  accountSsoGroupMappings,
  accountSsoProviders,
  accounts,
  projectGroupGrants,
  projects,
} from '@kortix/db';
import { db } from '../shared/db';
import { syncSsoMembership } from '../iam/sso-sync';
import { authorizeV2 } from '../iam/engine-v2';
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
  (await authorizeV2(userId, ACCOUNT, PROJECT_ACTIONS.PROJECT_WRITE, { type: 'project', id: PROJECT })).allowed;

beforeAll(async () => {
  await db.insert(accounts).values({ accountId: ACCOUNT, name: 'sso-sync-test' });
  await db.insert(projects).values({ projectId: PROJECT, accountId: ACCOUNT, name: 'p', repoUrl: 'https://example.com/p.git' });
  await db.insert(accountGroups).values({ groupId: MKT_GROUP, accountId: ACCOUNT, name: 'Marketing', source: 'scim' });
  // The group grants EDITOR on the project — this is the admin-configured
  // group→project→role binding the synced membership rides on.
  await db.insert(projectGroupGrants).values({ projectId: PROJECT, groupId: MKT_GROUP, accountId: ACCOUNT, role: 'editor' });
  await db.insert(accountSsoProviders).values({
    ssoProviderId: crypto.randomUUID(),
    accountId: ACCOUNT,
    supabaseSsoProviderId: SUPA_SSO,
    name: 'Azure AD',
    primaryDomain: 'essentia-inc.com',
    groupClaimName: 'memberOf',
    autoCreateMembers: true,
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

    const out = await syncSsoMembership({ userId: user, email: 'jo@essentia-inc.com', jwtPayload: jwt([AAD_CLAIM]) });
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
    const out2 = await syncSsoMembership({ userId: user, email: 'jo@essentia-inc.com', jwtPayload: jwt([]) });
    expect(out2.groupsRemoved).toEqual([MKT_GROUP]);
    expect(await canWrite(user)).toBe(false);
  });

  test('case-insensitive: Entra shipping a different casing still syncs the group', async () => {
    const user = crypto.randomUUID();
    const out = await syncSsoMembership({ userId: user, email: 'al@essentia-inc.com', jwtPayload: jwt(['MARKETING-AAD']) });
    expect(out.groupsAdded).toEqual([MKT_GROUP]);
    expect(await canWrite(user)).toBe(true);
  });

  test('an unmapped claim value confers nothing (and still creates the member)', async () => {
    const user = crypto.randomUUID();
    const out = await syncSsoMembership({ userId: user, email: 'sam@essentia-inc.com', jwtPayload: jwt(['Finance-AAD']) });
    expect(out.memberCreated).toBe(true);
    expect(out.groupsAdded ?? []).toEqual([]);
    expect(await canWrite(user)).toBe(false);
  });

  test('autoCreateMembers=false: an uninvited SSO user is not provisioned', async () => {
    await db.update(accountSsoProviders).set({ autoCreateMembers: false }).where(eq(accountSsoProviders.accountId, ACCOUNT));
    try {
      const user = crypto.randomUUID();
      const out = await syncSsoMembership({ userId: user, email: 'ghost@essentia-inc.com', jwtPayload: jwt([AAD_CLAIM]) });
      expect(out.memberCreated).toBe(false);
      const rows = await db.select().from(accountMembers).where(and(eq(accountMembers.accountId, ACCOUNT), eq(accountMembers.userId, user)));
      expect(rows.length).toBe(0);
    } finally {
      await db.update(accountSsoProviders).set({ autoCreateMembers: true }).where(eq(accountSsoProviders.accountId, ACCOUNT));
    }
  });

  test('autoProvisionGroups: an UNMAPPED claim auto-creates the IAM group + mapping and joins the user', async () => {
    await db.update(accountSsoProviders).set({ autoProvisionGroups: true }).where(eq(accountSsoProviders.accountId, ACCOUNT));
    try {
      const user = crypto.randomUUID();
      const claim = 'Engineering-AAD'; // not mapped by beforeAll — auto-provision must create it

      const out = await syncSsoMembership({ userId: user, email: 'eng@essentia-inc.com', jwtPayload: jwt([claim]) });
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
      await syncSsoMembership({ userId: crypto.randomUUID(), email: 'eng2@essentia-inc.com', jwtPayload: jwt([claim]) });
      const groups = await db.select().from(accountGroups).where(and(eq(accountGroups.accountId, ACCOUNT), eq(accountGroups.name, claim)));
      expect(groups.length).toBe(1);
    } finally {
      await db.update(accountSsoProviders).set({ autoProvisionGroups: false }).where(eq(accountSsoProviders.accountId, ACCOUNT));
    }
  });
});
