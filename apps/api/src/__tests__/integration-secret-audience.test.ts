/**
 * Real-Postgres contract for a project secret value narrowed to an audience —
 * `secret` object grants in `kortix.role_assignments`, keyed by `secret_id`.
 *
 *   no grant              -> everyone in the project (every secret before this)
 *   member / group grants -> only those people: directly, or through their own
 *                            PRIVATE session. Never a shared session, a trigger,
 *                            or a reader with no person.
 *   [] again              -> everyone
 *
 * Exercised through the chokepoints every value read goes through:
 * `listResolvedProjectSecrets` (sandbox env), `getProjectSecretValueForConsumer`
 * (connector gateway, LLM gateway, git proxy, webhooks) and the pure winner
 * selection `resolveGrantedSecretSelection`.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  accountGroupMembers,
  accountGroups,
  accountMembers,
  accountTokens,
  accounts,
  projectSecrets,
  projectSessions,
  projects,
  roleAssignments,
  serviceAccounts,
} from '@kortix/db';
import { and, eq, isNull } from 'drizzle-orm';
import { assignRole, deleteProjectScopeAssignments, SYSTEM_ACTOR } from '../iam/assignments';
import { deleteResourceGrant } from '../iam/resource-grants';
import { deleteGroup } from '../repositories/iam';
import { deleteServiceAccount } from '../repositories/service-accounts';
import { clearAuthorizeCaches } from '../iam/authorize';
import {
  getProjectSecretValueForConsumer,
  listProjectSecrets,
  listResolvedProjectSecrets,
  writeSharedProjectSecret,
} from '../projects/secrets';
import { resolveGrantedSecretSelection } from '../projects/secrets/grant-policy';
import {
  clearSecretAudience,
  secretAudienceSubject,
  sessionPersonOnlyPlaintextSecrets,
  setSecretAudience,
} from '../projects/lib/secret-audience';
import { db } from '../shared/db';
import { insertIntoView } from './helpers/compat-views';

const ACCOUNT = crypto.randomUUID();
const PROJECT = crypto.randomUUID();
const FINANCE = crypto.randomUUID();
const OWNER = crypto.randomUUID();
const IN_FINANCE = crypto.randomUUID();
const TEAMMATE = crypto.randomUUID();
const OWNER_PRIVATE = crypto.randomUUID();
const OWNER_SHARED = crypto.randomUUID();
const OWNER_TRIGGER = crypto.randomUUID();
const OWNER_LEGACY = crypto.randomUUID();
const OWNER_CLEARED = crypto.randomUUID();
const AGENT_SA = crypto.randomUUID();
const OTHER_AGENT_SA = crypto.randomUUID();
const AGENT_TRIGGER = crypto.randomUUID();

async function secretIdOf(identifier: string): Promise<string> {
  const [row] = await db
    .select({ secretId: projectSecrets.secretId })
    .from(projectSecrets)
    .where(and(eq(projectSecrets.projectId, PROJECT), eq(projectSecrets.identifier, identifier)));
  return row!.secretId;
}

const onlyFor = async (identifier: string, principals: Parameters<typeof setSecretAudience>[0]['principals']) => {
  await setSecretAudience({
    accountId: ACCOUNT,
    projectId: PROJECT,
    secretId: await secretIdOf(identifier),
    principals,
    grantedBy: OWNER,
  });
  clearAuthorizeCaches();
};

/** The env a sandbox would receive for this subject, KEY -> value. */
async function envFor(personId: string | null, agentId: string | null = null): Promise<Record<string, string>> {
  const rows = await listResolvedProjectSecrets(PROJECT, null, { personId, agentId });
  return resolveGrantedSecretSelection(rows, 'all').env;
}

const viaConnector = (input: { actorUserId?: string; sessionId?: string }) =>
  getProjectSecretValueForConsumer({
    projectId: PROJECT,
    accountId: ACCOUNT,
    name: 'PAYROLL_API_TOKEN',
    consumer: 'connector',
    ...input,
  });

