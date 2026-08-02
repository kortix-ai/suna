import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  accounts,
  agentKnowledgeAssignments,
  agentKnowledgeChunks,
  agentKnowledgeSources,
  agentKnowledgeVersions,
  projectSessions,
  projects,
} from '@kortix/db';
import { eq } from 'drizzle-orm';
import { db } from '../../shared/db';
import {
  SessionKnowledgeAccessError,
  readAgentKnowledgeForSession,
  searchAgentKnowledgeForSession,
} from './session-knowledge';

const accountId = crypto.randomUUID();
const projectId = crypto.randomUUID();
const userId = crypto.randomUUID();
const sessionA = crypto.randomUUID();
const sessionB = crypto.randomUUID();
const sourceA = crypto.randomUUID();
const sourceB = crypto.randomUUID();
const versionA = crypto.randomUUID();
const versionB = crypto.randomUUID();
const citationA = crypto.randomUUID();
const citationB = crypto.randomUUID();

beforeAll(async () => {
  await db.insert(accounts).values({ accountId, name: 'session-knowledge-test' });
  await db.insert(projects).values({
    projectId,
    accountId,
    name: 'session-knowledge-test',
    repoUrl: 'https://example.test/repo.git',
  });
  await db.insert(projectSessions).values([
    {
      sessionId: sessionA,
      accountId,
      projectId,
      branchName: `session-${sessionA}`,
      agentName: 'agent-a',
      createdBy: userId,
    },
    {
      sessionId: sessionB,
      accountId,
      projectId,
      branchName: `session-${sessionB}`,
      agentName: 'agent-b',
      createdBy: userId,
    },
  ]);
  await db.insert(agentKnowledgeSources).values([
    {
      sourceId: sourceA,
      accountId,
      projectId,
      agentName: 'agent-a',
      slug: 'agent-a-handbook',
      sourceType: 'url',
      title: 'Agent A handbook',
      status: 'ready',
      url: 'https://docs.example.test/a',
      automaticSync: true,
      createdBy: userId,
    },
    {
      sourceId: sourceB,
      accountId,
      projectId,
      agentName: 'agent-b',
      slug: 'agent-b-handbook',
      sourceType: 'url',
      title: 'Agent B handbook',
      status: 'ready',
      url: 'https://docs.example.test/b',
      automaticSync: true,
      createdBy: userId,
    },
  ]);
  await db.insert(agentKnowledgeVersions).values([
    {
      versionId: versionA,
      accountId,
      projectId,
      agentName: 'agent-a',
      sourceId: sourceA,
      status: 'active',
      chunkCount: 1,
      lexicalOnly: true,
      promotedAt: new Date(),
    },
    {
      versionId: versionB,
      accountId,
      projectId,
      agentName: 'agent-b',
      sourceId: sourceB,
      status: 'active',
      chunkCount: 1,
      lexicalOnly: true,
      promotedAt: new Date(),
    },
  ]);
  await db
    .update(agentKnowledgeSources)
    .set({ activeVersionId: versionA })
    .where(eq(agentKnowledgeSources.sourceId, sourceA));
  await db
    .update(agentKnowledgeSources)
    .set({ activeVersionId: versionB })
    .where(eq(agentKnowledgeSources.sourceId, sourceB));
  await db.insert(agentKnowledgeChunks).values([
    {
      citationId: citationA,
      accountId,
      projectId,
      agentName: 'agent-a',
      sourceId: sourceA,
      versionId: versionA,
      chunkIndex: 0,
      content: 'ALPHA-ONLY support escalation policy.',
      tokenCount: 8,
      locator: { heading: 'Escalation', page: 2 },
    },
    {
      citationId: citationB,
      accountId,
      projectId,
      agentName: 'agent-b',
      sourceId: sourceB,
      versionId: versionB,
      chunkIndex: 0,
      content: 'BRAVO-SECRET acquisition plan.',
      tokenCount: 8,
      locator: { heading: 'Acquisition' },
    },
  ]);
  await db.insert(agentKnowledgeAssignments).values([
    {
      accountId,
      projectId,
      agentName: 'agent-a',
      sourceId: sourceA,
      manifestRevision: 'a'.repeat(40),
      active: true,
    },
    {
      accountId,
      projectId,
      agentName: 'agent-b',
      sourceId: sourceB,
      manifestRevision: 'b'.repeat(40),
      active: true,
    },
  ]);
});

afterAll(async () => {
  await db.delete(projects).where(eq(projects.projectId, projectId));
  await db.delete(accounts).where(eq(accounts.accountId, accountId));
});

const lexicalOnly = async () => ({
  embeddings: null,
  model: null,
  lexicalOnly: true,
  degradedReason: 'Embedding credentials are unavailable; lexical search remains active.',
});

describe('session-derived agent knowledge isolation', () => {
  test('searches and reads only the authenticated session agent assignment', async () => {
    const alpha = await searchAgentKnowledgeForSession({
      projectId,
      requestedSessionId: sessionA,
      authenticatedSessionId: sessionA,
      query: 'ALPHA support',
      embedQuery: lexicalOnly,
    });
    expect(alpha.mode).toBe('lexical');
    expect(alpha.degraded_reason).toContain('lexical search');
    expect(alpha.results).toHaveLength(1);
    expect(alpha.results[0]).toMatchObject({
      content: 'ALPHA-ONLY support escalation policy.',
      citation: {
        citation_id: citationA,
        source_id: sourceA,
        source_slug: 'agent-a-handbook',
        locator: { heading: 'Escalation', page: 2 },
      },
    });

    const read = await readAgentKnowledgeForSession({
      projectId,
      requestedSessionId: sessionA,
      authenticatedSessionId: sessionA,
      citationId: citationA,
    });
    expect(read?.content).toBe('ALPHA-ONLY support escalation policy.');
  });

  test('rejects forged session names, source IDs, slugs, and citations', async () => {
    await expect(
      searchAgentKnowledgeForSession({
        projectId,
        requestedSessionId: sessionB,
        authenticatedSessionId: sessionA,
        query: 'BRAVO',
        embedQuery: lexicalOnly,
      }),
    ).rejects.toBeInstanceOf(SessionKnowledgeAccessError);

    const inferred = await searchAgentKnowledgeForSession({
      projectId,
      requestedSessionId: sessionA,
      authenticatedSessionId: sessionA,
      query: `BRAVO ${sourceB} agent-b-handbook`,
      embedQuery: lexicalOnly,
    });
    expect(inferred.results).toEqual([]);
    expect(
      await readAgentKnowledgeForSession({
        projectId,
        requestedSessionId: sessionA,
        authenticatedSessionId: sessionA,
        citationId: citationB,
      }),
    ).toBeNull();
  });

  test('removes access immediately after revoke', async () => {
    await db
      .update(agentKnowledgeSources)
      .set({ status: 'revoked', revokedAt: new Date() })
      .where(eq(agentKnowledgeSources.sourceId, sourceA));

    const result = await searchAgentKnowledgeForSession({
      projectId,
      requestedSessionId: sessionA,
      authenticatedSessionId: sessionA,
      query: 'ALPHA',
      embedQuery: lexicalOnly,
    });
    expect(result.results).toEqual([]);
    expect(
      await readAgentKnowledgeForSession({
        projectId,
        requestedSessionId: sessionA,
        authenticatedSessionId: sessionA,
        citationId: citationA,
      }),
    ).toBeNull();
  });
});
