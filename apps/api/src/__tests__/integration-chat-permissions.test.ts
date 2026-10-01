/**
 * Integration test (real local PostgreSQL): who may Stop a Teams run and who
 * may start a fresh session with `/new`. Real: rows, chat identity links,
 * session-keyed participants, IAM roles. Faked: the live-card turn store and
 * the runtime abort, which talk to Bot Framework and a sandbox.
 */
import { afterAll, beforeAll, beforeEach, expect, mock, test } from 'bun:test';
import { accountMembers, chatThreadParticipants, chatThreads, chatUserIdentities, projectMembers, projectSessions } from '@kortix/db';
import { eq } from 'drizzle-orm';
import { db } from '../shared/db';
import { insertIntoView } from './helpers/compat-views';
import { removeSeeded, seedProject, type SeededProject } from './helpers/integration-fixtures';

const TENANT = `tenant-permissions-${crypto.randomUUID()}`;
const CONVO = `19:permissions-${crypto.randomUUID()}@thread.v2`;
const OWNER = crypto.randomUUID();
const MEMBER = crypto.randomUUID();
const JOINER = crypto.randomUUID();
const OUTSIDER = crypto.randomUUID();
let project: SeededProject;
let earlierSession: string;
let currentSession: string;

let liveTurn: Record<string, unknown> | null = null;
const stopped: string[] = [];
mock.module('../channels/teams/turn', () => ({
  loadTurn: async () => liveTurn,
  claimFinalize: async () => true,
  finalizeTurn: async () => {},
  deleteTurn: async (id: string) => {
    stopped.push(id);
  },
  closeAbandonedTurn: async () => {},
}));
mock.module('../projects/session-lifecycle/abort-runtime-turn', () => ({
  abortRuntimeTurn: async () => true,
}));

const { stopTeamsTurn } = await import('../channels/teams/stop');
const { startFreshTeamsConversation } = await import('../channels/teams/fresh-start');

async function session(createdBy: string, policy: string): Promise<string> {
  const sessionId = crypto.randomUUID();
  await db.insert(projectSessions).values({
    sessionId,
    accountId: project.account_id,
    projectId: project.project_id,
    branchName: `session/${sessionId}`,
    createdBy,
    metadata: { source: 'teams', teams: { tenant_id: TENANT, conversation_id: CONVO, conversation_policy: policy } },
  });
  return sessionId;
}

async function approve(sessionId: string, aad: string, userId: string) {
  await db
    .insert(chatThreadParticipants)
    .values({
      platform: 'teams',
      workspaceId: TENANT,
      threadId: CONVO,
      sessionId,
      platformUserId: aad,
      userId,
      status: 'approved',
    })
    .onConflictDoUpdate({
      target: [
        chatThreadParticipants.platform,
        chatThreadParticipants.workspaceId,
        chatThreadParticipants.threadId,
        chatThreadParticipants.platformUserId,
      ],
      set: { sessionId, userId, status: 'approved' },
    });
}

async function pointConversationAt(sessionId: string) {
  await db.delete(chatThreads).where(eq(chatThreads.threadId, CONVO));
  await db.insert(chatThreads).values({
    projectId: project.project_id,
    platform: 'teams',
    workspaceId: TENANT,
    threadId: CONVO,
    sessionId,
  });
}

beforeAll(async () => {
  project = await seedProject('chat-permissions', { metadata: { experimental: { teams: true } } });
  await insertIntoView(db, accountMembers, [
    { userId: OWNER, accountId: project.account_id, accountRole: 'owner' },
    { userId: MEMBER, accountId: project.account_id, accountRole: 'member' },
    { userId: JOINER, accountId: project.account_id, accountRole: 'member' },
    // In the account, with no role on the project.
    { userId: OUTSIDER, accountId: project.account_id, accountRole: 'member' },
  ]);
  await insertIntoView(db, projectMembers, [
    { accountId: project.account_id, projectId: project.project_id, userId: MEMBER, projectRole: 'member' },
    { accountId: project.account_id, projectId: project.project_id, userId: JOINER, projectRole: 'member' },
  ]);
  await db.insert(chatUserIdentities).values([
    { platform: 'teams', workspaceId: TENANT, platformUserId: 'aad-member', userId: MEMBER },
    { platform: 'teams', workspaceId: TENANT, platformUserId: 'aad-joiner', userId: JOINER },
    { platform: 'teams', workspaceId: TENANT, platformUserId: 'aad-outsider', userId: OUTSIDER },
  ]);
  earlierSession = await session(MEMBER, 'owner_approval');
  currentSession = await session(MEMBER, 'owner_approval');
});

