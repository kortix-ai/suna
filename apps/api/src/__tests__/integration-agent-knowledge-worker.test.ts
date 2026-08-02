import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  accounts,
  agentKnowledgeChunks,
  agentKnowledgeSources,
  agentKnowledgeSyncJobs,
  agentKnowledgeVersions,
  executorConnectionProfiles,
  executorConnectorActions,
  executorConnectors,
  executorExecutions,
  projects,
} from '@kortix/db';
import { and, eq } from 'drizzle-orm';
import { processNextAgentKnowledgeSync } from '../projects/lib/agent-knowledge-worker';
import { db } from '../shared/db';

const accountId = crypto.randomUUID();
const projectId = crypto.randomUUID();
const userId = crypto.randomUUID();
const connectorId = crypto.randomUUID();
const connectorProfileId = crypto.randomUUID();
let resourceServer: ReturnType<typeof Bun.serve>;
let requestedResourcePath = '';

beforeAll(async () => {
  resourceServer = Bun.serve({
    port: 0,
    fetch(request) {
      requestedResourcePath = new URL(request.url).pathname;
      return Response.json({
        content: '# Connector handbook\n\nEscalate to the incident commander.',
        content_type: 'text/markdown',
        file_name: 'handbook.md',
      });
    },
  });
  await db.insert(accounts).values({ accountId, name: 'agent-knowledge-worker-test' });
  await db.insert(projects).values({
    projectId,
    accountId,
    name: 'agent-knowledge-worker-test',
    repoUrl: 'https://example.test/repo.git',
  });
  await db.insert(executorConnectors).values({
    connectorId,
    accountId,
    projectId,
    slug: 'knowledge-drive',
    name: 'Knowledge drive',
    providerType: 'http',
    config: {
      baseUrl: `http://127.0.0.1:${resourceServer.port}`,
      auth: { type: 'none' },
    },
  });
  await db.insert(executorConnectionProfiles).values({
    profileId: connectorProfileId,
    accountId,
    projectId,
    connectorId,
    label: 'Support drive',
    isDefault: true,
    createdBy: userId,
  });
  await db.insert(executorConnectorActions).values({
    connectorId,
    path: 'files.get',
    name: 'Get file',
    inputSchema: {
      type: 'object',
      properties: { file_id: { type: 'string', 'x-in': 'path' } },
      required: ['file_id'],
    },
    risk: 'read',
    binding: { kind: 'http', method: 'GET', path: '/files/{file_id}' },
  });
});

afterAll(async () => {
  resourceServer.stop(true);
  await db.delete(projects).where(eq(projects.projectId, projectId));
  await db.delete(accounts).where(eq(accounts.accountId, accountId));
});

async function seedSource(input: {
  title: string;
  status?: 'pending' | 'ready';
  activeVersionId?: string;
  maxAttempts?: number;
}) {
  const sourceId = crypto.randomUUID();
  await db.insert(agentKnowledgeSources).values({
    sourceId,
    accountId,
    projectId,
    agentName: 'support',
    slug: `${input.title.toLowerCase().replace(/\s/g, '-')}-${sourceId.slice(0, 6)}`,
    sourceType: 'url',
    title: input.title,
    status: input.status ?? 'pending',
    url: `https://docs.example.test/${sourceId}`,
    activeVersionId: input.activeVersionId,
    automaticSync: true,
    syncIntervalHours: 24,
    createdBy: userId,
  });
  const [job] = await db
    .insert(agentKnowledgeSyncJobs)
    .values({
      accountId,
      projectId,
      agentName: 'support',
      sourceId,
      maxAttempts: input.maxAttempts ?? 5,
    })
    .returning();
  if (!job) throw new Error('Expected the source sync job to be created.');
  return { sourceId, jobId: job.jobId };
}

