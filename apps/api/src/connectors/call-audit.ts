import type { AuditEventInput, AuditOutcome } from '../shared/audit';
import type { ExecutionRecord } from './gateway';
import { buildArgsPreview } from './args-preview';

function outcome(status: ExecutionRecord['status']): AuditOutcome {
  if (status === 'ok') return 'success';
  if (status === 'denied') return 'denied';
  if (status === 'pending_approval') return 'pending';
  return 'failure';
}

export function executionAuditEvent(
  execution: ExecutionRecord,
  executionId: string,
): AuditEventInput {
  return {
    accountId: execution.accountId,
    projectId: execution.projectId,
    sessionId: execution.sessionId,
    actorUserId: execution.actingUserId,
    actorType: execution.sessionId ? 'agent' : 'human',
    source: 'connector',
    outcome: outcome(execution.status),
    action: `connector.${execution.actionPath}`,
    resourceType: 'connector_action',
    resourceId: executionId,
    correlationId: executionId,
    metadata: {
      action_path: execution.actionPath,
      connector_id: execution.connectorId,
      connection_id: execution.connectionId,
      risk: execution.risk,
      result_summary: buildArgsPreview(execution.resultSummary),
    },
  };
}

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
