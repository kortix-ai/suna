import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

test('every reviewed session-spawning escape route applies runtime confinement', () => {
  const triggerRoutes = readFileSync(new URL('./r4.ts', import.meta.url), 'utf8');
  expect(triggerRoutes).toContain('taskWorkerDelegationDenied');
  expect(triggerRoutes).toContain("code: 'task_worker_delegation_denied'");

  const crRoutes = readFileSync(new URL('./r8.ts', import.meta.url), 'utf8');
  expect(crRoutes).toContain('assertHumanReviewPrincipal');
  expect(crRoutes).toContain('callerOriginSessionId');
  expect(crRoutes).toContain("c.get('authType') !== 'service_account'");
  expect(crRoutes).toContain('A service account cannot assign change-request session provenance');
  expect(crRoutes).toContain('loadVisibleSession(loaded, cr.originSessionId, null)');
});
