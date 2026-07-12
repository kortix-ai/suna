import { test, expect, beforeEach, mock } from 'bun:test';
import * as realAuth from '../../http/auth';
import type { SandboxInfo } from './types';

// This file must be hermetic against process-wide `mock.module('../../http/auth', ...)`
// (equivalently `'../platform/auth'` from other directories — same resolved
// file) registrations made by OTHER test files (see the identical comment in
// `./shared.test.ts` / `./invites.test.ts` — bun's `mock.module` is
// process-wide/permanent for the whole `bun test` sweep, and several other
// suites register one). `members.ts`'s real functional helpers
// (`fetchKortixMaster`) call `authenticatedFetch` directly, so — unlike a file
// that never touches auth — this one needs its OWN registration (a thin
// passthrough to `globalThis.fetch` this file fully controls) instead of
// depending on whichever OTHER file's registration happens to be resident.
// Import `./members` via `await import(...)` so it resolves against THIS mock
// regardless of load order.
mock.module('../../http/auth', () => ({
  ...realAuth,
  authenticatedFetch: async (input: RequestInfo | URL, init?: RequestInit) => fetch(input as any, init),
}));

const {
  listSandboxMembers,
  addSandboxMember,
  removeSandboxMember,
  updateSandboxMemberRole,
  updateSandboxMemberSpendCap,
  getViewerSandboxScopes,
  getSandboxMemberScopes,
  updateSandboxMemberScope,
  revokeSandboxInvite,
  listSandboxProjectMembers,
  grantSandboxProjectAccess,
  revokeSandboxProjectAccess,
} = await import('./members');
type SandboxProjectMembersResponse = Awaited<ReturnType<typeof listSandboxProjectMembers>>;
const { configureKortix } = await import('../../http/config');

configureKortix({ backendUrl: 'http://backend.local/v1', getToken: async () => 'tok' });

let calls: { url: string; method: string; body: unknown }[] = [];
let nextStatus = 200;
let nextBodyText = '{}';