describe('agent knowledge synchronization worker', () => {
  test('reads a selected connected-app resource through its exact profile', async () => {
    const sourceId = crypto.randomUUID();
    await db.insert(agentKnowledgeSources).values({
      sourceId,
      accountId,
      projectId,
      agentName: 'support',
      slug: `connector-${sourceId.slice(0, 6)}`,
      sourceType: 'connector',
      title: 'Connector handbook',
      status: 'pending',
      connectorProfileId,
      resourceId: 'file 123',
      sourceConfig: {
        connectorSlug: 'knowledge-drive',
        readAction: 'files.get',
        resourceArgument: 'file_id',
      },
      createdBy: userId,
    });
    await db.insert(agentKnowledgeSyncJobs).values({
      accountId,
      projectId,
      agentName: 'support',
      sourceId,
    });

    const result = await processNextAgentKnowledgeSync({
      database: db,
      workerId: 'worker-connector',
      projectId,
      embedTexts: async () => ({
        embeddings: null,
        model: null,
        lexicalOnly: true,
        degradedReason: 'Embeddings unavailable in this test.',
      }),
    });

    expect(result?.sourceId).toBe(sourceId);
    expect(requestedResourcePath).toBe('/files/file%20123');
    const chunks = await db
      .select({ content: agentKnowledgeChunks.content })
      .from(agentKnowledgeChunks)
      .where(eq(agentKnowledgeChunks.sourceId, sourceId));
    expect(chunks).toEqual([
      { content: 'Connector handbook\n\nEscalate to the incident commander.' },
    ]);
    const [execution] = await db
      .select({ profileId: executorExecutions.profileId, risk: executorExecutions.risk })
      .from(executorExecutions)
      .where(eq(executorExecutions.projectId, projectId));
    expect(execution).toEqual({ profileId: connectorProfileId, risk: 'read' });
  });

  test('leases one job and promotes only a completely indexed version', async () => {
    const seeded = await seedSource({ title: 'Runbook' });
    let loads = 0;
    const deps = {
      database: db,
      workerId: 'worker-success',
      projectId,
      loadDocument: async () => {
        loads += 1;
        return {
          body: new TextEncoder().encode('# Escalation\n\nPage the incident lead.'),
          contentType: 'text/markdown',
          fileName: 'runbook.md',
        };
      },
      embedTexts: async (texts: string[]) => ({
        embeddings: texts.map(() => Array(1536).fill(0.25)),
        model: 'test-embedding',
        lexicalOnly: false,
        degradedReason: null,
      }),
    };

    const [first, second] = await Promise.all([
      processNextAgentKnowledgeSync(deps),
      processNextAgentKnowledgeSync({ ...deps, workerId: 'worker-race' }),
    ]);
    expect([first, second].filter(Boolean)).toHaveLength(1);
    expect(loads).toBe(1);

    const [source] = await db
      .select()
      .from(agentKnowledgeSources)
      .where(eq(agentKnowledgeSources.sourceId, seeded.sourceId));
    expect(source).toMatchObject({ status: 'ready', lastError: null });
    expect(source?.activeVersionId).toBeTruthy();
    if (!source?.activeVersionId) throw new Error('Expected the source to have an active version.');
    const [version] = await db
      .select()
      .from(agentKnowledgeVersions)
      .where(eq(agentKnowledgeVersions.versionId, source.activeVersionId));
    expect(version).toMatchObject({
      status: 'active',
      chunkCount: 1,
      embeddingModel: 'test-embedding',
      lexicalOnly: false,
    });
    if (!version) throw new Error('Expected the active knowledge version to exist.');
    const chunks = await db
      .select()
      .from(agentKnowledgeChunks)
      .where(eq(agentKnowledgeChunks.versionId, version.versionId));
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({
      locator: { heading: 'Escalation' },
      tokenCount: 9,
    });
    expect(chunks[0]?.embedding).toHaveLength(1536);
    const [job] = await db
      .select()
      .from(agentKnowledgeSyncJobs)
      .where(eq(agentKnowledgeSyncJobs.jobId, seeded.jobId));
    expect(job).toMatchObject({ status: 'succeeded', attempt: 1, leaseOwner: null });
  });

  test('preserves the active version, reports the exact error, retries, then dead-letters', async () => {
    const oldVersionId = crypto.randomUUID();
    const sourceId = crypto.randomUUID();
    await db.insert(agentKnowledgeSources).values({
      sourceId,
      accountId,
      projectId,
      agentName: 'support',
      slug: `failing-${sourceId.slice(0, 6)}`,
      sourceType: 'connector',
      title: 'Failing source',
      status: 'ready',
      connectorProfileId: crypto.randomUUID(),
      resourceId: 'resource-403',
      automaticSync: true,
      syncIntervalHours: 24,
      createdBy: userId,
    });
    await db.insert(agentKnowledgeVersions).values({
      versionId: oldVersionId,
      accountId,
      projectId,
      agentName: 'support',
      sourceId,
      status: 'active',
      chunkCount: 1,
      promotedAt: new Date(),
    });
    await db
      .update(agentKnowledgeSources)
      .set({ activeVersionId: oldVersionId })
      .where(eq(agentKnowledgeSources.sourceId, sourceId));
    const [job] = await db
      .insert(agentKnowledgeSyncJobs)
      .values({ accountId, projectId, agentName: 'support', sourceId, maxAttempts: 2 })
      .returning();
    if (!job) throw new Error('Expected the retry sync job to be created.');
    const exactError = 'Connected app returned HTTP 403 for resource resource-403.';
    const deps = {
      database: db,
      workerId: 'worker-failure',
      projectId,
      loadDocument: async () => {
        throw new Error(exactError);
      },
    };

    await processNextAgentKnowledgeSync(deps);
    let [source] = await db
      .select()
      .from(agentKnowledgeSources)
      .where(eq(agentKnowledgeSources.sourceId, sourceId));
    expect(source).toMatchObject({
      activeVersionId: oldVersionId,
      status: 'error',
      lastError: exactError,
    });
    let [queued] = await db
      .select()
      .from(agentKnowledgeSyncJobs)
      .where(eq(agentKnowledgeSyncJobs.jobId, job.jobId));
    expect(queued).toMatchObject({ status: 'pending', attempt: 1, lastError: exactError });
    const [oldVersion] = await db
      .select()
      .from(agentKnowledgeVersions)
      .where(eq(agentKnowledgeVersions.versionId, oldVersionId));
    expect(oldVersion?.status).toBe('active');

    await db
      .update(agentKnowledgeSyncJobs)
      .set({ availableAt: new Date(0) })
      .where(eq(agentKnowledgeSyncJobs.jobId, job.jobId));
    await processNextAgentKnowledgeSync(deps);

    [source] = await db
      .select()
      .from(agentKnowledgeSources)
      .where(eq(agentKnowledgeSources.sourceId, sourceId));
    [queued] = await db
      .select()
      .from(agentKnowledgeSyncJobs)
      .where(eq(agentKnowledgeSyncJobs.jobId, job.jobId));
    expect(source?.activeVersionId).toBe(oldVersionId);
    expect(source?.lastError).toBe(exactError);
    expect(queued).toMatchObject({ status: 'dead_lettered', attempt: 2, lastError: exactError });
    const failedVersions = await db
      .select()
      .from(agentKnowledgeVersions)
      .where(
        and(
          eq(agentKnowledgeVersions.sourceId, sourceId),
          eq(agentKnowledgeVersions.status, 'failed'),
        ),
      );
    expect(failedVersions).toHaveLength(2);
    expect(failedVersions.every((version) => version.error === exactError)).toBe(true);
  });
});
