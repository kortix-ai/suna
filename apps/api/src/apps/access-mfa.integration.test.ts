/**
 * Opening a project-wide App in an account that requires MFA.
 *
 * `appAccessibleToUser` re-asks `project.read` through `authorize`. It built
 * that Actor with no MFA level, so the account MFA gate refused every member
 * except a super admin. The App list (the request's own Actor, aal2) showed the
 * App, and its card said "You do not have access to preview this App"
 * (2026-10-19).
 *
 * The auth middleware is replaced by a stub that sets what it sets for a
 * Supabase browser session, so the MFA level is the variable under test.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { accountMembers, accounts, apps, projectMembers } from '@kortix/db';
import { db } from '../shared/db';
import { insertIntoView } from '../__tests__/helpers/compat-views';
import {
  removeSeeded,
  seedProject,
  type SeededProject,
} from '../__tests__/helpers/integration-fixtures';

const { projectsApp } = await import('../projects/lib/app');
const { registerAppsRoutes } = await import('./routes');
registerAppsRoutes();

const OWNER = crypto.randomUUID();
const MEMBER = crypto.randomUUID();
const APP_ID = crypto.randomUUID();
let project: SeededProject;
let mfaAal: string | undefined;

const app = new Hono();
app.use('*', async (c, next) => {
  c.set('userId' as never, MEMBER as never);
  c.set('authType' as never, 'supabase' as never);
  if (mfaAal) c.set('mfaAal' as never, mfaAal as never);
  await next();
});
app.route('/v1/projects', projectsApp);

beforeAll(async () => {
  project = await seedProject('apps-mfa', { metadata: { experimental: { apps: true } } });
  // Required before anything authorizes in this account, so no cached actor misses it.
  await db.update(accounts).set({ mfaRequired: true }).where(eq(accounts.accountId, project.account_id));
  await insertIntoView(db, accountMembers, [
    { userId: OWNER, accountId: project.account_id, accountRole: 'owner', isSuperAdmin: false },
    { userId: MEMBER, accountId: project.account_id, accountRole: 'member', isSuperAdmin: false },
  ]);
  await insertIntoView(db, projectMembers, [
    { accountId: project.account_id, projectId: project.project_id, userId: MEMBER, projectRole: 'member' },
  ]);
  await db.insert(apps).values({
    appId: APP_ID,
    accountId: project.account_id,
    projectId: project.project_id,
    slug: 'mfa-test',
    name: 'MFA test',
    routeKey: 'cccccccccccccccc',
    createdBy: OWNER,
    accessMode: 'project',
  });
});

afterAll(async () => {
  await db.delete(apps).where(eq(apps.appId, APP_ID));
  await removeSeeded([project]);
});

const list = () => app.request(`/v1/projects/${project.project_id}/apps`);
const openSession = () =>
  app.request(`/v1/projects/${project.project_id}/apps/${APP_ID}/access-session`, { method: 'POST' });

describe('a project-wide App in an account that requires MFA', () => {
  test('after the step-up (aal2) a plain member lists the App and opens it', async () => {
    mfaAal = 'aal2';
    const listed = await list();
    expect(listed.status).toBe(200);
    const body = (await listed.json()) as { apps: Array<{ app_id: string; viewer_can_access: boolean }> };
    expect(body.apps.map((row) => [row.app_id, row.viewer_can_access])).toEqual([[APP_ID, true]]);

    const session = await openSession();
    expect(session.status).toBe(200);
    expect(((await session.json()) as { url: string }).url).toStartWith('http');
  });

  test('without the second factor the member neither lists nor opens it', async () => {
    mfaAal = 'aal1';
    expect((await list()).status).toBe(403);
    expect((await openSession()).status).toBe(403);
    mfaAal = undefined;
    expect((await openSession()).status).toBe(403);
  });
});
