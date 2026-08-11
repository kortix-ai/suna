import { expect, test } from 'bun:test';
import { Hono } from 'hono';

import {
  projectRequestCompatibility,
  projectResponseCompatibility,
  toProjectPayload,
  toWorkspaceRequestPayload,
} from './compat';

test('toProjectPayload maps canonical Workspace wire keys to the legacy Project shape', () => {
  expect(
    toProjectPayload({
      workspace_id: 'workspace-1',
      workspace_role: 'editor',
      effective_workspace_role: 'manager',
      workspace: { workspace_id: 'workspace-1' },
      workspaces: [{ workspace_id: 'workspace-1' }],
      dashboard_url: 'https://dev.kortix.com/workspaces/workspace-1',
      webhook_url: 'https://api.kortix.com/v1/webhooks/workspaces/workspace-1/hook',
      reason: 'workspace provisioning backpressure',
      error: 'Invitation does not target this workspace',
      defaultModelSource: 'workspace',
      kind: 'workspace',
      source: 'workspace',
      workspaceDefault: 'anthropic/claude-sonnet-4.6',
      workspace_spend: { requests: 2, cost: 1.5 },
      connection: {
        owner_type: 'workspace',
        authorization_strategy: 'workspace',
        mode: 'workspace',
        visibility: 'workspace',
        sharing: { mode: 'workspace' },
      },
      untouched: { account_id: 'account-1' },
    }),
  ).toEqual({
    project_id: 'workspace-1',
    project_role: 'editor',
    effective_project_role: 'manager',
    project: { project_id: 'workspace-1' },
    projects: [{ project_id: 'workspace-1' }],
    dashboard_url: 'https://dev.kortix.com/projects/workspace-1',
    webhook_url: 'https://api.kortix.com/v1/webhooks/projects/workspace-1/hook',
    reason: 'project provisioning backpressure',
    error: 'Invitation does not target this project',
    defaultModelSource: 'project',
    kind: 'project',
    source: 'project',
    projectDefault: 'anthropic/claude-sonnet-4.6',
    project_spend: { requests: 2, cost: 1.5 },
    connection: {
      owner_type: 'project',
      authorization_strategy: 'project',
      mode: 'project',
      visibility: 'project',
      sharing: { mode: 'project' },
    },
    untouched: { account_id: 'account-1' },
  });
});

test('toProjectPayload preserves an existing legacy key', () => {
  expect(toProjectPayload({ workspace_id: 'canonical', project_id: 'legacy' })).toEqual({
    project_id: 'legacy',
  });
});

test('Project request compatibility translates entity fields but preserves manifest project blocks', async () => {
  expect(
    toWorkspaceRequestPayload({
      project_id: 'p1',
      owner_type: 'project',
      authorization_strategy: 'project',
      mode: 'project',
      project: { name: 'Manifest project block' },
    }),
  ).toEqual({
    workspace_id: 'p1',
    owner_type: 'workspace',
    authorization_strategy: 'workspace',
    mode: 'workspace',
    project: { name: 'Manifest project block' },
  });

  const app = new Hono();
  app.use('*', projectRequestCompatibility);
  app.post('/', async (c) => c.json(await c.req.json()));
  const response = await app.request('/', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ owner_type: 'project' }),
  });
  expect(await response.json()).toEqual({ owner_type: 'workspace' });
});

test('Project request compatibility translates legacy Project query values', async () => {
  const app = new Hono();
  app.use('*', projectRequestCompatibility);
  app.get('/', (c) => c.json({ scope: c.req.query('scope') }));

  const response = await app.request('/?scope=project');

  expect(await response.json()).toEqual({ scope: 'workspace' });
});

test('projectResponseCompatibility maps JSON and preserves status and headers', async () => {
  const app = new Hono();
  app.use('*', projectResponseCompatibility);
  app.get('/', (c) => c.json({ workspace_id: 'workspace-1' }, 201, { 'x-proof': 'kept' }));

  const response = await app.request('/');

  expect(response.status).toBe(201);
  expect(response.headers.get('x-proof')).toBe('kept');
  expect(await response.json()).toEqual({ project_id: 'workspace-1' });
});

test('projectResponseCompatibility maps canonical Workspace SSE frames', async () => {
  const app = new Hono();
  app.use('*', projectResponseCompatibility);
  app.get('/stream', () =>
    new Response('data: {"type":"done","workspace":{"workspace_id":"workspace-1"}}\n\n', {
      headers: { 'content-type': 'text/event-stream' },
    }),
  );

  const response = await app.request('/stream');
  expect(await response.text()).toBe(
    'data: {"type":"done","project":{"project_id":"workspace-1"}}\n\n',
  );
});

test('projectResponseCompatibility leaves other non-JSON and empty responses unchanged', async () => {
  const app = new Hono();
  app.use('*', projectResponseCompatibility);
  app.get('/stream', (c) => c.text('workspace_id'));
  app.get('/empty', (c) => c.body(null, 204));

  const stream = await app.request('/stream');
  expect(stream.headers.get('content-type') ?? '').not.toContain('application/json');
  expect(await stream.text()).toBe('workspace_id');

  const empty = await app.request('/empty');
  expect(empty.status).toBe(204);
  expect(await empty.text()).toBe('');
});
