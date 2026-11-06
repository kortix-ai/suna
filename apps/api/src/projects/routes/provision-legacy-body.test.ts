/**
 * `POST /v1/projects/provision` without an account keeps creating a project.
 *
 * Every client before Workspaces 1:1 (the published CLI, cached web and mobile
 * bundles, the SDK's provisionProject) sends no `new_workspace` flag. When the
 * caller's active account already holds its one project, or the caller has no
 * workspace yet, the request becomes a new workspace (201). So does a request
 * that names an occupied account the person may create in (the published CLI
 * sends `account_id`). A caller that may not create a workspace (an API key)
 * keeps the 409 `workspace_has_project`.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';

const AMBIENT = '00000000-0000-4000-8000-0000000000a1';
const NEW_ACCOUNT = '00000000-0000-4000-8000-0000000000a2';
const USER = '00000000-0000-4000-8000-0000000000c1';

let authType = 'pat';
let noWorkspace = false;
let ambientTaken = true;

const realAuth = await import('../../middleware/auth');
mock.module('../../middleware/auth', () => ({
  ...realAuth,
  supabaseAuth: async (c: { set(k: string, v: unknown): void }, next: () => Promise<void>) => {
    c.set('userId', USER);
    c.set('authType', authType);
    await next();
  },
}));

const realAccess = await import('../lib/access');
const { NoWorkspaceError } = await import('../../shared/no-workspace');
mock.module('../lib/access', () => ({
  ...realAccess,
  resolveProjectAccount: async (c: { set(k: string, v: unknown): void }, body?: Record<string, unknown>) => {
    if (noWorkspace) throw new NoWorkspaceError();
    const accountId = (body?.account_id as string | undefined) ?? AMBIENT;
    c.set('accountId', accountId);
    return { userId: USER, accountId, accountRole: 'owner' };
  },
}));

const realOneProject = await import('../../workspaces/one-project');
mock.module('../../workspaces/one-project', () => ({
  ...realOneProject,
  accountTakenForNewProject: async () => ambientTaken,
  workspaceHasProjectDenial: async (accountId: string) =>
    ambientTaken ? realOneProject.workspaceHasProjectBody(accountId, '00000000-0000-4000-8000-0000000000e1') : null,
}));

const realCore = await import('../provision-core');
mock.module('../provision-core', () => ({
  ...realCore,
  buildNewWorkspaceProvisionContext: async (body: Record<string, unknown>) => ({
    ctx: { body, scope: { userId: USER, accountId: NEW_ACCOUNT, accountRole: 'owner' }, newWorkspace: true },
  }),
  runProvision: async (ctx: { scope: { accountId: string }; newWorkspace?: boolean }) => {
    if (!ctx.newWorkspace && ambientTaken) {
      return { status: 409, body: realOneProject.workspaceHasProjectBody(ctx.scope.accountId, null) };
    }
    return { status: 201, body: { project_id: 'p-new', account_id: ctx.scope.accountId } };
  },
}));

const realIam = await import('../../iam');
mock.module('../../iam', () => ({ ...realIam, authorize: async () => ({ allowed: true }) }));
const realActor = await import('../../iam/actor');
mock.module('../../iam/actor', () => ({ ...realActor, actorOf: async () => ({}) }));

const { projectsApp } = await import('../lib/app');
const { registerProjectsRoutes } = await import('./projects');
registerProjectsRoutes();

async function provision(body: Record<string, unknown>) {
  const res = await projectsApp.request('/provision', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

beforeEach(() => {
  authType = 'pat';
  noWorkspace = false;
  ambientTaken = true;
});

describe('POST /provision with a pre-Workspaces body', () => {
  test('an occupied active account: 201, the project lands in a new workspace', async () => {
    const res = await provision({ name: 'second' });
    expect(res.status).toBe(201);
    expect(res.body.account_id).toBe(NEW_ACCOUNT);
  });

  test('no workspace yet: 201 in a new workspace, not 409 no_workspace', async () => {
    noWorkspace = true;
    const res = await provision({ name: 'first' });
    expect(res.status).toBe(201);
    expect(res.body.account_id).toBe(NEW_ACCOUNT);
  });

  test('an empty active account: the project lands there', async () => {
    ambientTaken = false;
    const res = await provision({ name: 'first' });
    expect(res.status).toBe(201);
    expect(res.body.account_id).toBe(AMBIENT);
  });

  test('an explicitly named occupied account (the published CLI): 201 in a new workspace', async () => {
    const res = await provision({ name: 'second', account_id: AMBIENT });
    expect(res.status).toBe(201);
    expect(res.body.account_id).toBe(NEW_ACCOUNT);
  });

  test('an API key naming an occupied account keeps 409 workspace_has_project', async () => {
    authType = 'api_key';
    const res = await provision({ name: 'second', account_id: AMBIENT });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('workspace_has_project');
    expect(res.body.account_id).toBe(AMBIENT);
  });

  test('a caller that may not create a workspace (an API key) keeps 409', async () => {
    authType = 'api_key';
    const res = await provision({ name: 'second' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('workspace_has_project');
  });
});
