import { beforeEach, describe, expect, mock, test } from 'bun:test';
import * as P from '../rest/projects-client';
import { createKortix, type WorkspaceHandle } from './kortix';

// Synthetic ids: the workspace id and its account id always differ.
const WS = '11111111-1111-4111-8111-111111111111';
const ACC = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

let calls: { url: string; method: string; body?: unknown }[] = [];
beforeEach(() => {
  calls = [];
  globalThis.fetch = mock(async (url: unknown, opts: { method?: string; body?: unknown } = {}) => {
    const path = String(url).replace('http://test.local', '');
    const method = opts.method ?? 'GET';
    calls.push({ url: path, method, body: typeof opts.body === 'string' ? JSON.parse(opts.body) : undefined });
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    if (path === `/workspaces/${WS}`) {
      return json({
        project_id: WS,
        account_id: ACC,
        name: 'ws',
        repo_url: '',
        default_branch: 'main',
        manifest_path: 'kortix.yaml',
        status: 'active',
        metadata: {},
        last_opened_at: null,
        created_at: '',
        updated_at: '',
        workspace: { workspace_id: WS, account_id: ACC, account_role: 'owner', member_count: 1 },
      });
    }
    if (path === '/accounts') return json([]);
    return json([]);
  }) as unknown as typeof fetch;
});

const kortix = createKortix({ backendUrl: 'http://test.local', getToken: async () => 'tok' });

describe('kortix.workspaces', () => {
  test('list/get/update/create are the platform functions, by reference', () => {
    expect(kortix.workspaces.list).toBe(P.listWorkspaces);
    expect(kortix.workspaces.get).toBe(P.getWorkspace);
    expect(kortix.workspaces.update).toBe(P.updateWorkspace);
    expect(kortix.workspaces.create).toBe(P.createWorkspace);
  });
});

describe('kortix.workspace(id)', () => {
  test('get() returns the workspace with its role', async () => {
    const ws = await kortix.workspace(WS).get();
    expect(ws.workspace_id).toBe(WS);
    expect(ws.role).toBe('owner');
  });

  test('carries the whole project handle: sessions, secrets, connectors', () => {
    const handle: WorkspaceHandle = kortix.workspace(WS);
    const project = kortix.project(WS);
    for (const key of Object.keys(project)) {
      expect(key in handle).toBe(true);
    }
    expect(handle.id).toBe(WS);
  });

  test('members, billing, tokens and IAM call the workspace routes, one request each', async () => {
    const ws = kortix.workspace(WS);
    await ws.members.list();
    await ws.billing.state();
    await ws.tokens.list();
    await ws.iam.assignments.list();
    expect(calls.map((c) => c.url)).toEqual([
      `/workspaces/${WS}/members`,
      `/billing/account-state?account_id=${WS}`,
      `/workspaces/${WS}/tokens`,
      `/workspaces/${WS}/iam/assignments`,
    ]);
  });

  test('update() PATCHes the workspace', async () => {
    await kortix.workspace(WS).update({ name: 'New' }).catch(() => undefined);
    expect(calls.at(-1)).toMatchObject({ method: 'PATCH', url: `/workspaces/${WS}`, body: { name: 'New' } });
  });
});
