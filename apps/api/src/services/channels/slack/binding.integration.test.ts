/**
 * Real-Postgres contract for Slack thread binding: a session that posts in a
 * DM (no channel binding) binds its thread through the project's install, a
 * reply in that thread resolves to the session's project even when the
 * workspace has several projects installed, and a bound thread moves only by
 * `force` between one user's own sessions.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { accounts, chatThreads, projectSessions, projects } from '@kortix/db';
import { eq } from 'drizzle-orm';
import { findChatThread } from '../core/threads';
import { deleteSlackInstall, saveSlackInstall } from '../install-store';
import { db } from '../../../lib/db';
import { bindSlackThreadToSession } from './binding';
import { resolveOauthProject } from './dispatch';

const ACCOUNT = crypto.randomUUID();
const PROJECT = crypto.randomUUID();
const OTHER_PROJECT = crypto.randomUUID();
const USER = crypto.randomUUID();
const OTHER_USER = crypto.randomUUID();
const WEB_SESSION = crypto.randomUUID();
const SIBLING_SESSION = crypto.randomUUID();
const FOREIGN_SESSION = crypto.randomUUID();
const OTHER_PROJECT_SESSION = crypto.randomUUID();
const TEAM = `TBIND${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
const DM = 'D0SYNTHETIC';

beforeAll(async () => {
  await db.insert(accounts).values({ accountId: ACCOUNT, name: 'slack-bind-test' });
  await db.insert(projects).values([
    { projectId: PROJECT, accountId: ACCOUNT, name: 'slack-bind-a', repoUrl: 'https://example.test/a.git' },
    { projectId: OTHER_PROJECT, accountId: ACCOUNT, name: 'slack-bind-b', repoUrl: 'https://example.test/b.git' },
  ]);
  await db.insert(projectSessions).values([
    { sessionId: WEB_SESSION, accountId: ACCOUNT, projectId: PROJECT, branchName: WEB_SESSION, createdBy: USER },
    { sessionId: SIBLING_SESSION, accountId: ACCOUNT, projectId: PROJECT, branchName: SIBLING_SESSION, createdBy: USER },
    { sessionId: FOREIGN_SESSION, accountId: ACCOUNT, projectId: PROJECT, branchName: FOREIGN_SESSION, createdBy: OTHER_USER },
    {
      sessionId: OTHER_PROJECT_SESSION,
      accountId: ACCOUNT,
      projectId: OTHER_PROJECT,
      branchName: OTHER_PROJECT_SESSION,
      createdBy: USER,
    },
  ]);
  // Two projects installed in one workspace: an unbound DM is "ambiguous".
  for (const projectId of [PROJECT, OTHER_PROJECT]) {
    await saveSlackInstall({
      projectId,
      teamId: TEAM,
      teamName: 'synthetic',
      botToken: 'xoxb-synthetic',
      signingSecret: 'synthetic',
      botUserId: 'UBOT',
    });
  }
});

afterAll(async () => {
  await db.delete(chatThreads).where(eq(chatThreads.workspaceId, TEAM));
  for (const projectId of [PROJECT, OTHER_PROJECT]) await deleteSlackInstall(projectId);
  await db.delete(projects).where(eq(projects.accountId, ACCOUNT));
  await db.delete(accounts).where(eq(accounts.accountId, ACCOUNT));
});

describe('Slack thread binding — migrated PostgreSQL', () => {
  test('a DM post binds through the project install, and the reply resolves to that project, not a picker', async () => {
    expect(await resolveOauthProject(TEAM, DM)).toMatchObject({ kind: 'ambiguous' });

    const binding = await bindSlackThreadToSession({
      projectId: PROJECT,
      sessionId: WEB_SESSION,
      channel: DM,
      threadTs: '1700000000.000100',
    });
    expect(binding).toEqual({ bound: true, thread_ts: '1700000000.000100', session_id: WEB_SESSION });
    expect(await findChatThread({ platform: 'slack', workspaceId: TEAM, threadId: '1700000000.000100' })).toEqual({
      sessionId: WEB_SESSION,
      projectId: PROJECT,
    });

    expect(await resolveOauthProject(TEAM, DM, '1700000000.000100')).toEqual({ kind: 'project', projectId: PROJECT });
    // A top-level DM is a new thread and still asks which project.
    expect(await resolveOauthProject(TEAM, DM, undefined)).toMatchObject({ kind: 'ambiguous' });
  });

  test('a bound thread is reported, never taken, without force', async () => {
    const binding = await bindSlackThreadToSession({
      projectId: PROJECT,
      sessionId: SIBLING_SESSION,
      channel: DM,
      threadTs: '1700000000.000100',
    });
    expect(binding).toEqual({
      bound: false,
      thread_ts: '1700000000.000100',
      reason: 'thread_bound_to_another_session',
      owner_session_id: WEB_SESSION,
    });
  });

  test('force moves a thread between one user\'s sessions of the project', async () => {
    const binding = await bindSlackThreadToSession({
      projectId: PROJECT,
      sessionId: SIBLING_SESSION,
      channel: DM,
      threadTs: '1700000000.000100',
      force: true,
    });
    expect(binding).toEqual({
      bound: true,
      thread_ts: '1700000000.000100',
      session_id: SIBLING_SESSION,
      rebound_from: WEB_SESSION,
    });
    expect((await findChatThread({ platform: 'slack', workspaceId: TEAM, threadId: '1700000000.000100' }))?.sessionId).toBe(
      SIBLING_SESSION,
    );
  });

  test('force refuses another user\'s thread and another project\'s thread', async () => {
    await bindSlackThreadToSession({ projectId: PROJECT, sessionId: FOREIGN_SESSION, channel: DM, threadTs: '1700000000.000200' });
    expect(
      await bindSlackThreadToSession({
        projectId: PROJECT,
        sessionId: WEB_SESSION,
        channel: DM,
        threadTs: '1700000000.000200',
        force: true,
      }),
    ).toMatchObject({ bound: false, reason: 'thread_owned_by_another_user', owner_session_id: FOREIGN_SESSION });

    await bindSlackThreadToSession({
      projectId: OTHER_PROJECT,
      sessionId: OTHER_PROJECT_SESSION,
      channel: DM,
      threadTs: '1700000000.000300',
    });
    const crossProject = await bindSlackThreadToSession({
      projectId: PROJECT,
      sessionId: WEB_SESSION,
      channel: DM,
      threadTs: '1700000000.000300',
      force: true,
    });
    expect(crossProject).toEqual({ bound: false, thread_ts: '1700000000.000300', reason: 'thread_owned_by_another_project' });

    for (const [threadId, owner] of [
      ['1700000000.000200', FOREIGN_SESSION],
      ['1700000000.000300', OTHER_PROJECT_SESSION],
    ]) {
      expect((await findChatThread({ platform: 'slack', workspaceId: TEAM, threadId }))?.sessionId).toBe(owner);
    }
  });
});
