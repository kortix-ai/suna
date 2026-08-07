import { beforeEach, expect, mock, test } from 'bun:test';
import { configureKortix } from '../../http/config';
import { exportAccountAudit, listAccountAudit } from './audit';
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
