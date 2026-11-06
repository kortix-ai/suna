/**
 * The workspace lifecycle and the person's own keys (design.md §3.2 C5):
 * delete, restore and set up a workspace; list and revoke personal keys; the
 * person deletion plan. Plus the error codes a host branches on.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';

import { configureKortix } from '../../http/config';
import { ApiError } from '../../http/api-client';
import {
  WORKSPACE_DELETING_CODE,
  WORKSPACE_HAS_PROJECT_CODE,
  WORKSPACE_NOT_FOUND_CODE,
  WORKSPACE_SETTING_READ_ONLY_CODE,
  WORKSPACE_SETUP_REQUIRED_CODE,
  deleteWorkspace,
  getPersonDeletionPlan,
  inviteWorkspaceMember,
  isWorkspaceHasProjectError,
  listPersonalTokens,
  listWorkspaceMembers,
  restoreWorkspace,
  revokePersonalToken,
  setupWorkspace,
  updateWorkspaceMemberRole,
  type WorkspaceRole,
} from './workspaces';

const WS = '11111111-1111-4111-8111-111111111111';
const ACC = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

type Call = { method: string; url: string; body: unknown };
let calls: Call[] = [];
let answer: (call: Call) => Response = () => Response.json({});

beforeEach(() => {
  calls = [];
  answer = () => Response.json({});
  configureKortix({
    backendUrl: 'http://test.local',
    getToken: async () => 'tok',
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const call = {
        method: init?.method ?? 'GET',
        url: String(input).replace('http://test.local', ''),
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      };
      calls.push(call);
      return answer(call);
    }) as typeof fetch,
  });
});

const servedWorkspace = (extra: Record<string, unknown> = {}) => ({
  project_id: WS,
  workspace_id: WS,
  account_id: ACC,
  name: 'Acme',
  repo_url: '',
  default_branch: 'main',
  manifest_path: 'kortix.yaml',
  status: 'active',
  metadata: {},
  last_opened_at: null,
  created_at: '',
  updated_at: '',
  role: 'owner',
  state: 'active',
  split_pending: false,
  deletion_scheduled_for: null,
  workspace: { workspace_id: WS, account_id: ACC, account_role: 'owner', member_count: 2 },
  ...extra,
});

describe('workspace lifecycle', () => {
  test('deleteWorkspace: DELETE /workspaces/:id answers the deletion result', async () => {
    answer = () =>
      Response.json({ ok: true, deleted: true, archived: true, repo_deleted: false, deletion_scheduled_for: '2026-11-20T00:00:00.000Z' });
    const result = await deleteWorkspace(WS);
    expect(calls).toEqual([{ method: 'DELETE', url: `/workspaces/${WS}`, body: undefined }]);
    expect(result.deletion_scheduled_for).toBe('2026-11-20T00:00:00.000Z');
  });

  test('restoreWorkspace: POST /workspaces/:id/restore answers the Workspace', async () => {
    answer = () => Response.json(servedWorkspace());
    const ws = await restoreWorkspace(WS);
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([`POST /workspaces/${WS}/restore`]);
    expect(ws.state).toBe('active');
    expect(ws.member_count).toBe(2);
  });

  test('setupWorkspace: POST /workspaces/:id/setup with the repository fields answers the Workspace', async () => {
    answer = () => Response.json(servedWorkspace(), { status: 201 });
    const ws = await setupWorkspace(WS, { starter_template: 'general-knowledge-worker' });
    expect(calls).toEqual([
      { method: 'POST', url: `/workspaces/${WS}/setup`, body: { starter_template: 'general-knowledge-worker' } },
    ]);
    expect(ws.workspace_id).toBe(WS);
  });
});

describe('personal keys and the deletion plan', () => {
  test('listPersonalTokens: GET /me/tokens; revokePersonalToken: DELETE /me/tokens/:id', async () => {
    answer = (call) =>
      call.method === 'GET'
        ? Response.json([{ token_id: 't1', name: 'cli', project_id: null, workspace_id: null, status: 'active' }])
        : Response.json({ ok: true });
    const tokens = await listPersonalTokens();
    await revokePersonalToken('t/1');
    expect(tokens.map((t) => t.token_id)).toEqual(['t1']);
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual(['GET /me/tokens', 'DELETE /me/tokens/t%2F1']);
  });

  test('getPersonDeletionPlan: GET /account/deletion-plan', async () => {
    answer = () =>
      Response.json({ delete_workspaces: [WS], leave_workspaces: [], blockers: [{ workspace_id: WS, name: 'Acme', member_count: 3 }] });
    const plan = await getPersonDeletionPlan();
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual(['GET /account/deletion-plan']);
    expect(plan.blockers[0]).toEqual({ workspace_id: WS, name: 'Acme', member_count: 3 });
  });

  test('getPersonDeletionPlan: the plan names every listed workspace (workspace_names)', async () => {
    answer = () =>
      Response.json({ delete_workspaces: [WS], leave_workspaces: [], blockers: [], workspace_names: { [WS]: 'Acme' } });
    const plan = await getPersonDeletionPlan();
    const names: Record<string, string> | undefined = plan.workspace_names;
    expect(names).toEqual({ [WS]: 'Acme' });
  });
});

describe('a member row carries its ladder role', () => {
  test('listWorkspaceMembers: role is the served workspace role', async () => {
    answer = () =>
      Response.json([{ user_id: 'u1', email: null, role: 'manager', account_role: 'member', joined_at: '2026-01-01T00:00:00Z' }]);
    const [member] = await listWorkspaceMembers(WS);
    const role: WorkspaceRole | undefined = member!.role;
    expect(role).toBe('manager');
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([`GET /workspaces/${WS}/members`]);
  });
});

describe('members take the workspace role ladder', () => {
  test('invite with a workspace role, and change a role', async () => {
    answer = () => Response.json({ status: 'added', user_id: 'u1' });
    await inviteWorkspaceMember(WS, { email: 'person@example.invalid', role: 'manager' });
    await updateWorkspaceMemberRole(WS, 'u1', 'manager');
    expect(calls.map((c) => c.body)).toEqual([{ email: 'person@example.invalid', role: 'manager' }, { role: 'manager' }]);
  });
});

describe('workspace error codes', () => {
  test('the codes are the API strings', () => {
    expect(WORKSPACE_HAS_PROJECT_CODE).toBe('workspace_has_project');
    expect(WORKSPACE_NOT_FOUND_CODE).toBe('workspace_not_found');
    expect(WORKSPACE_SETUP_REQUIRED_CODE).toBe('workspace_setup_required');
    expect(WORKSPACE_DELETING_CODE).toBe('workspace_deleting');
    expect(WORKSPACE_SETTING_READ_ONLY_CODE).toBe('workspace_setting_read_only');
  });

  test('isWorkspaceHasProjectError reads the code of an ApiError or a plain body', () => {
    expect(isWorkspaceHasProjectError(new ApiError('taken', { status: 409, code: 'workspace_has_project' }))).toBe(true);
    expect(isWorkspaceHasProjectError({ code: 'workspace_has_project', workspace_id: WS })).toBe(true);
    expect(isWorkspaceHasProjectError(new ApiError('other', { status: 409, code: 'no_workspace' }))).toBe(false);
    expect(isWorkspaceHasProjectError(null)).toBe(false);
  });
});
