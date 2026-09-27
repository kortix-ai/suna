/**
 * The outcome of an App deployment is audited.
 *
 * A member's deploy request is audited when it is made, but the deployment
 * worker decides later, with no request, whether that code goes live on a
 * public origin. The outcome row names the worker as actor (inherited from the
 * `app-deployments` tick) and the member who started it as initiator.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import type { AuditEventInput } from '../shared/audit';
import { auditDeploymentOutcome, deploymentOutcomeEvent } from './deployment-audit';

const REF = {
  appId: '00000000-0000-4000-a000-000000000401',
  deploymentId: '00000000-0000-4000-a000-000000000402',
  accountId: '00000000-0000-4000-a000-000000000101',
  projectId: '00000000-0000-4000-a000-000000000201',
  createdBy: '00000000-0000-4000-a000-000000000001',
};

describe('deployment outcome audit', () => {
  test('an activated deployment names the app, the deployment it replaced, and who started it', () => {
    expect(deploymentOutcomeEvent(REF, { outcome: 'activated', previousDeploymentId: 'dep-old' })).toEqual({
      accountId: REF.accountId,
      projectId: REF.projectId,
      action: 'app.deployment.activated',
      resourceType: 'app',
      resourceId: REF.appId,
      outcome: 'success',
      initiatorActorType: 'human',
      initiatorActorId: REF.createdBy,
      metadata: { deployment_id: REF.deploymentId, previous_deployment_id: 'dep-old' },
    });
  });

  test('a deployment that failed for good carries its error code and attempt', () => {
    expect(deploymentOutcomeEvent(REF, { outcome: 'failed', errorCode: 'build_failed', attempt: 3 })).toEqual({
      accountId: REF.accountId,
      projectId: REF.projectId,
      action: 'app.deployment.failed',
      resourceType: 'app',
      resourceId: REF.appId,
      outcome: 'failure',
      errorCode: 'build_failed',
      initiatorActorType: 'human',
      initiatorActorId: REF.createdBy,
      metadata: { deployment_id: REF.deploymentId, attempt: 3 },
    });
  });

  test('an audit failure never fails the deployment', async () => {
    const record = async (_event: AuditEventInput) => {
      throw new Error('audit queue full');
    };
    await expect(auditDeploymentOutcome(REF, { outcome: 'activated', previousDeploymentId: null }, record))
      .resolves.toBeUndefined();
  });

  test('the row is written through the recorder', async () => {
    const recorded: AuditEventInput[] = [];
    await auditDeploymentOutcome(REF, { outcome: 'activated', previousDeploymentId: null }, async (event) => {
      recorded.push(event);
    });
    expect(recorded.map((event) => event.action)).toEqual(['app.deployment.activated']);
    expect(recorded[0]!.metadata).toEqual({ deployment_id: REF.deploymentId, previous_deployment_id: null });
  });
});

// driveAppDeployment needs the hosting provider, artifacts and snapshots to
// run, so the wiring is pinned on its source: both outcomes call the helper.
test('the deployment worker audits activation and terminal failure', () => {
  const worker = readFileSync(new URL('./deployment-worker.ts', import.meta.url), 'utf8');
  expect(worker).toContain("auditDeploymentOutcome(auditRef, { outcome: 'activated', previousDeploymentId: previous })");
  expect(worker).toContain("auditDeploymentOutcome(ref, { outcome: 'failed', errorCode, attempt })");
});

