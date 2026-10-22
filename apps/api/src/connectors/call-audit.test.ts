import { expect, test } from 'bun:test';
import { approvalResolvedAuditEvent } from './call-audit';

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
