import { expect, test } from 'bun:test';
import { Hono } from 'hono';

import { toWorkspacePayload, workspaceResponseCompatibility } from './compat';

test('toWorkspacePayload maps Project wire keys recursively without changing values', () => {
  expect(
    toWorkspacePayload({
      project_id: 'workspace-1',
      project_role: 'editor',
      effective_project_role: 'manager',
      project: { project_id: 'workspace-1' },
      projects: [{ project_id: 'workspace-1' }],
      dashboard_url: 'https://dev.kortix.com/projects/workspace-1',
      untouched: { account_id: 'account-1' },
    }),
  ).toEqual({
    workspace_id: 'workspace-1',
    workspace_role: 'editor',
    effective_workspace_role: 'manager',
    workspace: { workspace_id: 'workspace-1' },
    workspaces: [{ workspace_id: 'workspace-1' }],
    dashboard_url: 'https://dev.kortix.com/workspaces/workspace-1',
    untouched: { account_id: 'account-1' },
  });
});

test('toWorkspacePayload preserves existing canonical keys', () => {
  expect(
    toWorkspacePayload({ project_id: 'legacy', workspace_id: 'canonical' }),
  ).toEqual({ workspace_id: 'canonical' });
});

test('workspaceResponseCompatibility maps JSON responses and preserves status and headers', async () => {
  const app = new Hono();
  app.use('*', workspaceResponseCompatibility);
  app.get('/', (c) => c.json({ project_id: 'workspace-1' }, 201, { 'x-proof': 'kept' }));

  const response = await app.request('/');

  expect(response.status).toBe(201);
  expect(response.headers.get('x-proof')).toBe('kept');
  expect(await response.json()).toEqual({ workspace_id: 'workspace-1' });
});

test('workspaceResponseCompatibility leaves non-JSON and empty responses unchanged', async () => {
  const app = new Hono();
  app.use('*', workspaceResponseCompatibility);
  app.get('/stream', (c) => c.text('project_id'));
  app.get('/empty', (c) => c.body(null, 204));

  const stream = await app.request('/stream');
  expect(stream.headers.get('content-type') ?? '').not.toContain('application/json');
  expect(await stream.text()).toBe('project_id');

  const empty = await app.request('/empty');
  expect(empty.status).toBe(204);
  expect(await empty.text()).toBe('');
});
