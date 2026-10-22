/**
 * KRTX-2979: POST /v1/projects/:id/skills/remove wrapped every repository
 * failure in one bare 502 "Could not remove the skill from the repository"
 * and logged nothing. A disconnected repository needs a person to act, so it
 * gets the shared 409 that names the fix; any other failure keeps the 502.
 * Real DB, real route, real global error handler; only the git mirror and the
 * git credential lookup are stubbed.
 */
import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import * as realMirror from '../projects/git/mirror';
import * as realGit from '../projects/lib/git';

let mirrorFailure: Error = new Error('unset');
mock.module('../projects/git/mirror', () => ({
  ...realMirror,
  refreshMirror: async () => {
    throw mirrorFailure;
  },
}));
mock.module('../projects/lib/git', () => ({
  ...realGit,
  withProjectGitAuth: async (row: Record<string, unknown>) => ({ ...row, gitAuthToken: null, gitAuthHeaders: {} }),
}));

const { OpenAPIHono } = await import('@hono/zod-openapi');
const { db } = await import('../shared/db');
const { projectsApp } = await import('../projects/lib/app');
const { registerProjectSkillsRoutes } = await import('../projects/routes/project-skills');
const { installHttpErrors } = await import('../http-errors');
const { RepositoryDisconnectedError, REPOSITORY_DISCONNECTED_CODE } = await import('../shared/repository-health');

const ACCOUNT = crypto.randomUUID();
const PROJECT = crypto.randomUUID();
const USER = crypto.randomUUID();

projectsApp.use('*', async (c, next) => {
  if (c.req.path.includes(`/${PROJECT}/`)) {
    c.set('userId', USER);
    c.set('authType', 'supabase');
  }
  await next();
});
registerProjectSkillsRoutes();
const app = new OpenAPIHono();
installHttpErrors(app);
app.route('/v1/projects', projectsApp);

beforeAll(async () => {
  await db.execute(sql`insert into kortix.accounts (account_id, name) values (${ACCOUNT}, 'krtx2979-skill-remove')`);
  await db.execute(sql`insert into kortix.account_members (user_id, account_id, account_role) values (${USER}, ${ACCOUNT}, 'owner')`);
  await db.execute(sql`insert into kortix.projects (project_id, account_id, name, repo_url) values (${PROJECT}, ${ACCOUNT}, 'krtx2979-skill-remove', 'https://github.com/example/krtx2979.git')`);
});

afterAll(async () => {
  await db.execute(sql`delete from kortix.projects where project_id = ${PROJECT}`);
  await db.execute(sql`delete from kortix.accounts where account_id = ${ACCOUNT}`);
});

const remove = () =>
  app.request(`/v1/projects/${PROJECT}/skills/remove`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ folder: 'skills/example', confirm: true }),
  });

describe('POST /v1/projects/:projectId/skills/remove when the repository step fails', () => {
  test('a disconnected repository is the shared 409 that names the fix', async () => {
    mirrorFailure = new RepositoryDisconnectedError({ reason: 'app_uninstalled', repository: 'example/krtx2979', installationId: null });
    const response = await remove();
    expect(response.status).toBe(409);
    expect(((await response.json()) as { code: string }).code).toBe(REPOSITORY_DISCONNECTED_CODE);
  });

  test('any other failure stays the 502', async () => {
    mirrorFailure = new Error('fatal: unable to access the repository');
    const response = await remove();
    expect(response.status).toBe(502);
    expect(((await response.json()) as { error: string }).error).toBe('Could not remove the skill from the repository');
  });
});
