/**
 * Integration test (real local PostgreSQL): the Slack approval card for a
 * policy-gated connector call, from posting to a decision in the thread.
 *
 * Real: the connector_calls row, the session and its chat thread, chat
 * identities, IAM roles, the decision core. Faked: only Slack's HTTP surface
 * (slack-api, response_url) and the follow-up turn spawn.
 */
import { afterAll, beforeAll, beforeEach, expect, mock, test } from 'bun:test';
import {
  accountMembers,
  chatThreads,
  chatUserIdentities,
  connectorCalls,
  projectMembers,
  projectSessions,
  sessionLifecycleCommands,
} from '@kortix/db';
import { eq } from 'drizzle-orm';
import * as realSlackApi from '../channels/slack-api';
import * as realDispatch from '../channels/slack/dispatch';
import * as realInstallStore from '../channels/install-store';
import { db } from '../shared/db';
import { insertIntoView } from './helpers/compat-views';
import { removeSeeded, seedProject, type SeededProject } from './helpers/integration-fixtures';

const posted: Array<{ channel: string; threadTs?: string; blocks: unknown[] }> = [];
const updated: Array<{ channel: string; ts: string; blocks: unknown[] }> = [];
const modals: unknown[] = [];
const spawned: Array<{ text: string; user: string }> = [];
const ephemeral: string[] = [];

mock.module('../channels/slack-api', () => ({
  ...realSlackApi,
  postBlocks: async (_t: string, channel: string, _x: string, blocks: unknown[], threadTs?: string) => {
    posted.push({ channel, threadTs, blocks });
    return '200.0001';
  },
  updateBlocks: async (_t: string, channel: string, ts: string, _x: string, blocks: unknown[]) => {
    updated.push({ channel, ts, blocks });
    return true;
  },
  openModal: async (_t: string, _trigger: string, view: unknown) => {
    modals.push(view);
    return true;
  },
}));
mock.module('../channels/slack/dispatch', () => ({
  ...realDispatch,
  spawnAgentTurn: async (_p: string, _e: unknown, event: { text: string; user: string }) => {
    spawned.push({ text: event.text, user: event.user });
  },
}));
mock.module('../channels/install-store', () => ({
  ...realInstallStore,
  loadSlackTokenForProject: async () => 'xoxb-test',
}));
globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
  const body = JSON.parse(init?.body ?? '{}') as { text?: string };
  if (body.text) ephemeral.push(body.text);
  return new Response('ok');
}) as unknown as typeof fetch;

const { postApprovalCard, markApprovalCardDecided } = await import('../channels/approval-card-relay');
const { handleBlockAction, handleViewSubmission } = await import('../channels/slack/interactivity');
const { approvalActionId } = await import('../channels/slack/approval-card');
const { decideConnectorApproval, loadApprovalRow } = await import('../projects/lib/connector-approval-decision');

const TEAM = 'T0APPROVAL';
const CHANNEL = 'C0APPROVAL';
const THREAD = '100.0001';
const OWNER = crypto.randomUUID();
const LAUNCHER = crypto.randomUUID();
const BYSTANDER = crypto.randomUUID();
const SLACK = { owner: 'U0OWNER', launcher: 'U0LAUNCH', bystander: 'U0BYSTAND' };
let project: SeededProject;
let sessionId: string;
let otherSessionId: string;

async function pending(summary: Record<string, unknown> = { args_preview: { draft_id: 'r-1' }, args_preview_complete: true }, session = sessionId) {
  const [row] = await db
    .insert(connectorCalls)
    .values({
      accountId: project.account_id,
      projectId: project.project_id,
      actionPath: 'gmail.send_draft',
      actingUserId: LAUNCHER,
      sessionId: session,
      status: 'pending_approval',
      risk: 'write',
      resultSummary: summary,
    })
    .returning({ id: connectorCalls.executionId });
  return row.id;
}

const click = (verb: 'approve' | 'deny' | 'reply', executionId: string, slackUser: string, thread = THREAD) =>
  handleBlockAction({
    type: 'block_actions',
    team: { id: TEAM },
    channel: { id: CHANNEL },
    user: { id: slackUser },
    trigger_id: 'trigger-1',
    response_url: 'https://hooks.slack.com/actions/T/1/x',
    message: { ts: '200.0001', thread_ts: thread },
    actions: [{ action_id: approvalActionId(verb, executionId) }],
  } as never);

