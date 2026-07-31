import { expect, test } from 'bun:test';
import { sessionCreatedAuditEvent } from './session-audit';

test('sessionCreatedAuditEvent attributes an in-session caller as an agent', () => {
  expect(
    sessionCreatedAuditEvent({
      accountId: 'account-1',
      projectId: 'project-1',
      sessionId: 'session-1',
      actorUserId: 'actor-1',
      requestingPrincipalType: 'human',
      inSession: true,
      origin: 'user',
      invocationSource: 'cli',
      agentName: 'default',
      visibility: 'private',
      sandboxProvider: 'daytona',
      connectorBindingCount: 2,
      secretAllowlistCount: 1,
    }),
  ).toMatchObject({
    accountId: 'account-1',
    projectId: 'project-1',
    sessionId: 'session-1',
    actorUserId: 'actor-1',
    actorType: 'agent',
    source: 'cli',
    outcome: 'success',
    action: 'session.created',
    resourceType: 'project_session',
    resourceId: 'session-1',
    metadata: {
      origin: 'user',
      agent_name: 'default',
      visibility: 'private',
      sandbox_provider: 'daytona',
      connector_binding_count: 2,
      secret_allowlist_count: 1,
    },
  });
});

test('sessionCreatedAuditEvent preserves channel and service-account attribution', () => {
  expect(
    sessionCreatedAuditEvent({
      accountId: 'account-1',
      projectId: 'project-1',
      sessionId: 'session-1',
      actorUserId: 'service-1',
      requestingPrincipalType: 'service_account',
      inSession: false,
      origin: 'backend',
      invocationSource: 'slack',
      agentName: 'support',
      visibility: 'project',
      sandboxProvider: 'e2b',
      connectorBindingCount: 0,
      secretAllowlistCount: 0,
    }),
  ).toMatchObject({
    actorType: 'service_account',
    source: 'slack',
  });
});