beforeAll(async () => {
  await db.insert(accounts).values({ accountId: ACCOUNT, name: 'secret-audience' });
  await db.insert(projects).values({
    projectId: PROJECT,
    accountId: ACCOUNT,
    name: 'secret-audience',
    repoUrl: 'https://example.test/secret-audience.git',
  });
  for (const userId of [OWNER, IN_FINANCE, TEAMMATE]) {
    await insertIntoView(db, accountMembers, { userId, accountId: ACCOUNT, accountRole: 'member' });
  }
  await db.insert(accountGroups).values({ groupId: FINANCE, accountId: ACCOUNT, name: 'Finance' });
  await db.insert(accountGroupMembers).values({ groupId: FINANCE, userId: IN_FINANCE });
  await db.insert(projectSessions).values([
    { sessionId: OWNER_PRIVATE, accountId: ACCOUNT, projectId: PROJECT, branchName: OWNER_PRIVATE, createdBy: OWNER, visibility: 'private' },
    { sessionId: OWNER_SHARED, accountId: ACCOUNT, projectId: PROJECT, branchName: OWNER_SHARED, createdBy: OWNER, visibility: 'project' },
    { sessionId: OWNER_TRIGGER, accountId: ACCOUNT, projectId: PROJECT, branchName: OWNER_TRIGGER, createdBy: OWNER, visibility: 'private', origin: 'trigger' },
  ]);
  // Two private sessions whose agent token carries NO on_behalf_of: one minted
  // before the column existed (no stamp), one a foreign prompt cleared (stamp).
  await db.insert(projectSessions).values([
    { sessionId: OWNER_LEGACY, accountId: ACCOUNT, projectId: PROJECT, branchName: OWNER_LEGACY, createdBy: OWNER, visibility: 'private', origin: 'user' },
    { sessionId: OWNER_CLEARED, accountId: ACCOUNT, projectId: PROJECT, branchName: OWNER_CLEARED, createdBy: OWNER, visibility: 'private', origin: 'user', metadata: { on_behalf_of_cleared_at: new Date().toISOString() } },
  ]);
  await db.insert(serviceAccounts).values({
    serviceAccountId: AGENT_SA, accountId: ACCOUNT, name: `agent-${AGENT_SA}`,
    secretHash: `sa-${AGENT_SA}`, publicPrefix: 'kortix_sa_audience', createdBy: OWNER,
  });
  // A trigger run of the agent: no person, but its token names the agent.
  await db.insert(projectSessions).values({
    sessionId: AGENT_TRIGGER, accountId: ACCOUNT, projectId: PROJECT, branchName: AGENT_TRIGGER,
    createdBy: OWNER, visibility: 'project', origin: 'trigger',
  });
  await db.insert(serviceAccounts).values({
    serviceAccountId: OTHER_AGENT_SA, accountId: ACCOUNT, name: `agent-${OTHER_AGENT_SA}`,
    secretHash: `sa-${OTHER_AGENT_SA}`, publicPrefix: 'kortix_sa_audience', createdBy: OWNER,
  });
  for (const sessionId of [OWNER_LEGACY, OWNER_CLEARED, AGENT_TRIGGER]) {
    await db.insert(accountTokens).values({
      accountId: ACCOUNT, userId: OWNER, name: 'agent session', projectId: PROJECT, sessionId,
      serviceAccountId: AGENT_SA, onBehalfOfUserId: null,
      publicKey: `pk_${sessionId.slice(0, 12)}`, secretKeyHash: `h_${sessionId}`,
      agentGrant: { agent: 'kortix', permissions: 'all', connectors: 'all', env: 'all' },
    });
  }
  // A runtime env var, and a connector credential (server-side only).
  await writeSharedProjectSecret({ projectId: PROJECT, name: 'MAPS_KEY', value: 'maps-team' });
  await writeSharedProjectSecret({ projectId: PROJECT, name: 'PAYROLL_API_TOKEN', value: 'payroll-owner', scope: 'connector' });
  clearAuthorizeCaches();
});

afterAll(async () => {
  await db.delete(accounts).where(eq(accounts.accountId, ACCOUNT));
});