beforeAll(async () => {
  project = await seedProject('slack-approval-card');
  await insertIntoView(db, accountMembers, { userId: OWNER, accountId: project.account_id, accountRole: 'owner' });
  for (const userId of [LAUNCHER, BYSTANDER]) {
    await insertIntoView(db, accountMembers, { userId, accountId: project.account_id, accountRole: 'member' });
    await insertIntoView(db, projectMembers, {
      accountId: project.account_id,
      projectId: project.project_id,
      userId,
      projectRole: 'member',
    });
  }
  sessionId = crypto.randomUUID();
  otherSessionId = crypto.randomUUID();
  for (const [id, thread] of [
    [sessionId, THREAD],
    [otherSessionId, '300.0001'],
  ] as const) {
    await db.insert(projectSessions).values({
      sessionId: id,
      accountId: project.account_id,
      projectId: project.project_id,
      branchName: `session/${id}`,
      createdBy: LAUNCHER,
      metadata: { source: 'slack', slack: { team_id: TEAM, channel: CHANNEL, thread_ts: thread } },
    });
    await db.insert(chatThreads).values({
      projectId: project.project_id,
      platform: 'slack',
      workspaceId: TEAM,
      threadId: thread,
      sessionId: id,
    });
  }
  await db.insert(chatUserIdentities).values([
    { platform: 'slack', workspaceId: TEAM, platformUserId: SLACK.owner, userId: OWNER },
    { platform: 'slack', workspaceId: TEAM, platformUserId: SLACK.launcher, userId: LAUNCHER },
    { platform: 'slack', workspaceId: TEAM, platformUserId: SLACK.bystander, userId: BYSTANDER },
  ]);
});

beforeEach(() => {
  posted.length = 0;
  updated.length = 0;
  modals.length = 0;
  spawned.length = 0;
  ephemeral.length = 0;
});

afterAll(async () => {
  await db.delete(chatUserIdentities).where(eq(chatUserIdentities.workspaceId, TEAM));
  await db.delete(connectorCalls).where(eq(connectorCalls.projectId, project.project_id));
  await db.delete(sessionLifecycleCommands).where(eq(sessionLifecycleCommands.projectId, project.project_id));
  await db.delete(chatThreads).where(eq(chatThreads.projectId, project.project_id));
  await db.delete(projectSessions).where(eq(projectSessions.projectId, project.project_id));
  await removeSeeded([project]);
});

test('a gated call from a Slack session posts the card into its thread and remembers where', async () => {
  const executionId = await pending({
    args_preview: { draft_id: 'r-1' },
    args_preview_complete: true,
    approval_context: 'Sends draft r-1 to buyer@example.test',
  });
  const result = await postApprovalCard({
    projectId: project.project_id,
    sessionId,
    executionId,
    actionPath: 'gmail.send_draft',
    risk: 'write',
    resultSummary: { args_preview: { draft_id: 'r-1' }, args_preview_complete: true, approval_context: 'Sends draft r-1 to buyer@example.test' },
    approvalUrl: 'https://kortix.test/approve/ksl_x',
  });

  expect(result).toEqual({ posted: true });
  expect(posted).toHaveLength(1);
  expect(posted[0]).toMatchObject({ channel: CHANNEL, threadTs: THREAD });
  expect(JSON.stringify(posted[0].blocks)).toContain('Sends draft r-1 to buyer@example.test');
  const row = await loadApprovalRow(project.project_id, executionId);
  expect((row?.resultSummary as Record<string, unknown>).chat_card).toEqual({
    platform: 'slack',
    team_id: TEAM,
    channel: CHANNEL,
    ts: '200.0001',
  });
});

test('a session with no Slack thread posts nothing', async () => {
  const webSession = crypto.randomUUID();
  await db.insert(projectSessions).values({
    sessionId: webSession,
    accountId: project.account_id,
    projectId: project.project_id,
    branchName: `session/${webSession}`,
    createdBy: LAUNCHER,
  });
  const result = await postApprovalCard({
    projectId: project.project_id,
    sessionId: webSession,
    executionId: crypto.randomUUID(),
    actionPath: 'gmail.send_draft',
    risk: 'write',
    resultSummary: {},
    approvalUrl: null,
  });
  expect(result).toEqual({ posted: false });
  expect(posted).toHaveLength(0);
});

test('a manager denies in the thread: the call is denied, the card shows it, the agent resumes in Slack', async () => {
  const executionId = await pending({
    args_preview: { draft_id: 'r-1' },
    args_preview_complete: true,
    chat_card: { platform: 'slack', team_id: TEAM, channel: CHANNEL, ts: '200.0001' },
  });

  await click('deny', executionId, SLACK.owner);

  const row = await loadApprovalRow(project.project_id, executionId);
  expect(row).toMatchObject({ status: 'denied', approvedBy: OWNER });
  expect(spawned).toEqual([
    { text: 'Your request to run gmail.send_draft was denied — continue without it.', user: SLACK.owner },
  ]);
  // The Slack turn resumes the session; no queued continuation doubles it.
  const [queued] = await db
    .select()
    .from(sessionLifecycleCommands)
    .where(eq(sessionLifecycleCommands.idempotencyKey, `approval-resume:${executionId}`));
  expect(queued).toBeUndefined();
  await Bun.sleep(50);
  expect(updated).toHaveLength(1);
  expect(JSON.stringify(updated[0].blocks)).toContain('*Denied*');
  expect(JSON.stringify(updated[0].blocks)).toContain(`<@${SLACK.owner}>`);
});