beforeEach(async () => {
  stopped.length = 0;
  await db.delete(chatThreadParticipants).where(eq(chatThreadParticipants.threadId, CONVO));
  await pointConversationAt(currentSession);
  liveTurn = {
    tenantId: TENANT,
    conversationId: CONVO,
    projectId: project.project_id,
    sessionId: currentSession,
    finalized: false,
    originatingActivity: { from: { id: '29:member', aadObjectId: 'aad-member', name: 'Member' } },
  };
});

afterAll(async () => {
  await db.delete(chatThreadParticipants).where(eq(chatThreadParticipants.threadId, CONVO));
  await db.delete(chatThreads).where(eq(chatThreads.threadId, CONVO));
  await db.delete(chatUserIdentities).where(eq(chatUserIdentities.workspaceId, TENANT));
  await db.delete(projectSessions).where(eq(projectSessions.projectId, project.project_id));
  await removeSeeded([project]);
});

test('Stop: the sender, a project member, stops their run', async () => {
  expect(await stopTeamsTurn({ sessionId: currentSession, teamsUserId: 'aad-member' })).toEqual({
    stopped: true,
    stoppedRuntime: true,
  });
  expect(stopped).toEqual([currentSession]);
});

test('Stop: a participant approved on THIS session may; one approved on an earlier session may not', async () => {
  await approve(earlierSession, 'aad-joiner', JOINER);
  expect((await stopTeamsTurn({ sessionId: currentSession, teamsUserId: 'aad-joiner' })).stopped).toBe(false);

  await approve(currentSession, 'aad-joiner', JOINER);
  expect((await stopTeamsTurn({ sessionId: currentSession, teamsUserId: 'aad-joiner' })).stopped).toBe(true);
});

test('Stop: an approved participant without project access may not', async () => {
  await approve(currentSession, 'aad-outsider', OUTSIDER);
  expect((await stopTeamsTurn({ sessionId: currentSession, teamsUserId: 'aad-outsider' })).stopped).toBe(false);
  expect(stopped).toEqual([]);
});

test('/new under project_open: a linked project member may; unlinked or no project access may not', async () => {
  const open = await session(MEMBER, 'project_open');
  await pointConversationAt(open);
  const fresh = (aad: string) =>
    startFreshTeamsConversation({ tenantId: TENANT, conversationId: CONVO, scope: 'groupChat', teamsUserId: aad });

  expect((await fresh('aad-nobody')).reset).toBe(false);
  expect((await fresh('aad-outsider')).reset).toBe(false);
  expect(await fresh('aad-joiner')).toEqual({ reset: true, previousSessionId: open });
  const [thread] = await db.select().from(chatThreads).where(eq(chatThreads.threadId, CONVO));
  expect(thread).toBeUndefined();
});

test('/new under owner_approval: only someone approved on this session', async () => {
  const fresh = (aad: string) =>
    startFreshTeamsConversation({ tenantId: TENANT, conversationId: CONVO, scope: 'groupChat', teamsUserId: aad });

  await approve(earlierSession, 'aad-joiner', JOINER);
  expect((await fresh('aad-joiner')).reset).toBe(false);

  await approve(currentSession, 'aad-joiner', JOINER);
  expect(await fresh('aad-joiner')).toEqual({ reset: true, previousSessionId: currentSession });
});
