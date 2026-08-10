import { beforeEach, expect, mock, test } from 'bun:test';

import { configureKortix } from '../../http/config';
import {
  getWorkspace,
  listWorkspaces,
  provisionWorkspace,
  type KortixWorkspace,
} from './workspaces';

let requestedUrl = '';
let requestedMethod = '';
let nextBody: unknown = [];

beforeEach(() => {
  requestedUrl = '';
  requestedMethod = '';
  nextBody = [];
  globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    requestedUrl = String(input);
    requestedMethod = init?.method ?? 'GET';
    return new Response(JSON.stringify(nextBody), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  configureKortix({
    backendUrl: 'http://backend.test/v1',
    getToken: async () => 'token',
  });
});

test('listWorkspaces calls the canonical workspace collection', async () => {
  const workspace: KortixWorkspace = {
    workspace_id: 'workspace-1',
    account_id: 'account-1',
    name: 'Kortix',
    repo_url: 'https://git.test/kortix.git',
    default_branch: 'main',
    manifest_path: 'kortix.yaml',
    status: 'active',
    metadata: {},
    last_opened_at: null,
    created_at: '2026-07-25T00:00:00.000Z',
    updated_at: '2026-07-25T00:00:00.000Z',
  };
  nextBody = [workspace];

  expect(await listWorkspaces()).toEqual([workspace]);
  expect(requestedUrl).toBe('http://backend.test/v1/workspaces');
  expect(requestedMethod).toBe('GET');
});

test('getWorkspace calls the canonical workspace item route', async () => {
  nextBody = { workspace_id: 'workspace-1' };

  await getWorkspace('workspace-1');

  expect(requestedUrl).toBe('http://backend.test/v1/workspaces/workspace-1');
});

test('provisionWorkspace sends canonical workspace input and output fields', async () => {
  nextBody = {
    workspace_id: 'workspace-1',
    account_id: 'account-1',
    name: 'Kortix',
  };

  const result = await provisionWorkspace({
    account_id: 'account-1',
    name: 'Kortix',
    seed_starter: true,
  });

  expect(result.workspace_id).toBe('workspace-1');
  expect(requestedUrl).toBe('http://backend.test/v1/workspaces/provision');
  expect(requestedMethod).toBe('POST');
});
