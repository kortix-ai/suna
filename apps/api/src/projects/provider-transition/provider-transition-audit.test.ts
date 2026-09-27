/**
 * A sandbox-provider transition's outcome is a project configuration change.
 *
 * The switch is requested over HTTP (audited as that request), but the
 * transition finishes later: the runner activates it (the project's sessions
 * move to the target provider) or fails it, often inside the
 * `provider-transition` worker, with no request. Both outcomes are audited.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import type { AuditEventInput } from '../../shared/audit';
import { auditProviderTransition, providerTransitionAuditEvent } from './provider-transition-audit';

const ROW = {
  transitionId: '00000000-0000-4000-a000-000000000501',
  accountId: '00000000-0000-4000-a000-000000000101',
  projectId: '00000000-0000-4000-a000-000000000201',
  sourceProvider: 'daytona',
  targetProvider: 'platinum',
  mode: 'switch',
  generation: 4,
};

describe('provider transition audit', () => {
  test('an activation records the provider the project moved from and to', () => {
    expect(providerTransitionAuditEvent(ROW, { outcome: 'activated' })).toEqual({
      accountId: ROW.accountId,
      projectId: ROW.projectId,
      action: 'project.sandbox_provider.activated',
      resourceType: 'project',
      resourceId: ROW.projectId,
      outcome: 'success',
      before: { sandbox_provider: 'daytona' },
      after: { sandbox_provider: 'platinum' },
      metadata: { transition_id: ROW.transitionId, mode: 'switch', generation: 4 },
    });
  });

  test('a terminal failure records its error class and attempts; the project stays put', () => {
    expect(
      providerTransitionAuditEvent(ROW, { outcome: 'failed', errorClass: 'build_timeout', attempts: 5 }),
    ).toEqual({
      accountId: ROW.accountId,
      projectId: ROW.projectId,
      action: 'project.sandbox_provider.transition_failed',
      resourceType: 'project',
      resourceId: ROW.projectId,
      outcome: 'failure',
      errorCode: 'build_timeout',
      before: { sandbox_provider: 'daytona' },
      after: { sandbox_provider: 'daytona' },
      metadata: { transition_id: ROW.transitionId, mode: 'switch', generation: 4, attempts: 5, target_provider: 'platinum' },
    });
  });

  test('an audit failure never fails the transition', async () => {
    await expect(
      auditProviderTransition(ROW, { outcome: 'activated' }, async () => {
        throw new Error('audit queue full');
      }),
    ).resolves.toBeUndefined();
  });

  test('the row is written through the recorder', async () => {
    const recorded: AuditEventInput[] = [];
    await auditProviderTransition(ROW, { outcome: 'activated' }, async (event) => {
      recorded.push(event);
    });
    expect(recorded.map((event) => event.action)).toEqual(['project.sandbox_provider.activated']);
  });
});

// The store functions need a real database (provider-transition-flow.test.ts
// skips without one), so the wiring is pinned on their source.
test('activateWithCas and failTransition audit their outcome', () => {
  const store = readFileSync(new URL('./provider-transition-store.ts', import.meta.url), 'utf8');
  expect(store).toContain("auditProviderTransition(result.row, { outcome: 'activated' })");
  expect(store).toContain("auditProviderTransition(row, { outcome: 'failed', errorClass: patch.errorClass, attempts: patch.attempts })");
});