test('a member who neither manages the project nor started the session cannot decide', async () => {
  const executionId = await pending();

  await click('approve', executionId, SLACK.bystander);

  expect((await loadApprovalRow(project.project_id, executionId))?.status).toBe('pending_approval');
  expect(ephemeral).toEqual(['Only a project manager or the person who started this session can decide.']);
  expect(spawned).toHaveLength(0);
});

test('a card clicked from another session\'s thread decides nothing', async () => {
  const executionId = await pending();

  await click('approve', executionId, SLACK.owner, '300.0001');

  expect((await loadApprovalRow(project.project_id, executionId))?.status).toBe('pending_approval');
  expect(ephemeral).toEqual(['That approval is no longer available.']);
});

test('the launcher replies with a message: approve plus note reaches the agent', async () => {
  const executionId = await pending();

  await click('reply', executionId, SLACK.launcher);
  expect(modals).toHaveLength(1);
  const view = modals[0] as { callback_id: string; private_metadata: string };

  await handleViewSubmission({
    type: 'view_submission',
    user: { id: SLACK.launcher },
    view: {
      callback_id: view.callback_id,
      private_metadata: view.private_metadata,
      state: {
        values: {
          approval_decision_block: { approval_decision_input: { selected_option: { value: 'approve' } } },
          approval_note_block: { approval_note_input: { value: 'Send it, then tell me when she answers.' } },
        },
      },
    },
  } as never);

  const row = await loadApprovalRow(project.project_id, executionId);
  expect(row).toMatchObject({ status: 'ok', approvedBy: LAUNCHER });
  expect((row?.resultSummary as Record<string, unknown>).decision_note).toBe('Send it, then tell me when she answers.');
  expect(spawned).toEqual([
    {
      text: 'Your pending approval to run gmail.send_draft was approved — continue.\n\nMessage from the approver:\nSend it, then tell me when she answers.',
      user: SLACK.launcher,
    },
  ]);
});

test('a call with nothing to review cannot be approved from the card', async () => {
  const executionId = await pending({ args_preview_complete: false });

  await click('approve', executionId, SLACK.owner);

  expect((await loadApprovalRow(project.project_id, executionId))?.status).toBe('pending_approval');
  expect(ephemeral).toEqual(['This call recorded no parameters to review, so it can only be denied.']);
});

test('a decision made in Kortix replaces the card buttons in the thread too', async () => {
  const executionId = await pending({
    args_preview: { draft_id: 'r-1' },
    args_preview_complete: true,
    chat_card: { platform: 'slack', team_id: TEAM, channel: CHANNEL, ts: '200.0009' },
  });
  const row = await loadApprovalRow(project.project_id, executionId);

  // The web surface supplies the card relay as the decision's observer (see
  // routes/approvals.ts); the decision core itself stays out of channels.
  const updateStaleCard = () =>
    markApprovalCardDecided({
      projectId: project.project_id,
      row: row!,
      decision: 'approve',
      note: 'Looks right.',
      actorUserId: LAUNCHER,
    });
  const outcome = await decideConnectorApproval({
    projectId: project.project_id,
    accountId: project.account_id,
    row: row!,
    decision: 'approve',
    note: 'Looks right.',
    actorUserId: LAUNCHER,
    auditSource: 'human',
    resume: 'queue',
    updateStaleCard,
  });

  expect(outcome).toBe('resolved');
  await Bun.sleep(100);
  expect(updated).toHaveLength(1);
  expect(updated[0]).toMatchObject({ channel: CHANNEL, ts: '200.0009' });
  expect(JSON.stringify(updated[0].blocks)).toContain(`<@${SLACK.launcher}>`);
  expect(JSON.stringify(updated[0].blocks)).toContain('Looks right.');

  // A call that already resolved decides nothing and fires no observer.
  const again = await decideConnectorApproval({
    projectId: project.project_id,
    accountId: project.account_id,
    row: row!,
    decision: 'deny',
    note: '',
    actorUserId: LAUNCHER,
    auditSource: 'human',
    resume: 'queue',
    updateStaleCard,
  });
  expect(again).toBe('already_resolved');
  await Bun.sleep(100);
  expect(updated).toHaveLength(1);
});
