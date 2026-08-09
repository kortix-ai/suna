import type { TunnelCapability } from 'agent-tunnel';
import type { AuditActorType, AuditEventInput } from '../../shared/audit';

interface TunnelCentralAuditInput {
  tunnelId: string;
  accountId: string;
  projectId?: string | null;
  sessionId?: string | null;
  actorUserId?: string | null;
  actorType?: AuditActorType | null;
  capability: TunnelCapability;
  operation: string;
  requestSummary: Record<string, unknown>;
  success: boolean;
  durationMs?: number;
  bytesTransferred?: number;
  errorMessage?: string;
}

export function tunnelCentralAuditEvent(input: TunnelCentralAuditInput): AuditEventInput {
  return {
    accountId: input.accountId,
    projectId: input.projectId ?? null,
    sessionId: input.sessionId ?? null,
    actorUserId: input.actorUserId ?? null,
    actorType: input.actorType ?? (input.actorUserId ? 'human' : 'system'),
    source: 'connector',
    outcome: input.success ? 'success' : 'failure',
    action: `connector.computer.${input.operation}`,
    resourceType: 'computer_tunnel',
    resourceId: input.tunnelId,
    durationMs: input.durationMs ?? null,
    metadata: {
      capability: input.capability,
      bytes_transferred: input.bytesTransferred ?? null,
    },
  };
}
