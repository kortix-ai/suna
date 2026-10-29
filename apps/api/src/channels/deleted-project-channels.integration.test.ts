/**
 * Real-Postgres contract: Slack and Teams route no message to a deleted project.
 *
 * Two starting points, as in telegram/telegram-archived.integration.test.ts:
 * - `tombstone`: only the status changed (`archiveProjectAndRevokeTokens`); the
 *   installs, channel bindings and threads stay. Every project deleted before
 *   the delete released its channels looks like this. The routers skip it.
 * - `deleted`: the project went through the real DELETE route, which releases
 *   the Slack and Teams installs, their secrets and the channel bindings, and
 *   keeps the email inbox.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { accountMembers, accounts, chatChannelBindings, chatInstalls, chatThreads, projectSecrets, projectSessions, projects } from '@kortix/db';
import { and, eq, inArray, like, or } from 'drizzle-orm';
import { Hono } from 'hono';
import { insertIntoView } from '../__tests__/helpers/compat-views';
import { archiveProjectAndRevokeTokens } from '../projects/lib/project-deletion';
import { registerProjectSettingsRoutes } from '../projects/routes/project-settings';
import { projectsApp } from '../projects/surface';
import { db } from '../shared/db';
import { bindChatThread } from './core/threads';
import { saveSlackInstall, saveTeamsInstall } from './install-store';
import { resolveOauthProject } from './slack/dispatch';
import { listTenantProjects, resolveConversationProject, resolveConversationProjectDetailed } from './teams/binding';

const ACCOUNT = crypto.randomUUID();
const OWNER = crypto.randomUUID();
const TOMBSTONE = crypto.randomUUID();
const TOMBSTONE_SESSION = crypto.randomUUID();
const DELETED = crypto.randomUUID();
const LIVE = crypto.randomUUID();
const LIVE_2 = crypto.randomUUID();
const TAG = crypto.randomUUID().slice(0, 8).toUpperCase();
/** A Slack team or Teams tenant of this run. */
const ws = (name: string) => `${name}${TAG}`;

const install = (platform: string, workspaceId: string, ...projectIds: string[]) =>
  db.insert(chatInstalls).values(projectIds.map((projectId) => ({ platform, workspaceId, projectId })));
const bind = (platform: string, workspaceId: string, channelId: string, projectId: string) =>
  db.insert(chatChannelBindings).values({ platform, workspaceId, channelId, projectId });
async function boundTo(platform: string, workspaceId: string, channelId: string) {
  const [row] = await db
    .select({ projectId: chatChannelBindings.projectId })
    .from(chatChannelBindings)
    .where(and(eq(chatChannelBindings.platform, platform), eq(chatChannelBindings.workspaceId, workspaceId), eq(chatChannelBindings.channelId, channelId)));
  return row ? row.projectId : 'unbound';
}

registerProjectSettingsRoutes();
/** A request as the account owner, through the real project routes. */
function asOwner(method: string, path: string) {
  const app = new Hono<{ Variables: Record<string, unknown> }>();
  app.use('*', async (c, next) => {
    c.set('userId', OWNER);
    c.set('authType', 'jwt');
    await next();
  });
  app.route('/v1/projects', projectsApp);
  return app.request(path, { method });
}

beforeAll(async () => {
  await db.insert(accounts).values({ accountId: ACCOUNT, name: 'deleted-project-channels-test' });
  await insertIntoView(db, accountMembers, { userId: OWNER, accountId: ACCOUNT, accountRole: 'owner', isSuperAdmin: false });
  await db.insert(projects).values(
    [TOMBSTONE, DELETED, LIVE, LIVE_2].map((projectId) => ({
      projectId,
      accountId: ACCOUNT,
      name: `channels-${projectId.slice(0, 8)}`,
      repoUrl: `file:///nonexistent/${projectId}.git`,
    })),
  );
  await db.insert(projectSessions).values({ sessionId: TOMBSTONE_SESSION, accountId: ACCOUNT, projectId: TOMBSTONE, branchName: TOMBSTONE_SESSION, createdBy: OWNER });

  await install('slack', ws('TONLY'), TOMBSTONE);
  await install('slack', ws('TONE'), TOMBSTONE, LIVE);
  await install('slack', ws('TMANY'), TOMBSTONE, LIVE, LIVE_2);
  await bind('slack', ws('TONE'), 'CBOUND', TOMBSTONE);
  await bind('slack', ws('TMANY'), 'CBOUND', TOMBSTONE);
  await bindChatThread({ projectId: TOMBSTONE, platform: 'slack', workspaceId: ws('TMANY'), threadId: '1700000000.000100', sessionId: TOMBSTONE_SESSION });
  await install('teams', ws('tenant-only-'), TOMBSTONE);
  await install('teams', ws('tenant-many-'), TOMBSTONE, LIVE);
  await bind('teams', ws('tenant-many-'), 'conv-bound', TOMBSTONE);
  expect(await archiveProjectAndRevokeTokens(TOMBSTONE, ACCOUNT)).toBeTruthy();
});

