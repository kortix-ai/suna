import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  accountMembers,
  accounts,
  agentKnowledgeAssignments,
  agentKnowledgeChunks,
  agentKnowledgeSources,
  agentKnowledgeVersions,
  projectMembers,
  projectSessions,
  projects,
} from '@kortix/db';
import { and, eq, sql } from 'drizzle-orm';
import { app } from '../index';
import { createAccountToken } from '../repositories/account-tokens';
import { db } from '../shared/db';

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
const tokenIds: string[] = [];
let tokenA = '';
let switchedToken = '';
let humanToken = '';

beforeAll(async () => {
  await db.execute(
    sql`alter table kortix.account_tokens add column if not exists agent_grant jsonb`,
  );
  await db.execute(sql`alter table kortix.account_tokens add column if not exists session_id text`);
  await db.execute(
    sql`alter table kortix.account_tokens add column if not exists service_account_id uuid`,
  );
  await db.insert(accounts).values({ accountId, name: 'session-knowledge-route-test' });
  await db.insert(accountMembers).values({ accountId, userId, accountRole: 'member' });
  await db.insert(projects).values({
    projectId,
    accountId,
    name: 'session-knowledge-route-test',
    repoUrl: 'https://example.test/repo.git',
  });
  await db.insert(projectMembers).values({ accountId, projectId, userId, projectRole: 'editor' });
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
      slug: 'agent-a-source',
      sourceType: 'url',
      title: 'Agent A source',
      status: 'ready',
      url: 'https://docs.example.test/a',
      automaticSync: false,
      createdBy: userId,
    },
    {
      sourceId: sourceB,
      accountId,
      projectId,
      agentName: 'agent-b',
      slug: 'agent-b-source',
      sourceType: 'url',
      title: 'Agent B source',
      status: 'ready',
      url: 'https://docs.example.test/b',
      automaticSync: false,
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
      content: 'ALPHA route evidence.',
      tokenCount: 4,
    },
    {
      citationId: citationB,
      accountId,
      projectId,
      agentName: 'agent-b',
      sourceId: sourceB,
      versionId: versionB,
      chunkIndex: 0,
      content: 'BRAVO private evidence.',
      tokenCount: 4,
    },
  ]);
  await db.insert(agentKnowledgeAssignments).values([
    {
      accountId,
      projectId,
      agentName: 'agent-a',
      sourceId: sourceA,
      manifestRevision: 'a'.repeat(40),
    },
    {
      accountId,
      projectId,
      agentName: 'agent-b',
      sourceId: sourceB,
      manifestRevision: 'b'.repeat(40),
    },
  ]);
  const sessionToken = await createAccountToken({
    accountId,
    userId,
    projectId,
    sessionId: sessionA,
    name: 'session-a-token',
    agentGrant: {
      agent: 'agent-a',
      kortixCli: ['project.read'],
      connectors: [],
      knowledge: ['agent-a-source'],
    },
  });
  tokenA = sessionToken.secretKey;
  tokenIds.push(sessionToken.tokenId);
  const switchedSessionToken = await createAccountToken({
    accountId,
    userId,
    projectId,
    sessionId: sessionA,
    name: 'session-a-switched-to-agent-b',
    agentGrant: {
      agent: 'agent-b',
      kortixCli: ['project.read'],
      connectors: [],
      knowledge: ['agent-b-source'],
    },
  });
  switchedToken = switchedSessionToken.secretKey;
  tokenIds.push(switchedSessionToken.tokenId);
  const human = await createAccountToken({ accountId, userId, projectId, name: 'human-token' });
  humanToken = human.secretKey;
  tokenIds.push(human.tokenId);
});

afterAll(async () => {
  for (const tokenId of tokenIds) {
    await db.execute(sql`delete from kortix.account_tokens where token_id = ${tokenId}`);
  }
  await db.delete(projects).where(eq(projects.projectId, projectId));
  await db
    .delete(accountMembers)
    .where(and(eq(accountMembers.accountId, accountId), eq(accountMembers.userId, userId)));
  await db.delete(accounts).where(eq(accounts.accountId, accountId));
});

function request(token: string, method: string, path: string, body?: unknown) {
  return app.request(path, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

describe('session knowledge HTTP routes', () => {
  test('derives the agent from the authenticated session token', async () => {
    const response = await request(
      tokenA,
      'POST',
      `/v1/projects/${projectId}/sessions/${sessionA}/knowledge/search`,
      { query: 'ALPHA' },
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.results).toHaveLength(1);
    expect(body.results[0].citation.citation_id).toBe(citationA);

    const read = await request(
      tokenA,
      'GET',
      `/v1/projects/${projectId}/sessions/${sessionA}/knowledge/${citationA}`,
    );
    expect(read.status).toBe(200);
    expect((await read.json()).content).toBe('ALPHA route evidence.');
  });

  test('uses a re-scoped token identity instead of the session creation-time agent', async () => {
    const response = await request(
      switchedToken,
      'POST',
      `/v1/projects/${projectId}/sessions/${sessionA}/knowledge/search`,
      { query: 'BRAVO' },
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.results).toHaveLength(1);
    expect(body.results[0].citation.citation_id).toBe(citationB);

    const creationTimeCitation = await request(
      switchedToken,
      'GET',
      `/v1/projects/${projectId}/sessions/${sessionA}/knowledge/${citationA}`,
    );
    expect(creationTimeCitation.status).toBe(404);
  });

  test('rejects forged sessions, citations, and agent fields', async () => {
    const forgedSession = await request(
      tokenA,
      'POST',
      `/v1/projects/${projectId}/sessions/${sessionB}/knowledge/search`,
      { query: 'BRAVO' },
    );
    expect(forgedSession.status).toBe(403);

    const forgedCitation = await request(
      tokenA,
      'GET',
      `/v1/projects/${projectId}/sessions/${sessionA}/knowledge/${citationB}`,
    );
    expect(forgedCitation.status).toBe(404);

    const forgedBody = await request(
      tokenA,
      'POST',
      `/v1/projects/${projectId}/sessions/${sessionA}/knowledge/search`,
      { query: 'BRAVO', agentName: 'agent-b' },
    );
    expect(forgedBody.status).toBe(400);

    const unboundHuman = await request(
      humanToken,
      'POST',
      `/v1/projects/${projectId}/sessions/${sessionA}/knowledge/search`,
      { query: 'ALPHA' },
    );
    expect(unboundHuman.status).toBe(403);
  });
});
