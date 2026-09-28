/**
 * Integration test (real local PostgreSQL): the Teams approval card for a
 * policy-gated connector call — post, decide from the card, update on a web
 * decision. Real: rows, identities, IAM, the decision core. Faked: the Bot
 * Framework HTTP surface, the conversation→project binding, the resume spawn.
 */
import { afterAll, beforeAll, beforeEach, expect, mock, test } from 'bun:test';
import {
  accountMembers,
  chatThreads,
  chatUserIdentities,
  connectorCalls,
  projectMembers,
  projectSessions,
} from '@kortix/db';
import { eq } from 'drizzle-orm';
import * as realTeamsApi from '../channels/teams-api';
import * as realInstallStore from '../channels/install-store';
import * as realBinding from '../channels/teams/binding';
import * as realTeamsSession from '../channels/teams/session';
import { db } from '../shared/db';
import { insertIntoView } from './helpers/compat-views';
import { removeSeeded, seedProject, type SeededProject } from './helpers/integration-fixtures';

const TENANT = 'tenant-approval';
const CONVO = '19:approval@thread.tacv2';
const sent: unknown[] = [];
const cardUpdates: Array<{ activityId: string; card: unknown }> = [];
const resumed: string[] = [];
let project: SeededProject;

mock.module('../channels/teams-api', () => ({
  ...realTeamsApi,
  sendCard: async (_ref: unknown, card: unknown) => {
    sent.push(card);
    return 'activity-1';
  },
  updateCard: async (_ref: unknown, activityId: string, card: unknown) => {
    cardUpdates.push({ activityId, card });
    return true;
  },
}));
mock.module('../channels/install-store', () => ({
  ...realInstallStore,
  loadTeamsServiceUrlForProject: async () => 'https://smba.example.test/teams/',
}));
mock.module('../channels/teams/binding', () => ({
  ...realBinding,
  resolveConversationProject: async () => project.project_id,
}));
mock.module('../channels/teams/session', () => ({
  ...realTeamsSession,
  createOrJoinTeamsConversationSession: async (input: { activity: { text: string } }) => {
    resumed.push(input.activity.text);
  },
}));

const { postApprovalCard } = await import('../channels/approval-card-relay');
const { handleAdaptiveCardAction } = await import('../channels/teams/interactivity');
const { decideConnectorApproval, loadApprovalRow } = await import('../projects/lib/connector-approval-decision');

const MANAGER = crypto.randomUUID();
const BYSTANDER = crypto.randomUUID();
let sessionId: string;

async function pending(summary: Record<string, unknown> = { args_preview: { draft_id: 'r-1' }, args_preview_complete: true }) {
  const [row] = await db
    .insert(connectorCalls)
    .values({
      accountId: project.account_id,
      projectId: project.project_id,
      actionPath: 'gmail.send_draft',
      actingUserId: BYSTANDER,
      sessionId,
      status: 'pending_approval',
      risk: 'write',
      resultSummary: summary,
    })
    .returning({ id: connectorCalls.executionId });
  return row.id;
}

const press = (executionId: string, decision: 'approve' | 'deny', aad: string, note?: string) =>
  handleAdaptiveCardAction({
    type: 'invoke',
    name: 'adaptiveCard/action',
    id: 'act-1',
    serviceUrl: 'https://smba.example.test/teams/',
    from: { id: `29:${aad}`, aadObjectId: aad },
    conversation: { id: CONVO, tenantId: TENANT },
    value: {
      action: {
        type: 'Action.Execute',
        verb: 'teams_approval',
        data: { verb: 'teams_approval', executionId, decision, ...(note ? { approvalNote: note } : {}) },
      },
    },
  } as never);