afterAll(async () => {
  const ids = [TOMBSTONE, DELETED, LIVE, LIVE_2];
  await db.delete(chatThreads).where(inArray(chatThreads.projectId, ids));
  await db.delete(chatChannelBindings).where(inArray(chatChannelBindings.projectId, ids));
  await db.delete(chatInstalls).where(inArray(chatInstalls.projectId, ids));
  await db.delete(projectSecrets).where(inArray(projectSecrets.projectId, ids));
  await db.delete(projectSessions).where(inArray(projectSessions.projectId, ids));
  await db.delete(projects).where(eq(projects.accountId, ACCOUNT));
  await db.delete(accounts).where(eq(accounts.accountId, ACCOUNT));
});

describe('Slack on a deleted project (tombstone) — migrated PostgreSQL', () => {
  test('a workspace whose only install is the deleted project resolves nothing and binds no channel', async () => {
    expect(await resolveOauthProject(ws('TONLY'), 'CNEW')).toEqual({ kind: 'none' });
    expect(await boundTo('slack', ws('TONLY'), 'CNEW')).toBe('unbound');
  });

  test('a channel bound to the deleted project resolves afresh: the one live install takes it', async () => {
    expect(await resolveOauthProject(ws('TONE'), 'CBOUND')).toEqual({ kind: 'project', projectId: LIVE });
    expect(await boundTo('slack', ws('TONE'), 'CBOUND')).toBe(LIVE);
  });

  test('with several live installs the picker offers only them, also in a channel bound to the deleted project', async () => {
    const picker = async (channelId: string) => {
      const resolution = await resolveOauthProject(ws('TMANY'), channelId);
      return resolution.kind === 'ambiguous' ? { ...resolution, projectIds: [...resolution.projectIds].sort() } : resolution;
    };
    const ambiguous = { kind: 'ambiguous' as const, projectIds: [LIVE, LIVE_2].sort() };
    expect(await picker('CNEW')).toEqual(ambiguous);
    expect(await picker('CBOUND')).toEqual(ambiguous);
    // The binding is gone, so the picker claims the channel and the pick writes it.
    expect(await boundTo('slack', ws('TMANY'), 'CBOUND')).toBe('unbound');
  });

  test("a reply in a thread of the deleted project's session resolves nothing", async () => {
    expect(await resolveOauthProject(ws('TMANY'), 'CTHREAD', '1700000000.000100')).toEqual({ kind: 'none' });
  });
});

describe('Teams on a deleted project (tombstone) — migrated PostgreSQL', () => {
  test('the lists behind /projects, /use, the picker and the home card leave it out', async () => {
    expect((await listTenantProjects(ws('tenant-many-'))).map((p) => p.projectId)).toEqual([LIVE]);
    expect(await listTenantProjects(ws('tenant-only-'))).toEqual([]);
  });

  test('a conversation bound to it runs the live install; a tenant with only the deleted project runs nothing', async () => {
    expect(await resolveConversationProject(ws('tenant-many-'), 'conv-bound')).toBe(LIVE);
    expect(await resolveConversationProjectDetailed(ws('tenant-many-'), 'conv-bound')).toEqual({ kind: 'project', projectId: LIVE });
    expect(await resolveConversationProject(ws('tenant-only-'), 'conv-new')).toBeNull();
    expect(await resolveConversationProjectDetailed(ws('tenant-only-'), 'conv-new')).toEqual({ kind: 'none' });
  });
});

describe('the project delete releases Slack and Teams — migrated PostgreSQL', () => {
  test('the installs, their secrets and the channel bindings go; the email inbox stays', async () => {
    await saveSlackInstall({ projectId: DELETED, teamId: ws('TDEL'), teamName: 'synthetic', botToken: 'xoxb-synthetic', signingSecret: 'synthetic', botUserId: 'UBOT' });
    await saveTeamsInstall({ projectId: DELETED, tenantId: ws('tenant-del-'), appId: 'synthetic-app', appPassword: 'synthetic' });
    await install('email', ws('inbox-'), DELETED);
    await bind('slack', ws('TDEL'), 'CDEL', DELETED);
    await bind('teams', ws('tenant-del-'), 'conv-del', DELETED);

    const res = await asOwner('DELETE', `/v1/projects/${DELETED}`);
    expect(res.status).toBe(200);

    const installs = await db.select({ platform: chatInstalls.platform }).from(chatInstalls).where(eq(chatInstalls.projectId, DELETED));
    const bindings = await db.select().from(chatChannelBindings).where(eq(chatChannelBindings.projectId, DELETED));
    const secrets = await db
      .select({ name: projectSecrets.name })
      .from(projectSecrets)
      .where(and(eq(projectSecrets.projectId, DELETED), or(like(projectSecrets.name, 'SLACK%'), like(projectSecrets.name, 'MS_TEAMS%'))));
    expect({ installs: installs.map((i) => i.platform), bindings: bindings.length, secrets: secrets.map((s) => s.name) }).toEqual({
      installs: ['email'],
      bindings: 0,
      secrets: [],
    });
    expect(await resolveOauthProject(ws('TDEL'), 'CDEL')).toEqual({ kind: 'none' });
    expect(await resolveConversationProjectDetailed(ws('tenant-del-'), 'conv-del')).toEqual({ kind: 'none' });
  });
});