describe('secret audience — who may use one value', () => {
  test('no grant: every person, and every reader with no person, gets the value', async () => {
    for (const person of [OWNER, TEAMMATE, null]) {
      expect((await envFor(person)).MAPS_KEY).toBe('maps-team');
    }
    expect((await listProjectSecrets(PROJECT)).MAPS_KEY).toBe('maps-team');
  });

  test('only the owner: the owner gets it, a teammate and a person-less reader do not', async () => {
    await onlyFor('MAPS_KEY', [{ principal_type: 'user', principal_id: OWNER }]);
    expect((await envFor(OWNER)).MAPS_KEY).toBe('maps-team');
    expect((await envFor(TEAMMATE)).MAPS_KEY).toBeUndefined();
    expect((await envFor(null)).MAPS_KEY).toBeUndefined();
    expect((await listProjectSecrets(PROJECT)).MAPS_KEY).toBeUndefined();
  });

  test('a group: its member gets it, nobody else', async () => {
    await onlyFor('MAPS_KEY', [{ principal_type: 'group', principal_id: FINANCE }]);
    expect((await envFor(IN_FINANCE)).MAPS_KEY).toBe('maps-team');
    expect((await envFor(OWNER)).MAPS_KEY).toBeUndefined();
  });

  test('[] widens it back to everyone', async () => {
    await onlyFor('MAPS_KEY', []);
    expect((await envFor(TEAMMATE)).MAPS_KEY).toBe('maps-team');
  });

  test('two values of one KEY: the value shared with the person wins, everyone else keeps the team value', async () => {
    await writeSharedProjectSecret({ projectId: PROJECT, name: 'MAPS_KEY', identifier: 'MAPS_KEY-owner', value: 'maps-owner' });
    await onlyFor('MAPS_KEY-owner', [{ principal_type: 'user', principal_id: OWNER }]);
    expect((await envFor(OWNER)).MAPS_KEY).toBe('maps-owner');
    expect((await envFor(TEAMMATE)).MAPS_KEY).toBe('maps-team');
    expect((await envFor(null)).MAPS_KEY).toBe('maps-team');
    // An explicit agent grant naming both identifiers is not ambiguous for the
    // owner: the ranks differ.
    const ownerRows = await listResolvedProjectSecrets(PROJECT, null, { personId: OWNER, agentId: null });
    expect(resolveGrantedSecretSelection(ownerRows, ['MAPS_KEY', 'MAPS_KEY-owner']).env.MAPS_KEY).toBe('maps-owner');
  });

  test('the session person: private session → its human; shared session and trigger → nobody', async () => {
    expect((await secretAudienceSubject({ projectId: PROJECT, sessionId: OWNER_PRIVATE })).personId).toBe(OWNER);
    expect((await secretAudienceSubject({ projectId: PROJECT, sessionId: OWNER_SHARED })).personId).toBeNull();
    expect((await secretAudienceSubject({ projectId: PROJECT, sessionId: OWNER_TRIGGER })).personId).toBeNull();
    // No session: the direct caller.
    expect((await secretAudienceSubject({ projectId: PROJECT, actorUserId: TEAMMATE })).personId).toBe(TEAMMATE);
  });

  test('a token minted before on_behalf_of existed resolves by the mint rule; a cleared one stays nobody', async () => {
    expect((await secretAudienceSubject({ projectId: PROJECT, sessionId: OWNER_LEGACY })).personId).toBe(OWNER);
    expect((await secretAudienceSubject({ projectId: PROJECT, sessionId: OWNER_CLEARED })).personId).toBeNull();
  });

  test('shared with an AGENT: every session of that agent gets it, a trigger included; another agent and a person do not', async () => {
    await writeSharedProjectSecret({ projectId: PROJECT, name: 'NIGHTLY_KEY', value: 'nightly-agent' });
    await onlyFor('NIGHTLY_KEY', [{ principal_type: 'agent', principal_id: AGENT_SA }]);
    expect((await envFor(null, AGENT_SA)).NIGHTLY_KEY).toBe('nightly-agent');
    expect((await envFor(OWNER, OTHER_AGENT_SA)).NIGHTLY_KEY).toBeUndefined();
    expect((await envFor(OWNER)).NIGHTLY_KEY).toBeUndefined();
    const trigger = await secretAudienceSubject({ projectId: PROJECT, sessionId: AGENT_TRIGGER });
    expect(trigger).toEqual({ personId: null, agentId: AGENT_SA });
    expect((await envFor(trigger.personId, trigger.agentId)).NIGHTLY_KEY).toBe('nightly-agent');
  });

  test('a value a person enters through a secret link is a fresh rotation, not "rotation required"', async () => {
    await writeSharedProjectSecret({ projectId: PROJECT, name: 'LINKED_KEY', value: 'linked-1', scope: 'connector' });
    const read = async () =>
      (await db
        .select({ rotatedAt: projectSecrets.rotatedAt, updatedAt: projectSecrets.updatedAt })
        .from(projectSecrets)
        .where(and(eq(projectSecrets.projectId, PROJECT), eq(projectSecrets.identifier, 'LINKED_KEY'))))[0]!;
    const first = await read();
    expect(first.rotatedAt?.getTime()).toBe(first.updatedAt.getTime());
    // Re-submitting the link replaces the value: that is a rotation too.
    await writeSharedProjectSecret({ projectId: PROJECT, name: 'LINKED_KEY', value: 'linked-2', scope: 'connector' });
    const second = await read();
    expect(second.rotatedAt?.getTime()).toBe(second.updatedAt.getTime());
  });

  test('a session whose token is not minted yet (first boot env) acts as its agent from agent_name', async () => {
    const reporterSa = crypto.randomUUID();
    const booting = crypto.randomUUID();
    const metaBooting = crypto.randomUUID();
    await db.insert(serviceAccounts).values({
      serviceAccountId: reporterSa, accountId: ACCOUNT, name: `agent-${reporterSa}`,
      secretHash: `sa-${reporterSa}`, publicPrefix: 'kortix_sa_audience', createdBy: OWNER,
      projectId: PROJECT, agentName: 'reporter',
    });
    await db.insert(projectSessions).values([
      { sessionId: booting, accountId: ACCOUNT, projectId: PROJECT, branchName: booting, createdBy: OWNER, visibility: 'project', origin: 'trigger', agentName: 'reporter' },
      { sessionId: metaBooting, accountId: ACCOUNT, projectId: PROJECT, branchName: metaBooting, createdBy: OWNER, visibility: 'project', origin: 'trigger', agentName: 'meta' },
    ]);
    expect(await secretAudienceSubject({ projectId: PROJECT, sessionId: booting })).toEqual({ personId: null, agentId: reporterSa });
    // An agent with no standing identity (the platform meta agent) is nobody.
    expect(await secretAudienceSubject({ projectId: PROJECT, sessionId: metaBooting })).toEqual({ personId: null, agentId: null });
  });

  test('one KEY, three values: the person value beats the agent value beats the team value', async () => {
    await writeSharedProjectSecret({ projectId: PROJECT, name: 'RANKED_KEY', value: 'ranked-team' });
    await writeSharedProjectSecret({ projectId: PROJECT, name: 'RANKED_KEY', identifier: 'RANKED_KEY-agent', value: 'ranked-agent' });
    await writeSharedProjectSecret({ projectId: PROJECT, name: 'RANKED_KEY', identifier: 'RANKED_KEY-owner', value: 'ranked-owner' });
    await onlyFor('RANKED_KEY-agent', [{ principal_type: 'agent', principal_id: AGENT_SA }]);
    await onlyFor('RANKED_KEY-owner', [{ principal_type: 'user', principal_id: OWNER }]);
    expect((await envFor(OWNER, AGENT_SA)).RANKED_KEY).toBe('ranked-owner');
    expect((await envFor(null, AGENT_SA)).RANKED_KEY).toBe('ranked-agent');
    expect((await envFor(TEAMMATE, OTHER_AGENT_SA)).RANKED_KEY).toBe('ranked-team');
  });

  test('share guard: a person-only PLAINTEXT value blocks sharing; agent-shared and server-side values do not', async () => {
    await writeSharedProjectSecret({ projectId: PROJECT, name: 'OWNER_ENV_KEY', value: 'owner-env' });
    await onlyFor('OWNER_ENV_KEY', [{ principal_type: 'user', principal_id: OWNER }]);
    const held = await sessionPersonOnlyPlaintextSecrets({ accountId: ACCOUNT, projectId: PROJECT, sessionId: OWNER_LEGACY });
    expect(held).toContain('OWNER_ENV_KEY');
    expect(held).toContain('RANKED_KEY-owner');
    expect(held).not.toContain('NIGHTLY_KEY'); // reached through the agent
    expect(held).not.toContain('PAYROLL_API_TOKEN'); // server-side, re-checked per call
    // A session with no person (a trigger) holds no person-only value.
    expect(await sessionPersonOnlyPlaintextSecrets({ accountId: ACCOUNT, projectId: PROJECT, sessionId: AGENT_TRIGGER })).toEqual([]);
  });

  test('connector credential narrowed to the owner: spent only for the owner, directly or in their private session', async () => {
    await onlyFor('PAYROLL_API_TOKEN', [{ principal_type: 'user', principal_id: OWNER }]);
    expect(await viaConnector({ actorUserId: OWNER })).toBe('payroll-owner');
    expect(await viaConnector({ actorUserId: OWNER, sessionId: OWNER_PRIVATE })).toBe('payroll-owner');
    expect(await viaConnector({ actorUserId: TEAMMATE })).toBeNull();
    expect(await viaConnector({ actorUserId: OWNER, sessionId: OWNER_SHARED })).toBeNull();
    expect(await viaConnector({ actorUserId: OWNER, sessionId: OWNER_TRIGGER })).toBeNull();
    expect(await viaConnector({})).toBeNull();
  });

  test('a grant must name a shared secret of this project', async () => {
    await expect(
      assignRole(SYSTEM_ACTOR, ACCOUNT, {
        principal: { type: 'user', id: OWNER },
        roleKey: 'agent-user',
        scope: { type: 'project', id: PROJECT },
        object: { type: 'secret', id: crypto.randomUUID() },
      }),
    ).rejects.toThrow('not a shared secret');
  });

  test('clearing the audience (secret delete) leaves no grant behind', async () => {
    const secretId = await secretIdOf('PAYROLL_API_TOKEN');
    await clearSecretAudience({ accountId: ACCOUNT, projectId: PROJECT, secretId });
    clearAuthorizeCaches();
    expect(await viaConnector({ actorUserId: TEAMMATE })).toBe('payroll-owner');
  });
});

