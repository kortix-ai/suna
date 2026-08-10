import { expect, test } from 'bun:test';
import * as master from './kortix-master';
import type { KortixWorkspace as PlatformWorkspace } from '../rest/workspaces-client/workspaces';

test('the daemon project is exported as KortixMasterProject', () => {
  const project: master.KortixMasterProject = {
    id: 'p1',
    name: 'demo',
    path: '/work/demo',
    description: '',
    created_at: '2026-07-10T00:00:00Z',
    opencode_id: null,
  };
  expect(project.id).toBe('p1');
});

test('the deprecated KortixProject alias still resolves to the daemon shape', () => {
  // Back-compat: `@kortix/sdk/opencode-client` consumers keep compiling.
  const legacy: master.KortixProject = {
    id: 'p1',
    name: 'demo',
    path: '/work/demo',
    description: '',
    created_at: '2026-07-10T00:00:00Z',
    opencode_id: null,
  };
  expect(legacy.path).toBe('/work/demo');
});

test('the platform workspace is a different shape from the daemon project', () => {
  const platform: PlatformWorkspace = {
    workspace_id: 'ws_1',
    account_id: 'acct_1',
    name: 'demo',
    repo_url: 'https://example.test/r.git',
    default_branch: 'main',
    manifest_path: 'kortix.yaml',
    status: 'active',
    metadata: {},
    last_opened_at: null,
    created_at: '2026-07-10T00:00:00Z',
    updated_at: '2026-07-10T00:00:00Z',
  };
  expect(platform.workspace_id).toBe('ws_1');
});
