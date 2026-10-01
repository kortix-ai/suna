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
  serviceAccounts,
} from '@kortix/db';
import { and, eq } from 'drizzle-orm';
import { assignRole, SYSTEM_ACTOR } from '../iam/assignments';
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
  secretAudiencePerson,
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

/** The env a sandbox would receive for this person, KEY -> value. */
async function envFor(personId: string | null): Promise<Record<string, string>> {
  const rows = await listResolvedProjectSecrets(PROJECT, null, personId);
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
  for (const sessionId of [OWNER_LEGACY, OWNER_CLEARED]) {
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
    const ownerRows = await listResolvedProjectSecrets(PROJECT, null, OWNER);
    expect(resolveGrantedSecretSelection(ownerRows, ['MAPS_KEY', 'MAPS_KEY-owner']).env.MAPS_KEY).toBe('maps-owner');
  });

  test('the session person: private session → its human; shared session and trigger → nobody', async () => {
    expect(await secretAudiencePerson({ projectId: PROJECT, sessionId: OWNER_PRIVATE })).toBe(OWNER);
    expect(await secretAudiencePerson({ projectId: PROJECT, sessionId: OWNER_SHARED })).toBeNull();
    expect(await secretAudiencePerson({ projectId: PROJECT, sessionId: OWNER_TRIGGER })).toBeNull();
    // No session: the direct caller.
    expect(await secretAudiencePerson({ projectId: PROJECT, actorUserId: TEAMMATE })).toBe(TEAMMATE);
  });

  test('a token minted before on_behalf_of existed resolves by the mint rule; a cleared one stays nobody', async () => {
    expect(await secretAudiencePerson({ projectId: PROJECT, sessionId: OWNER_LEGACY })).toBe(OWNER);
    expect(await secretAudiencePerson({ projectId: PROJECT, sessionId: OWNER_CLEARED })).toBeNull();
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