beforeAll(async () => {
  project = await seedProject('teams-approval-card');
  await insertIntoView(db, accountMembers, { userId: MANAGER, accountId: project.account_id, accountRole: 'owner' });
  await insertIntoView(db, accountMembers, { userId: BYSTANDER, accountId: project.account_id, accountRole: 'member' });
  await insertIntoView(db, projectMembers, {
    accountId: project.account_id,
    projectId: project.project_id,
    userId: BYSTANDER,
    projectRole: 'member',
  });
  sessionId = crypto.randomUUID();
  // The session was started by someone else, so BYSTANDER is neither its
  // launcher nor a manager.
  await db.insert(projectSessions).values({
    sessionId,
    accountId: project.account_id,
    projectId: project.project_id,
    branchName: `session/${sessionId}`,
    createdBy: MANAGER,
    metadata: { source: 'teams', teams: { tenant_id: TENANT, conversation_id: CONVO } },
  });
  await db.insert(chatThreads).values({
    projectId: project.project_id,
    platform: 'teams',
    workspaceId: TENANT,
    threadId: CONVO,
    sessionId,
  });
  await db.insert(chatUserIdentities).values([
    { platform: 'teams', workspaceId: TENANT, platformUserId: 'aad-manager', userId: MANAGER },
    { platform: 'teams', workspaceId: TENANT, platformUserId: 'aad-bystander', userId: BYSTANDER },
  ]);
});

beforeEach(() => {
  sent.length = 0;
  cardUpdates.length = 0;
  resumed.length = 0;
});

afterAll(async () => {
  await db.delete(chatUserIdentities).where(eq(chatUserIdentities.workspaceId, TENANT));
  await db.delete(connectorCalls).where(eq(connectorCalls.projectId, project.project_id));
  await db.delete(chatThreads).where(eq(chatThreads.projectId, project.project_id));
  await db.delete(projectSessions).where(eq(projectSessions.projectId, project.project_id));
  await removeSeeded([project]);
});

test('a gated call from a Teams session posts the card and remembers the activity', async () => {
  const executionId = await pending();
  const result = await postApprovalCard({
    projectId: project.project_id,
    sessionId,
    executionId,
    actionPath: 'gmail.send_draft',
    risk: 'write',
    resultSummary: {
      args_preview: { draft_id: 'r-1' },
      args_preview_complete: true,
      approval_context: 'Sends draft r-1 to buyer@example.test',
    },
    approvalUrl: 'https://kortix.test/approve/ksl_x',
  });
  expect(result).toEqual({ posted: true });
  expect(JSON.stringify(sent[0])).toContain('Sends draft r-1 to buyer@example.test');
  expect(JSON.stringify(sent[0])).toContain('approvalNote');
  const row = await loadApprovalRow(project.project_id, executionId);
  expect((row?.resultSummary as Record<string, unknown>).chat_card).toEqual({
    platform: 'teams',
    session_id: sessionId,
    activity_id: 'activity-1',
  });
});

test('a manager denies with a message: denied, the card becomes the outcome, the agent resumes with the message', async () => {
  const executionId = await pending();

  const response = await press(executionId, 'deny', 'aad-manager', 'Ask about Thursday instead.');

  expect(await loadApprovalRow(project.project_id, executionId)).toMatchObject({ status: 'denied', approvedBy: MANAGER });
  expect(response.type).toBe('application/vnd.microsoft.card.adaptive');
  expect(JSON.stringify(response.value)).toContain('Denied: gmail.send_draft');
  expect(resumed).toEqual([
    'Your request to run gmail.send_draft was denied. Message from the approver:\nAsk about Thursday instead.',
  ]);
});

test('a member who is neither manager nor launcher gets a refusal and the card keeps its buttons', async () => {
  const executionId = await pending();

  const response = await press(executionId, 'approve', 'aad-bystander');

  expect((await loadApprovalRow(project.project_id, executionId))?.status).toBe('pending_approval');
  expect(response).toEqual({
    statusCode: 200,
    type: 'application/vnd.microsoft.activity.message',
    value: 'Only a project manager or the person who started this session can decide.',
  });
  expect(resumed).toHaveLength(0);
});

test('a decision made in Kortix updates the Teams card', async () => {
  const executionId = await pending({
    args_preview: { draft_id: 'r-1' },
    args_preview_complete: true,
    chat_card: { platform: 'teams', session_id: sessionId, activity_id: 'activity-7' },
  });
  const row = await loadApprovalRow(project.project_id, executionId);
  await decideConnectorApproval({
    projectId: project.project_id,
    accountId: project.account_id,
    row: row!,
    decision: 'approve',
    note: '',
    actorUserId: MANAGER,
    auditSource: 'human',
    resume: 'queue',
  });
  await Bun.sleep(100);
  expect(cardUpdates).toHaveLength(1);
  expect(cardUpdates[0].activityId).toBe('activity-7');
  expect(JSON.stringify(cardUpdates[0].card)).toContain('Approved: gmail.send_draft');
});
