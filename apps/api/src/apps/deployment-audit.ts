/**
 * Audit rows for App deployment outcomes.
 *
 * The deploy request is audited when a member makes it. Whether that code then
 * goes live on a public origin is decided later by the `app-deployments`
 * worker, with no request, so the outcome needs its own row. The worker is
 * the actor (inherited from its tick); the member who started the deployment
 * is the initiator.
 */
import type { AuditEventInput } from '../shared/audit';

export interface DeploymentAuditRef {
  appId: string;
  deploymentId: string;
  accountId: string;
  projectId: string;
  createdBy: string | null;
}

export type DeploymentOutcome =
  | { outcome: 'activated'; previousDeploymentId: string | null }
  | { outcome: 'failed'; errorCode: string | null; attempt: number };

export function deploymentOutcomeEvent(ref: DeploymentAuditRef, result: DeploymentOutcome): AuditEventInput {
  const common = {
    accountId: ref.accountId,
    projectId: ref.projectId,
    resourceType: 'app',
    resourceId: ref.appId,
    initiatorActorType: ref.createdBy ? 'human' : null,
    initiatorActorId: ref.createdBy,
  };
  if (result.outcome === 'activated') {
    return {
      ...common,
      action: 'app.deployment.activated',
      outcome: 'success',
      metadata: { deployment_id: ref.deploymentId, previous_deployment_id: result.previousDeploymentId },
    };
  }
  return {
    ...common,
    action: 'app.deployment.failed',
    outcome: 'failure',
    errorCode: result.errorCode,
    metadata: { deployment_id: ref.deploymentId, attempt: result.attempt },
  };
}

async function defaultRecord(event: AuditEventInput): Promise<unknown> {
  const { recordAuditEvent } = await import('../shared/audit');
  return recordAuditEvent(event);
}

/** Write the outcome row. An audit failure never fails the deployment. */
export async function auditDeploymentOutcome(
  ref: DeploymentAuditRef,
  result: DeploymentOutcome,
  record: (event: AuditEventInput) => Promise<unknown> = defaultRecord,
): Promise<void> {
  try {
    await record(deploymentOutcomeEvent(ref, result));
  } catch (err) {
    console.warn('[apps] deployment outcome audit failed:', ref.deploymentId, err);
  }
}