beforeEach(() => {
  delete process.env.BACKEND_URL;
  calls = [];
  nextStatus = 200;
  nextBodyText = '{}';
  globalThis.fetch = mock(async (url: unknown, opts: RequestInit = {}) => {
    calls.push({
      url: String(url),
      method: opts.method ?? 'GET',
      body: typeof opts.body === 'string' ? JSON.parse(opts.body) : undefined,
    });
    return new Response(nextBodyText, {
      status: nextStatus,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
});

const last = () => calls[calls.length - 1];

const sandbox: SandboxInfo = {
  sandbox_id: 'sbx-1',
  external_id: 'ext-123',
  name: 'Test Sandbox',
  provider: 'daytona',
  base_url: '',
  status: 'active',
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
};

// ─── Deliberate stubs — every one of these always rejects, regardless of input ──

test('listSandboxMembers always rejects — moved to project access', async () => {
  await expect(listSandboxMembers('sbx-1')).rejects.toThrow(
    'Sandbox members moved to project access; use project members for project-session sandboxes',
  );
});

test('addSandboxMember always rejects — invite to project instead', async () => {
  await expect(addSandboxMember('sbx-1', 'a@b.com', 'member')).rejects.toThrow(
    'Sandbox members moved to project access; invite the user to the project instead',
  );
});

test('removeSandboxMember always rejects — update project access instead', async () => {
  await expect(removeSandboxMember('sbx-1', 'user-1')).rejects.toThrow(
    'Sandbox members moved to project access; update project access instead',
  );
});

test('updateSandboxMemberRole always rejects — update project access instead', async () => {
  await expect(updateSandboxMemberRole('sbx-1', 'user-1', 'admin')).rejects.toThrow(
    'Sandbox members moved to project access; update project access instead',
  );
});

test('updateSandboxMemberSpendCap always rejects — not exposed for project-session sandboxes', async () => {
  await expect(updateSandboxMemberSpendCap('sbx-1', 'user-1', 5000)).rejects.toThrow(
    'Sandbox member spend caps are not exposed for project-session sandboxes',
  );
});

test('getViewerSandboxScopes always rejects — moved to project access', async () => {
  await expect(getViewerSandboxScopes('sbx-1')).rejects.toThrow(
    'Sandbox scopes moved to project access for project-session sandboxes',
  );
});

test('getSandboxMemberScopes always rejects — moved to project access', async () => {
  await expect(getSandboxMemberScopes('sbx-1', 'user-1')).rejects.toThrow(
    'Sandbox scopes moved to project access for project-session sandboxes',
  );
});

test('updateSandboxMemberScope always rejects — moved to project access', async () => {
  await expect(updateSandboxMemberScope('sbx-1', 'user-1', 'files.read', 'grant')).rejects.toThrow(
    'Sandbox scopes moved to project access for project-session sandboxes',
  );
});

test('revokeSandboxInvite always rejects — moved to project access', async () => {
  await expect(revokeSandboxInvite('sbx-1', 'invite-1')).rejects.toThrow(
    'Sandbox invites moved to project access for project-session sandboxes',
  );
  // Stubs must not hit the network — they throw synchronously up front.
  expect(calls.length).toBe(0);
});

// ─── Real functional ACL helpers — go through fetchKortixMaster ─────────────

test('listSandboxProjectMembers GETs the kortix-master project members route through the sandbox proxy', async () => {
  const body: SandboxProjectMembersResponse = {
    project_id: 'proj-1',
    members: [{ user_id: 'u1', role: 'owner', added_by: null, added_at: '2026-01-01T00:00:00Z' }],
  };
  nextBodyText = JSON.stringify(body);
  nextStatus = 200;

  const result = await listSandboxProjectMembers(sandbox, 'proj-1');

  expect(last().url).toBe('http://backend.local/v1/p/ext-123/8000/kortix/projects/proj-1/members');
  expect(last().method).toBe('GET');
  expect(result).toEqual(body);
});

test('grantSandboxProjectAccess POSTs user_id + role, defaulting role to member', async () => {
  nextBodyText = '{}';
  nextStatus = 200;

  await grantSandboxProjectAccess(sandbox, 'proj-1', 'user-9');

  expect(last().url).toBe('http://backend.local/v1/p/ext-123/8000/kortix/projects/proj-1/members');
  expect(last().method).toBe('POST');
  expect(last().body).toEqual({ user_id: 'user-9', role: 'member' });
});

test('grantSandboxProjectAccess honors an explicit admin role', async () => {
  nextBodyText = '{}';
  nextStatus = 200;

  await grantSandboxProjectAccess(sandbox, 'proj-1', 'user-9', 'admin');

  expect(last().body).toEqual({ user_id: 'user-9', role: 'admin' });
});

test('revokeSandboxProjectAccess DELETEs the specific member route', async () => {
  nextBodyText = '{}';
  nextStatus = 200;

  await revokeSandboxProjectAccess(sandbox, 'proj-1', 'user-9');

  expect(last().url).toBe('http://backend.local/v1/p/ext-123/8000/kortix/projects/proj-1/members/user-9');
  expect(last().method).toBe('DELETE');
});

test('fetchKortixMaster throws the response body text on a non-ok response', async () => {
  nextStatus = 404;
  nextBodyText = 'Project not found';

  await expect(listSandboxProjectMembers(sandbox, 'proj-1')).rejects.toThrow('Project not found');
});

test('fetchKortixMaster falls back to "Request failed (status)" when the error body is empty', async () => {
  nextStatus = 500;
  nextBodyText = '';

  await expect(revokeSandboxProjectAccess(sandbox, 'proj-1', 'user-9')).rejects.toThrow('Request failed (500)');
});

test('URL-encodes projectId and userId with special characters', async () => {
  nextBodyText = '{}';
  nextStatus = 200;

  await grantSandboxProjectAccess(sandbox, 'proj/one two', 'user id&1');

  expect(last().url).toBe(
    `http://backend.local/v1/p/ext-123/8000/kortix/projects/${encodeURIComponent('proj/one two')}/members`,
  );
  expect(last().body).toEqual({ user_id: 'user id&1', role: 'member' });

  await revokeSandboxProjectAccess(sandbox, 'proj/one two', 'user id&1');
  expect(last().url).toBe(
    `http://backend.local/v1/p/ext-123/8000/kortix/projects/${encodeURIComponent('proj/one two')}/members/${encodeURIComponent('user id&1')}`,
  );
});
