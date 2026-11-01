import { describe, expect, test } from 'bun:test';

import type { AuditEvent, SessionAuditAction } from '@kortix/sdk';

import { actionRow, buildRows, eventRow, filterRows } from './rows.ts';

function event(over: Partial<AuditEvent>): AuditEvent {
  return {
    event_id: 'e1',
    occurred_at: '2026-09-17T10:00:00.000Z',
    project_id: 'p',
    session_id: 's',
    actor_user_id: null,
    actor_type: 'agent',
    agent_name: 'kortix',
    source: null,
    outcome: 'success',
    action: 'tool.call',
    resource_type: null,
    resource_id: null,
    http_status: null,
    duration_ms: 12,
    request_id: null,
    trace_id: null,
    correlation_id: null,
    before: null,
    after: null,
    ip: null,
    user_agent: null,
    metadata: null,
    ...over,
  } as AuditEvent;
}

function action(over: Partial<SessionAuditAction>): SessionAuditAction {
  return {
    execution_id: 'x1',
    action: 'send_email',
    connector: 'gmail',
    connector_id: 'c1',
    status: 'pending_approval',
    risk: 'write',
    acted_by: null,
    acted_by_email: null,
    resolved_by: null,
    resolved_by_email: null,
    result_summary: { args_preview: { to: 'a@example.com' } },
    at: '2026-09-17T11:00:00.000Z',
    resolved_at: null,
    can_resolve: true,
    ...over,
  };
}

describe('eventRow', () => {
  test('names the agent, keeps the outcome, lists the detail fields', () => {
    const row = eventRow(event({ http_status: 200, resource_type: 'file', resource_id: 'f1' }));
    expect(row).toMatchObject({
      actor: 'kortix',
      actorKind: 'agent',
      action: 'tool.call',
      outcome: 'success',
    });
    expect(row.fields).toContainEqual(['Duration', '12 ms']);
    expect(row.fields).toContainEqual(['Resource', 'file f1']);
    expect(row.pending).toBeNull();
  });

  test('a person with no agent name reads "person"; a missing outcome reads a dash', () => {
    const row = eventRow(event({ actor_type: 'human', agent_name: null, outcome: null }));
    expect([row.actor, row.actorKind, row.outcome]).toEqual(['person', 'person', '—']);
  });
});

describe('actionRow', () => {
  test('a pending action carries the execution id and the resolve verdict', () => {
    const row = actionRow(action({ resolvers: 'managers' }));
    expect(row).toMatchObject({ action: 'gmail.send_email', outcome: 'pending' });
    expect(row.pending).toEqual({ executionId: 'x1', canResolve: true, resolvers: 'managers' });
    expect(row.fields).toContainEqual(['Arguments', '{"to":"a@example.com"}']);
  });

  test('an older server with no can_resolve cannot be decided from here', () => {
    const row = actionRow(action({ can_resolve: undefined }));
    expect(row.pending?.canResolve).toBe(false);
  });

  test('a resolved action is history, not pending', () => {
    const row = actionRow(action({ status: 'ok', resolved_at: '2026-09-17T11:05:00.000Z' }));
    expect(row.pending).toBeNull();
    expect(row.outcome).toBe('ok');
  });
});

describe('buildRows / filterRows', () => {
  const events = [
    event({ event_id: 'old', occurred_at: '2026-09-17T08:00:00.000Z' }),
    event({ event_id: 'new', occurred_at: '2026-09-17T12:00:00.000Z', outcome: 'failure' }),
    event({
      event_id: 'ppl',
      occurred_at: '2026-09-17T09:00:00.000Z',
      actor_type: 'human',
      agent_name: null,
    }),
  ];

  test('pending first, then events newest first', () => {
    const rows = buildRows([action({})], events);
    expect(rows.map((row) => row.id)).toEqual(['action:x1', 'event:new', 'event:ppl', 'event:old']);
  });

  test('with no events the settled actions stand in for the timeline', () => {
    const rows = buildRows(
      [action({}), action({ execution_id: 'x2', status: 'denied', resolved_at: 'z' })],
      [],
    );
    expect(rows.map((row) => row.id)).toEqual(['action:x1', 'action:x2']);
  });

  test('each filter picks its rows', () => {
    const rows = buildRows([action({})], events);
    const ids = (filter: Parameters<typeof filterRows>[1]) =>
      filterRows(rows, filter).map((r) => r.id);
    expect(ids('approvals')).toEqual(['action:x1']);
    expect(ids('person')).toEqual(['event:ppl']);
    expect(ids('failed')).toEqual(['event:new']);
    expect(ids('agent')).toEqual(['action:x1', 'event:new', 'event:old']);
    expect(ids('all')).toHaveLength(4);
  });
});
