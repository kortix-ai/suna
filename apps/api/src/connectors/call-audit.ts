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

/** A pending approval whose window closed with no decision (the expiry worker). */
export function approvalExpiredAuditEvent(input: {
  accountId: string;
  projectId: string;
  sessionId: string | null;
  executionId: string;
  actionPath: string;
  connectorId: string | null;
}): AuditEventInput {
  return {
    accountId: input.accountId,
    projectId: input.projectId,
    sessionId: input.sessionId,
    actorType: 'system',
    source: 'system',
    outcome: 'expired',
    action: 'connector.approval.expired',
    resourceType: 'connector_approval',
    resourceId: input.executionId,
    correlationId: input.executionId,
    metadata: { action_path: input.actionPath, connector_id: input.connectorId },
  };
}

/** The approved held call ran, or ended without running (the held-call worker). */
export function approvalRunAuditEvent(input: {
  accountId: string;
  projectId: string;
  sessionId: string | null;
  executionId: string;
  actionPath: string;
  connectorId: string | null;
  approvedBy: string | null;
  state: string;
  reason: string | null;
  runExecutionId: string | null;
}): AuditEventInput {
  return {
    accountId: input.accountId,
    projectId: input.projectId,
    sessionId: input.sessionId,
    actorType: 'system',
    source: 'system',
    outcome: input.state === 'ok' ? 'success' : input.state === 'refused' ? 'denied' : 'failure',
    action: 'connector.approval.run',
    resourceType: 'connector_approval',
    resourceId: input.executionId,
    correlationId: input.executionId,
    metadata: {
      action_path: input.actionPath,
      connector_id: input.connectorId,
      approved_by: input.approvedBy,
      state: input.state,
      reason: input.reason,
      run_execution_id: input.runExecutionId,
    },
  };
}
