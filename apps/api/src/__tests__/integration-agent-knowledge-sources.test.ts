import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  accounts,
  agentKnowledgeAssignments,
  agentKnowledgeSources,
  agentKnowledgeSyncJobs,
  executorConnectionProfiles,
  executorConnectorActions,
  executorConnectors,
  projects,
} from '@kortix/db';
import { and, eq } from 'drizzle-orm';
import {
  createAgentKnowledgeSourceRecord,
  enqueueAgentKnowledgeSync,
  getAgentKnowledgeSourceRecord,
  listAgentKnowledgeSourceRecords,
  revokeAgentKnowledgeSourceRecord,
} from '../projects/lib/agent-knowledge-sources';
import { db } from '../shared/db';

const accountId = crypto.randomUUID();
const projectId = crypto.randomUUID();
const userId = crypto.randomUUID();
const connectorId = crypto.randomUUID();
const connectorProfileId = crypto.randomUUID();

beforeAll(async () => {
  await db.insert(accounts).values({ accountId, name: 'agent-knowledge-source-test' });
  await db.insert(projects).values({
    projectId,
    accountId,
    name: 'agent-knowledge-source-test',
    repoUrl: 'https://example.test/repo.git',
  });
  await db.insert(executorConnectors).values({
    connectorId,
    accountId,
    projectId,
    slug: 'drive',
    name: 'Drive',
    providerType: 'http',
    config: { baseUrl: 'https://drive.example.test', auth: { type: 'none' } },
  });
  await db.insert(executorConnectionProfiles).values({
    profileId: connectorProfileId,
    accountId,
    projectId,
    connectorId,
    label: 'Team drive',
    isDefault: true,
    createdBy: userId,
  });
  await db.insert(executorConnectorActions).values([
    {
      connectorId,
      path: 'files.get',
      name: 'Get file',
      inputSchema: {
        type: 'object',
        properties: { file_id: { type: 'string' } },
        required: ['file_id'],
      },
      risk: 'read',
      binding: { kind: 'http', method: 'GET', path: '/files/{file_id}' },
    },
    {
      connectorId,
      path: 'files.delete',
      name: 'Delete file',
      inputSchema: {
        type: 'object',
        properties: { file_id: { type: 'string' } },
        required: ['file_id'],
      },
      risk: 'destructive',
      binding: { kind: 'http', method: 'DELETE', path: '/files/{file_id}' },
    },
  ]);
});

afterAll(async () => {
  await db.delete(agentKnowledgeSyncJobs).where(eq(agentKnowledgeSyncJobs.projectId, projectId));
  await db
    .delete(agentKnowledgeAssignments)
    .where(eq(agentKnowledgeAssignments.projectId, projectId));
  await db.delete(agentKnowledgeSources).where(eq(agentKnowledgeSources.projectId, projectId));
  await db.delete(executorConnectors).where(eq(executorConnectors.projectId, projectId));
  await db.delete(projects).where(eq(projects.projectId, projectId));
  await db.delete(accounts).where(eq(accounts.accountId, accountId));
});

describe('private knowledge source isolation', () => {
  test('stores only a validated read action for a selected connector resource', async () => {
    await expect(
      createAgentKnowledgeSourceRecord({
        accountId,
        projectId,
        agentName: 'connector-agent',
        userId,
        input: {
          type: 'connector',
          title: 'Incident playbook',
          connectorProfileId,
          resourceId: 'file-123',
          connectorAction: 'files.delete',
          resourceArgument: 'file_id',
        },
      }),
    ).rejects.toMatchObject({ code: 'connector_action_not_read_only' });

    const source = await createAgentKnowledgeSourceRecord({
      accountId,
      projectId,
      agentName: 'connector-agent',
      userId,
      input: {
        type: 'connector',
        title: 'Incident playbook',
        connectorProfileId,
        resourceId: 'file-123',
        connectorAction: 'files.get',
        resourceArgument: 'file_id',
      },
    });

    expect(source.connectorProfileId).toBe(connectorProfileId);
    expect(source.resourceId).toBe('file-123');
    expect(source.sourceConfig).toEqual({
      connectorSlug: 'drive',
      readAction: 'files.get',
      resourceArgument: 'file_id',
    });
  });

  test('rejects forged agent names and source IDs for list, read, sync, and revoke', async () => {
    const sourceA = await createAgentKnowledgeSourceRecord({
      accountId,
      projectId,
      agentName: 'agent-a',
      userId,
      input: {
        type: 'url',
        title: 'Agent A handbook',
        url: 'https://docs.example.com/agent-a',
        automaticSync: true,
      },
    });
    const sourceB = await createAgentKnowledgeSourceRecord({
      accountId,
      projectId,
      agentName: 'agent-b',
      userId,
      input: {
        type: 'url',
        title: 'Agent B handbook',
        url: 'https://docs.example.com/agent-b',
        automaticSync: true,
      },
    });

    expect(
      (await listAgentKnowledgeSourceRecords(projectId, 'agent-a')).map(
        (source) => source.sourceId,
      ),
    ).toEqual([sourceA.sourceId]);
    expect(await getAgentKnowledgeSourceRecord(projectId, 'agent-a', sourceB.sourceId)).toBeNull();
    expect(await enqueueAgentKnowledgeSync(projectId, 'agent-a', sourceB.sourceId)).toBe(false);
    expect(
      await revokeAgentKnowledgeSourceRecord(projectId, 'agent-a', sourceB.sourceId, userId),
    ).toBe(false);

    const untouched = await getAgentKnowledgeSourceRecord(projectId, 'agent-b', sourceB.sourceId);
    expect(untouched?.status).not.toBe('revoked');
  });

  test('revoke is immediate and deactivates the materialized assignment', async () => {
    const source = await createAgentKnowledgeSourceRecord({
      accountId,
      projectId,
      agentName: 'agent-a',
      userId,
      input: {
        type: 'url',
        title: 'Revocable source',
        url: 'https://docs.example.com/revoke',
        automaticSync: false,
      },
    });
    await db.insert(agentKnowledgeAssignments).values({
      accountId,
      projectId,
      agentName: 'agent-a',
      sourceId: source.sourceId,
      manifestRevision: 'a'.repeat(40),
      active: true,
    });

    expect(
      await revokeAgentKnowledgeSourceRecord(projectId, 'agent-a', source.sourceId, userId),
    ).toBe(true);
    const revoked = await getAgentKnowledgeSourceRecord(
      projectId,
      'agent-a',
      source.sourceId,
      true,
    );
    expect(revoked?.status).toBe('revoked');
    const [assignment] = await db
      .select({ active: agentKnowledgeAssignments.active })
      .from(agentKnowledgeAssignments)
      .where(
        and(
          eq(agentKnowledgeAssignments.projectId, projectId),
          eq(agentKnowledgeAssignments.agentName, 'agent-a'),
          eq(agentKnowledgeAssignments.sourceId, source.sourceId),
        ),
      );
    expect(assignment?.active).toBe(false);
  });
});
