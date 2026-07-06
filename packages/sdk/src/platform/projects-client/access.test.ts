import { beforeEach, expect, mock, test } from 'bun:test';
import { configureKortix } from '../config';
import {
  approveProjectAccessRequest,
  attachGroupToProject,
  createProjectResourceGrant,
  deleteProjectResourceGrant,
  detachGroupFromProject,
  inviteProjectMember,
  isInviteSent,
  listPendingApprovals,
  listPendingProjectInvites,
  listProjectAccess,
  listProjectAccessRequests,
  listProjectGroupGrants,
  listProjectResourceGrants,
  listSessionsNeedingInput,
  rejectProjectAccessRequest,
  requestProjectAccess,
  resendPendingProjectInvite,
  resolveApproval,
  revokePendingProjectInvite,
  revokeProjectAccess,
  updateProjectAccess,
  updateProjectGroupGrant,
  type ProjectAccessMember,
} from './access';

let calls: { url: string; method: string; body: unknown }[] = [];
let nextResponse: { status: number; body: unknown } = { status: 200, body: {} };

beforeEach(() => {
  calls = [];
  nextResponse = { status: 200, body: {} };
  globalThis.fetch = mock(async (url: unknown, opts: { method?: string; body?: string } = {}) => {
    calls.push({
      url: String(url),
      method: opts.method ?? 'GET',
      body: opts.body ? JSON.parse(opts.body) : undefined,
    });
    return new Response(JSON.stringify(nextResponse.body), {
      status: nextResponse.status,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
});

configureKortix({ backendUrl: 'http://test.local', getToken: async () => 'tok' });
const last = () => calls[calls.length - 1];

// ── isInviteSent: pure type guard, no fetch ─────────────────────────────────

test('isInviteSent narrows the "invited" shape to true', () => {
  const invited = {
    status: 'invited' as const,
    email: 'a@b.com',
    invite_id: 'inv-1',
    project_role: 'member' as const,
    message: 'sent',
    invite_url: 'https://app.example.com/invite/inv-1',
    email_sent: true,
    email_skip_reason: null,
  };
  expect(isInviteSent(invited)).toBe(true);
});

test('isInviteSent returns false for a plain ProjectAccessMember shape', () => {
  const member: ProjectAccessMember = {
    user_id: 'u1',
    email: 'a@b.com',
    account_role: 'member',
    project_role: 'editor',
    effective_project_role: 'editor',
    has_implicit_access: false,
    joined_at: '2026-01-01',
    granted_by: null,
    granted_at: '2026-01-01',
    updated_at: null,
  };
  expect(isInviteSent(member)).toBe(false);
});

// ── access requests ──────────────────────────────────────────────────────────

test('requestProjectAccess POSTs a trimmed message to access-requests', async () => {
  nextResponse = {
    status: 200,
    body: {
      status: 'created',
      request: { request_id: 'r1', status: 'pending' },
    },
  };
  await requestProjectAccess('P1', '  please add me  ');
  expect(last().url).toContain('/projects/P1/access-requests');
  expect(last().method).toBe('POST');
  expect(last().body).toEqual({ message: 'please add me' });
});

test('requestProjectAccess omits message entirely when only whitespace is given', async () => {
  nextResponse = { status: 200, body: { status: 'created', request: {} } };
  await requestProjectAccess('P1', '   ');
  expect(last().body).toEqual({ message: undefined });
});

test('listProjectAccessRequests GETs the access-requests list', async () => {
  nextResponse = { status: 200, body: { requests: [] } };
  const result = await listProjectAccessRequests('P1');
  expect(last().url).toContain('/projects/P1/access-requests');
  expect(last().method).toBe('GET');
  expect(result).toEqual({ requests: [] });
});

test('listProjectAccess throws on a failed response', async () => {
  nextResponse = { status: 500, body: { message: 'boom' } };
  await expect(listProjectAccess('P1')).rejects.toBeTruthy();
});

test('approveProjectAccessRequest defaults role to "member" and POSTs to /approve', async () => {
  nextResponse = { status: 200, body: { request: { request_id: 'r1' }, member: { user_id: 'u1' } } };
  await approveProjectAccessRequest('P1', 'r1');
  expect(last().url).toContain('/projects/P1/access-requests/r1/approve');
  expect(last().method).toBe('POST');
  expect(last().body).toEqual({ role: 'member' });
});

test('approveProjectAccessRequest forwards an explicit role', async () => {
  nextResponse = { status: 200, body: { request: { request_id: 'r1' }, member: { user_id: 'u1' } } };
  await approveProjectAccessRequest('P1', 'r1', 'editor');
  expect(last().body).toEqual({ role: 'editor' });
});

test('rejectProjectAccessRequest POSTs an empty body to /reject', async () => {
  nextResponse = { status: 200, body: { request: { request_id: 'r1' } } };
  await rejectProjectAccessRequest('P1', 'r1');
  expect(last().url).toContain('/projects/P1/access-requests/r1/reject');
  expect(last().method).toBe('POST');
  expect(last().body).toEqual({});
});

// ── direct member access ────────────────────────────────────────────────────

test('listProjectAccess GETs the project access roster', async () => {
  nextResponse = {
    status: 200,
    body: { project_id: 'P1', account_id: 'A1', can_manage: true, viewer_user_id: 'u1', members: [] },
  };
  const result = await listProjectAccess('P1');
  expect(last().url).toContain('/projects/P1/access');
  expect(last().method).toBe('GET');
  expect(result.can_manage).toBe(true);
});

test('updateProjectAccess PUTs { role } to /access/:userId', async () => {
  nextResponse = { status: 200, body: { user_id: 'u1', project_role: 'editor' } };
  await updateProjectAccess('P1', 'u1', 'editor');
  expect(last().url).toContain('/projects/P1/access/u1');
  expect(last().method).toBe('PUT');
  expect(last().body).toEqual({ role: 'editor' });
});

test('revokeProjectAccess DELETEs /access/:userId', async () => {
  nextResponse = { status: 200, body: { ok: true } };
  await revokeProjectAccess('P1', 'u1');
  expect(last().url).toContain('/projects/P1/access/u1');
  expect(last().method).toBe('DELETE');
});

test('inviteProjectMember POSTs { email, role } to /access/invite', async () => {
  nextResponse = {
    status: 200,
    body: {
      status: 'invited',
      email: 'new@user.com',
      invite_id: 'inv-1',
      project_role: 'member',
      message: 'invited',
      invite_url: 'https://app.example.com/invite/inv-1',
      email_sent: true,
      email_skip_reason: null,
    },
  };
  const result = await inviteProjectMember('P1', 'new@user.com', 'member');
  expect(last().url).toContain('/projects/P1/access/invite');
  expect(last().method).toBe('POST');
  expect(last().body).toEqual({ email: 'new@user.com', role: 'member' });
  expect(isInviteSent(result)).toBe(true);
});

// ── pending project invites ─────────────────────────────────────────────────

test('listPendingProjectInvites GETs the pending-invites list', async () => {
  nextResponse = { status: 200, body: { pending: [] } };
  const result = await listPendingProjectInvites('P1');
  expect(last().url).toContain('/projects/P1/access/pending-invites');
  expect(last().method).toBe('GET');
  expect(result).toEqual({ pending: [] });
});

test('revokePendingProjectInvite DELETEs a pending invite by id', async () => {
  nextResponse = { status: 200, body: { ok: true, invitation_cancelled: true } };
  const result = await revokePendingProjectInvite('P1', 'inv-1');
  expect(last().url).toContain('/projects/P1/access/pending-invites/inv-1');
  expect(last().method).toBe('DELETE');
  expect(result.invitation_cancelled).toBe(true);
});

test('resendPendingProjectInvite POSTs to the resend endpoint', async () => {
  nextResponse = {
    status: 200,
    body: { ok: true, expires_at: '2026-02-01', invite_url: 'https://x', email_sent: true, email_skip_reason: null },
  };
  const result = await resendPendingProjectInvite('P1', 'inv-1');
  expect(last().url).toContain('/projects/P1/access/pending-invites/inv-1/resend');
  expect(last().method).toBe('POST');
  expect(result.ok).toBe(true);
});

// ── group grants (undefined vs null vs string expiresAt branches) ──────────

test('listProjectGroupGrants GETs the group-grants list', async () => {
  nextResponse = { status: 200, body: { grants: [] } };
  const result = await listProjectGroupGrants('P1');
  expect(last().url).toContain('/projects/P1/group-grants');
  expect(last().method).toBe('GET');
  expect(result).toEqual({ grants: [] });
});

test('attachGroupToProject omits expires_at entirely when expiresAt is undefined', async () => {
  nextResponse = { status: 200, body: { project_id: 'P1', group_id: 'g1', role: 'member' } };
  await attachGroupToProject('P1', 'g1', 'member');
  expect(last().url).toContain('/projects/P1/group-grants');
  expect(last().method).toBe('POST');
  expect(last().body).toEqual({ group_id: 'g1', role: 'member' });
});

test('attachGroupToProject sends expires_at: null to explicitly clear expiry', async () => {
  nextResponse = { status: 200, body: { project_id: 'P1', group_id: 'g1', role: 'member' } };
  await attachGroupToProject('P1', 'g1', 'member', null);
  expect(last().body).toEqual({ group_id: 'g1', role: 'member', expires_at: null });
});

test('attachGroupToProject sends a real expires_at string when given', async () => {
  nextResponse = { status: 200, body: { project_id: 'P1', group_id: 'g1', role: 'member' } };
  await attachGroupToProject('P1', 'g1', 'member', '2026-12-31T00:00:00Z');
  expect(last().body).toEqual({ group_id: 'g1', role: 'member', expires_at: '2026-12-31T00:00:00Z' });
});

test('updateProjectGroupGrant PATCHes with { role } only when expiresAt is undefined', async () => {
  nextResponse = { status: 200, body: { project_id: 'P1', group_id: 'g1', role: 'editor' } };
  await updateProjectGroupGrant('P1', 'g1', 'editor');
  expect(last().url).toContain('/projects/P1/group-grants/g1');
  expect(last().method).toBe('PATCH');
  expect(last().body).toEqual({ role: 'editor' });
});

test('updateProjectGroupGrant PATCHes with expires_at: null to clear expiry', async () => {
  nextResponse = { status: 200, body: { project_id: 'P1', group_id: 'g1', role: 'editor' } };
  await updateProjectGroupGrant('P1', 'g1', 'editor', null);
  expect(last().body).toEqual({ role: 'editor', expires_at: null });
});

test('updateProjectGroupGrant PATCHes with a real expires_at string when given', async () => {
  nextResponse = { status: 200, body: { project_id: 'P1', group_id: 'g1', role: 'editor' } };
  await updateProjectGroupGrant('P1', 'g1', 'editor', '2026-12-31T00:00:00Z');
  expect(last().body).toEqual({ role: 'editor', expires_at: '2026-12-31T00:00:00Z' });
});

test('detachGroupFromProject DELETEs /group-grants/:groupId', async () => {
  nextResponse = { status: 200, body: { ok: true } };
  await detachGroupFromProject('P1', 'g1');
  expect(last().url).toContain('/projects/P1/group-grants/g1');
  expect(last().method).toBe('DELETE');
});

// ── per-resource (agent/skill/secret) grants ────────────────────────────────

test('listProjectResourceGrants GETs the resource-grants list', async () => {
  nextResponse = {
    status: 200,
    body: { resources: { agents: [], skills: [], secrets: [] }, grants: [] },
  };
  const result = await listProjectResourceGrants('P1');
  expect(last().url).toContain('/projects/P1/resource-grants');
  expect(last().method).toBe('GET');
  expect(result.grants).toEqual([]);
});

test('createProjectResourceGrant POSTs snake_case fields, omitting expires_at when not given', async () => {
  nextResponse = { status: 200, body: { grant_id: 'gr1' } };
  await createProjectResourceGrant('P1', {
    resourceType: 'agent',
    resourceId: 'researcher',
    principalType: 'member',
    principalId: 'u1',
  });
  expect(last().url).toContain('/projects/P1/resource-grants');
  expect(last().method).toBe('POST');
  expect(last().body).toEqual({
    resource_type: 'agent',
    resource_id: 'researcher',
    principal_type: 'member',
    principal_id: 'u1',
  });
});

test('createProjectResourceGrant includes expires_at when explicitly given (including null)', async () => {
  nextResponse = { status: 200, body: { grant_id: 'gr2' } };
  await createProjectResourceGrant('P1', {
    resourceType: 'skill',
    resourceId: 'deploy',
    principalType: 'group',
    principalId: 'g1',
    expiresAt: '2026-12-31T00:00:00Z',
  });
  expect(last().body).toEqual({
    resource_type: 'skill',
    resource_id: 'deploy',
    principal_type: 'group',
    principal_id: 'g1',
    expires_at: '2026-12-31T00:00:00Z',
  });

  await createProjectResourceGrant('P1', {
    resourceType: 'secret',
    resourceId: 'api_key',
    principalType: 'member',
    principalId: 'u2',
    expiresAt: null,
  });
  expect(last().body).toEqual({
    resource_type: 'secret',
    resource_id: 'api_key',
    principal_type: 'member',
    principal_id: 'u2',
    expires_at: null,
  });
});

test('deleteProjectResourceGrant DELETEs /resource-grants/:grantId', async () => {
  nextResponse = { status: 200, body: { ok: true } };
  await deleteProjectResourceGrant('P1', 'gr1');
  expect(last().url).toContain('/projects/P1/resource-grants/gr1');
  expect(last().method).toBe('DELETE');
});

// ── approvals inbox ──────────────────────────────────────────────────────────

test('listPendingApprovals GETs the approvals inbox', async () => {
  nextResponse = { status: 200, body: { count: 1, approvals: [] } };
  const result = await listPendingApprovals('P1');
  expect(last().url).toContain('/projects/P1/approvals');
  expect(last().method).toBe('GET');
  expect(result.count).toBe(1);
});

test('listSessionsNeedingInput GETs the needs-input summary', async () => {
  nextResponse = { status: 200, body: { total: 2, sessions: { 's1': 2 } } };
  const result = await listSessionsNeedingInput('P1');
  expect(last().url).toContain('/projects/P1/approvals/needs-input');
  expect(last().method).toBe('GET');
  expect(result.total).toBe(2);
});

test('resolveApproval defaults scope to "once" and POSTs { decision, scope }', async () => {
  nextResponse = { status: 200, body: { ok: true, scope: 'once' } };
  await resolveApproval('P1', 'ex1', 'approve');
  expect(last().url).toContain('/projects/P1/approvals/ex1');
  expect(last().method).toBe('POST');
  expect(last().body).toEqual({ decision: 'approve', scope: 'once' });
});

test('resolveApproval forwards an explicit "session" scope', async () => {
  nextResponse = { status: 200, body: { ok: true, scope: 'session' } };
  await resolveApproval('P1', 'ex1', 'deny', 'session');
  expect(last().body).toEqual({ decision: 'deny', scope: 'session' });
});
