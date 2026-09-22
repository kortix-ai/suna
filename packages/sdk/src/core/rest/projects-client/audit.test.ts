import { beforeEach, expect, mock, test } from 'bun:test';
import { configureKortix } from '../../http/config';
import { exportAccountAudit, listAccountAudit, listProjectAudit } from './audit';
import { listAuditEvents } from './iam';

let calls: Array<{ url: string; method: string }> = [];

beforeEach(() => {
  calls = [];
  configureKortix({
    backendUrl: 'http://test.local',
    getToken: async () => 'tok',
  });
  globalThis.fetch = mock(async (url: unknown, options: RequestInit = {}) => {
    calls.push({ url: String(url), method: options.method ?? 'GET' });
    return new Response(JSON.stringify({ events: [], next_cursor: null }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
});

test('listAccountAudit sends reconstruction filters', async () => {
  await listAccountAudit('account-1', {
    projectId: 'project-1',
    sessionId: 'session-1',
    actorType: 'agent',
    source: 'connector',
    outcome: 'failure',
    requestId: 'request-1',
    correlationId: 'execution-1',
    resourceType: 'connector_action',
    actor: 'actor-1',
    until: '2026-07-31T10:00:00.000Z',
    q: 'gmail',
  });

  const url = new URL(calls[0]!.url);
  expect(Object.fromEntries(url.searchParams)).toEqual({
    project_id: 'project-1',
    session_id: 'session-1',
    actor_type: 'agent',
    source: 'connector',
    outcome: 'failure',
    request_id: 'request-1',
    correlation_id: 'execution-1',
    resource_type: 'connector_action',
    actor: 'actor-1',
    until: '2026-07-31T10:00:00.000Z',
    q: 'gmail',
  });
});

test('exportAccountAudit sends the same reconstruction filters', async () => {
  await exportAccountAudit('account-1', {
    format: 'jsonl',
    projectId: 'project-1',
    sessionId: 'session-1',
    actorType: 'human',
    source: 'web',
    outcome: 'success',
  });

  const url = new URL(calls[0]!.url);
  expect(Object.fromEntries(url.searchParams)).toEqual({
    format: 'jsonl',
    project_id: 'project-1',
    session_id: 'session-1',
    actor_type: 'human',
    source: 'web',
    outcome: 'success',
  });
});

test('listAuditEvents sends project and session reconstruction filters', async () => {
  await listAuditEvents('account-1', {
    project_id: 'project-1',
    session_id: 'session-1',
    actor_type: 'agent',
    source: 'connector',
    outcome: 'success',
  });

  const url = new URL(calls[0]!.url);
  expect(Object.fromEntries(url.searchParams)).toEqual({
    project_id: 'project-1',
    session_id: 'session-1',
    actor_type: 'agent',
    source: 'connector',
    outcome: 'success',
  });
});

test('listProjectAudit uses the canonical project route and forwards phase/cursor filters', async () => {
  await listProjectAudit('project-1', {
    action: 'opencode.tool',
    phase: 'completed',
    cursor: 'cursor-1',
    limit: 100,
  });
  const url = new URL(calls[0]!.url);
  expect(url.pathname).toBe('/projects/project-1/audit');
  expect(Object.fromEntries(url.searchParams)).toEqual({
    action: 'opencode.tool',
    phase: 'completed',
    cursor: 'cursor-1',
    limit: '100',
  });
});

test('AuditEvent exposes the canonical reconstruction envelope', () => {
  const event = {} as import('./audit').AuditEvent;
  const fields: Array<unknown> = [
    event.account_id,
    event.opencode_session_id,
    event.turn_id,
    event.message_id,
    event.tool_call_id,
    event.execution_id,
    event.session_sequence,
    event.agent_id,
    event.authoritative_source,
    event.client_reported_source,
    event.phase,
    event.causation_id,
    event.source_ledger,
    event.input_summary,
    event.input_sha256,
    event.integrity_hash,
  ];
  expect(fields).toHaveLength(16);
});

test('AuditEvent carries on_behalf_of_user_id (agents as principals, spec 2026-09-22 §2)', () => {
  const event: import('./audit').AuditEvent = {
    event_id: 'e1', occurred_at: '2026-09-22T00:00:00.000Z', project_id: null, session_id: 's1',
    actor_user_id: 'u1', actor_type: 'agent', agent_name: 'reader', on_behalf_of_user_id: 'u1',
    initiator_actor_type: 'human', initiator_actor_id: 'u1', source: 'agent', outcome: 'success',
    action: 'GET /v1/projects/:projectId/files', resource_type: 'project', resource_id: null,
    http_status: 200, duration_ms: 1, request_id: null, trace_id: null, correlation_id: null,
    before: null, after: null, ip: null, user_agent: null, metadata: {},
  };
  expect(event.on_behalf_of_user_id).toBe('u1');
});