/**
 * An audience outlives the people, groups and agents it names.
 *
 * A value with no grant is usable by everyone, so deleting its LAST audience
 * grant widened it instead of closing it. Promoting the owner to admin,
 * removing them, their leaving, deleting the group, or deleting a service
 * account bulk-deleted that principal's rows, audience grants included: an
 * "Only you" value became everyone's. The audience rows now stay, and a grant
 * to someone gone reaches nobody.
 */
describe('an audience outlives the principals it names', () => {
  const LEAVER = crypto.randomUUID();
  const CONTRACTORS = crypto.randomUUID();
  const CONTRACTOR = crypto.randomUUID();
  const PLAIN_SA = crypto.randomUUID();

  const audienceOf = async (objectType: string, objectId: string) =>
    db
      .select({ principalId: roleAssignments.principalId })
      .from(roleAssignments)
      .where(and(eq(roleAssignments.objectType, objectType), eq(roleAssignments.objectId, objectId)));

  beforeAll(async () => {
    for (const userId of [LEAVER, CONTRACTOR]) {
      await insertIntoView(db, accountMembers, { userId, accountId: ACCOUNT, accountRole: 'member' });
    }
    await db.insert(accountGroups).values({ groupId: CONTRACTORS, accountId: ACCOUNT, name: 'Contractors' });
    await db.insert(accountGroupMembers).values({ groupId: CONTRACTORS, userId: CONTRACTOR });
    await db.insert(serviceAccounts).values({
      serviceAccountId: PLAIN_SA, accountId: ACCOUNT, name: `sa-${PLAIN_SA}`,
      secretHash: `sa-${PLAIN_SA}`, publicPrefix: 'kortix_sa_audience', createdBy: OWNER,
    });
    await assignRole(SYSTEM_ACTOR, ACCOUNT, {
      principal: { type: 'user', id: LEAVER },
      roleKey: 'member',
      scope: { type: 'project', id: PROJECT },
    });
    await writeSharedProjectSecret({ projectId: PROJECT, name: 'LEAVER_KEY', value: 'leaver-only' });
    await writeSharedProjectSecret({ projectId: PROJECT, name: 'CONTRACTOR_KEY', value: 'contractors-only' });
    await writeSharedProjectSecret({ projectId: PROJECT, name: 'SA_KEY', value: 'agent-only' });
    await writeSharedProjectSecret({ projectId: PROJECT, name: 'OWNER_KEY', value: 'owner-only' });
    await onlyFor('LEAVER_KEY', [{ principal_type: 'user', principal_id: LEAVER }]);
    await onlyFor('CONTRACTOR_KEY', [{ principal_type: 'group', principal_id: CONTRACTORS }]);
    await onlyFor('SA_KEY', [{ principal_type: 'agent', principal_id: PLAIN_SA }]);
    await onlyFor('OWNER_KEY', [{ principal_type: 'user', principal_id: OWNER }]);
  });

  test('promoting, removing or losing the owner keeps an "Only you" value closed', async () => {
    const secretId = await secretIdOf('LEAVER_KEY');
    // A shared connector account narrowed to the same person: same store, same rule.
    const [grant] = await db
      .select()
      .from(roleAssignments)
      .where(and(eq(roleAssignments.objectType, 'secret'), eq(roleAssignments.objectId, secretId)));
    const connectionId = crypto.randomUUID();
    await db.insert(roleAssignments).values({
      ...grant!,
      assignmentId: crypto.randomUUID(),
      objectType: 'connection',
      objectId: connectionId,
    });
    expect((await envFor(LEAVER)).LEAVER_KEY).toBe('leaver-only');

    // What promotion to admin, member removal and leaving all run.
    await deleteProjectScopeAssignments(ACCOUNT, LEAVER);
    clearAuthorizeCaches();

    expect(await envFor(TEAMMATE)).not.toHaveProperty('LEAVER_KEY');
    expect(await audienceOf('secret', secretId)).toEqual([{ principalId: LEAVER }]);
    expect(await audienceOf('connection', connectionId)).toEqual([{ principalId: LEAVER }]);
    // The delete still does its job: the person's project role is gone.
    expect(
      await db
        .select({ id: roleAssignments.assignmentId })
        .from(roleAssignments)
        .where(
          and(
            eq(roleAssignments.principalId, LEAVER),
            eq(roleAssignments.scopeType, 'project'),
            isNull(roleAssignments.objectType),
          ),
        ),
    ).toEqual([]);
    // A promoted owner still reaches their own value.
    expect((await envFor(LEAVER)).LEAVER_KEY).toBe('leaver-only');
  });

  test('deleting the only group in an audience keeps the value closed', async () => {
    expect((await envFor(CONTRACTOR)).CONTRACTOR_KEY).toBe('contractors-only');
    expect(await deleteGroup(ACCOUNT, CONTRACTORS)).toBe(true);
    clearAuthorizeCaches();
    expect(await envFor(TEAMMATE)).not.toHaveProperty('CONTRACTOR_KEY');
    expect(await envFor(CONTRACTOR)).not.toHaveProperty('CONTRACTOR_KEY');
  });

  test('deleting a service account named in an audience keeps the value closed', async () => {
    expect((await envFor(null, PLAIN_SA)).SA_KEY).toBe('agent-only');
    expect(await deleteServiceAccount(ACCOUNT, PLAIN_SA)).toBe(true);
    clearAuthorizeCaches();
    expect(await envFor(TEAMMATE)).not.toHaveProperty('SA_KEY');
  });

  test('the members-manage resource-grant delete cannot remove a secret audience grant', async () => {
    const secretId = await secretIdOf('OWNER_KEY');
    const [grant] = await db
      .select({ id: roleAssignments.assignmentId })
      .from(roleAssignments)
      .where(and(eq(roleAssignments.objectType, 'secret'), eq(roleAssignments.objectId, secretId)));
    expect(await deleteResourceGrant(grant!.id, PROJECT, ACCOUNT)).toBe(false);
    clearAuthorizeCaches();
    expect(await envFor(TEAMMATE)).not.toHaveProperty('OWNER_KEY');
  });
});
