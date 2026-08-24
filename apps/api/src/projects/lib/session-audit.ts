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
  clientReportedSource?: string | null;
  callerSessionId?: string | null;
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

function authoritativeSource(input: SessionCreatedAuditInput, actor: AuditActorType): string {
  if (actor === 'service_account') return 'automation';
  if (actor === 'agent') return 'agent';
  const invocation = input.invocationSource ?? '';
  if (invocation.startsWith('trigger:')) return 'automation';
  if (invocation.startsWith('system:')) return 'system';
  if (['slack', 'email', 'telegram', 'teams', 'admin'].includes(invocation)) {
    return invocation;
  }
  if (input.origin === 'trigger' || input.origin === 'schedule') return 'automation';
  if (input.origin === 'system') return 'system';
  if (input.origin === 'backend') return 'api';
  return 'human';
}

export interface SessionCreatedAuditAttribution {
  actorType: AuditActorType;
  authoritativeSource: string;
  clientReportedSource: string | null;
  initiatorActorType: 'agent' | null;
  initiatorActorId: string | null;
  delegationDepth: number;
}

export function sessionCreatedAuditAttribution(
  input: SessionCreatedAuditInput,
): SessionCreatedAuditAttribution {
  const actor = actorType(input);
  return {
    actorType: actor,
    authoritativeSource: authoritativeSource(input, actor),
    clientReportedSource: input.clientReportedSource ?? null,
    initiatorActorType: input.callerSessionId ? 'agent' : null,
    initiatorActorId: input.callerSessionId ?? null,
    delegationDepth: input.callerSessionId ? 1 : 0,
  };
}

export function sessionCreatedAuditEvent(input: SessionCreatedAuditInput): AuditEventInput {
  const attribution = sessionCreatedAuditAttribution(input);
  return {
    accountId: input.accountId,
    projectId: input.projectId,
    sessionId: input.sessionId,
    actorUserId: input.actorUserId,
    actorType: attribution.actorType,
    authoritativeSource: attribution.authoritativeSource,
    clientReportedSource: attribution.clientReportedSource,
    initiatorActorType: attribution.initiatorActorType,
    initiatorActorId: attribution.initiatorActorId,
    delegationDepth: attribution.delegationDepth,
    outcome: 'success',
    action: 'session.created',
    phase: 'created',
    resourceType: 'project_session',
    resourceId: input.sessionId,
    sourceLedger: 'project_sessions',
    sourceRecordId: input.sessionId,
    sourceRevision: 'created',
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
