/**
 * Audit rows for sandbox-provider transition outcomes.
 *
 * Activation moves a project's sessions to the target provider (it pins
 * `projects.metadata`), so it is a project configuration change. The request
 * that asked for it is audited when made; the outcome often lands later in the
 * `provider-transition` worker, which is the actor then.
 */
import type { AuditEventInput } from '../../shared/audit';

export interface ProviderTransitionAuditRow {
  transitionId: string;
  accountId: string;
  projectId: string;
  sourceProvider: string;
  targetProvider: string;
  mode: string;
  generation: number | null;
}

export type ProviderTransitionOutcome =
  | { outcome: 'activated' }
  | { outcome: 'failed'; errorClass: string; attempts: number };

export function providerTransitionAuditEvent(
  row: ProviderTransitionAuditRow,
  result: ProviderTransitionOutcome,
): AuditEventInput {
  const common = {
    accountId: row.accountId,
    projectId: row.projectId,
    resourceType: 'project',
    resourceId: row.projectId,
    before: { sandbox_provider: row.sourceProvider },
  };
  const metadata = { transition_id: row.transitionId, mode: row.mode, generation: row.generation };
  if (result.outcome === 'activated') {
    return {
      ...common,
      action: 'project.sandbox_provider.activated',
      outcome: 'success',
      after: { sandbox_provider: row.targetProvider },
      metadata,
    };
  }
  return {
    ...common,
    action: 'project.sandbox_provider.transition_failed',
    outcome: 'failure',
    errorCode: result.errorClass,
    after: { sandbox_provider: row.sourceProvider },
    metadata: { ...metadata, attempts: result.attempts, target_provider: row.targetProvider },
  };
}

async function defaultRecord(event: AuditEventInput): Promise<unknown> {
  const { recordAuditEvent } = await import('../../shared/audit');
  return recordAuditEvent(event);
}

/** Write the outcome row. An audit failure never fails the transition. */
export async function auditProviderTransition(
  row: ProviderTransitionAuditRow,
  result: ProviderTransitionOutcome,
  record: (event: AuditEventInput) => Promise<unknown> = defaultRecord,
): Promise<void> {
  try {
    await record(providerTransitionAuditEvent(row, result));
  } catch (err) {
    console.warn('[provider-transition] outcome audit failed:', row.transitionId, err);
  }
}
