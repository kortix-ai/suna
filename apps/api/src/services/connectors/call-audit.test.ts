import { expect, test } from 'bun:test';
import { approvalResolvedAuditEvent, executionAuditEvent } from './call-audit';

test('executionAuditEvent maps an agent connector failure into the central envelope', () => {
  expect(
    executionAuditEvent(
      {
        accountId: 'account-1',
        projectId: 'project-1',
        connectorId: 'connector-1',
        connectionId: 'connection-1',
        actionPath: 'gmail.send_email',
        actingUserId: 'actor-1',
        sessionId: 'session-1',
        status: 'error',
        risk: 'write',
        resultSummary: { reason: 'upstream_500' },
      },
      'execution-1',
    ),
  ).toEqual({
    accountId: 'account-1',
    projectId: 'project-1',
    sessionId: 'session-1',
    actorUserId: 'actor-1',
    actorType: 'agent',
    source: 'connector',
    outcome: 'failure',
    action: 'connector.gmail.send_email',
    resourceType: 'connector_action',
    resourceId: 'execution-1',
    correlationId: 'execution-1',
    metadata: {
      action_path: 'gmail.send_email',
      connector_id: 'connector-1',
      connection_id: 'connection-1',
      risk: 'write',
      result_summary: { reason: 'upstream_500' },
    },
  });
});

test('executionAuditEvent maps approval states without a session', () => {
  const event = executionAuditEvent(
    {
      accountId: 'account-1',
      projectId: 'project-1',
      connectorId: null,
      connectionId: null,
      actionPath: 'http.request',
      actingUserId: 'actor-1',
      sessionId: null,
      status: 'pending_approval',
      risk: null,
      resultSummary: null,
    },
    'execution-2',
  );
  expect(event.actorType).toBe('human');
  expect(event.outcome).toBe('pending');
});

test('executionAuditEvent redacts the central result summary', () => {
  const event = executionAuditEvent(
    {
      accountId: 'account-1',
      projectId: 'project-1',
      connectorId: 'connector-1',
      connectionId: 'connection-1',
      actionPath: 'http.request',
      actingUserId: 'actor-1',
      sessionId: 'session-1',
      status: 'error',
      risk: 'write',
      resultSummary: {
        reason: 'upstream rejected the request',
        upstream: {
          access_token: 'secret-access-token',
        },
      },
    },
    'execution-3',
  );

  expect(event.metadata?.result_summary).toEqual({
    reason: 'upstream rejected the request',
    upstream: {
      access_token: '[redacted]',
    },
  });
});

test('approvalResolvedAuditEvent attributes the human decision to the execution', () => {
  expect(
    approvalResolvedAuditEvent({
      accountId: 'account-1',
      projectId: 'project-1',
      sessionId: 'session-1',
      executionId: 'execution-1',
      actorUserId: 'actor-1',
      actionPath: 'gmail.send_email',
      connectorId: 'connector-1',
      decision: 'deny',
      source: 'web',
    }),
  ).toEqual({
    accountId: 'account-1',
    projectId: 'project-1',
    sessionId: 'session-1',
    actorUserId: 'actor-1',
    actorType: 'human',
    source: 'web',
    outcome: 'denied',
    action: 'connector.approval.denied',
    resourceType: 'connector_approval',
    resourceId: 'execution-1',
    correlationId: 'execution-1',
    metadata: {
      action_path: 'gmail.send_email',
      connector_id: 'connector-1',
      decision: 'deny',
    },
  });
});
