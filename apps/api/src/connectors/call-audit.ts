import type { AuditEventInput } from '../shared/audit';

interface ApprovalResolvedAuditInput {
  accountId: string;
  projectId: string;
  sessionId: string | null;
  executionId: string;
  actorUserId: string;
  actionPath: string;
  connectorId: string | null;
  decision: 'approve' | 'deny';
  source: string;
}

export function approvalResolvedAuditEvent(
  input: ApprovalResolvedAuditInput,
): AuditEventInput {
  const approved = input.decision === 'approve';
  return {
    accountId: input.accountId,
    projectId: input.projectId,
    sessionId: input.sessionId,
    actorUserId: input.actorUserId,
    actorType: 'human',
    source: input.source,
    outcome: approved ? 'success' : 'denied',
    action: approved ? 'connector.approval.approved' : 'connector.approval.denied',
    resourceType: 'connector_approval',
    resourceId: input.executionId,
    correlationId: input.executionId,
    metadata: {
      action_path: input.actionPath,
      connector_id: input.connectorId,
      decision: input.decision,
    },
  };
}
