import type { AuditActorType, AuditEventInput } from '../../shared/audit';

interface SessionCreatedAuditInput {
  accountId: string;
  projectId: string;
  sessionId: string;
  actorUserId: string;
  requestingPrincipalType: 'human' | 'service_account';
  inSession?: boolean | null;
  origin: string;
  invocationSource?: string | null;
  agentName: string;
  visibility: string;
  sandboxProvider: string;
  connectorBindingCount: number;
  secretAllowlistCount: number;
}

function actorType(input: SessionCreatedAuditInput): AuditActorType {
  if (input.requestingPrincipalType === 'service_account') return 'service_account';
  if (input.inSession) return 'agent';
  if (input.origin === 'trigger' || input.origin === 'schedule' || input.origin === 'system') {
    return 'system';
  }
  return 'human';
}

function source(value?: string | null): string {
  if (!value) return 'api';
  if (value === 'ui') return 'web';
  if (value.startsWith('trigger:')) return 'automation';
  if (value.startsWith('system:')) return 'system';
  return value;
}

export function sessionCreatedAuditEvent(input: SessionCreatedAuditInput): AuditEventInput {
  return {
    accountId: input.accountId,
    projectId: input.projectId,
    sessionId: input.sessionId,
    actorUserId: input.actorUserId,
    actorType: actorType(input),
    source: source(input.invocationSource),
    outcome: 'success',
    action: 'session.created',
    resourceType: 'project_session',
    resourceId: input.sessionId,
    metadata: {
      origin: input.origin,
      invocation_source: input.invocationSource ?? null,
      agent_name: input.agentName,
      visibility: input.visibility,
      sandbox_provider: input.sandboxProvider,
      connector_binding_count: input.connectorBindingCount,
      secret_allowlist_count: input.secretAllowlistCount,
    },
  };
}
