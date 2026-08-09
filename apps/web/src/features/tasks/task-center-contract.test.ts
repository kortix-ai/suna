import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const WEB_ROOT = resolve(import.meta.dir, '../..');
const view = readFileSync(resolve(WEB_ROOT, 'features/tasks/task-center.tsx'), 'utf8');
const nav = readFileSync(
  resolve(WEB_ROOT, 'features/workspace/project-sidebar/footer/project-tasks-nav.tsx'),
  'utf8',
);
const registry = readFileSync(resolve(WEB_ROOT, 'lib/menu-registry.ts'), 'utf8');

test('the task center is fail-closed on agi across page and discovery surfaces', () => {
  expect(view).toContain("useFeatureFlag(projectId, 'agi')");
  expect(nav).toContain("useFeatureFlag(projectId, 'agi')");
  expect(nav).toContain('if (!projectId || !gate.enabled) return null;');
  expect(registry).toContain("requiresFlag: 'agi'");
});

test('the task center uses the SDK control plane without a raw backend transport', () => {
  expect(view).toContain('listProjectTasks');
  expect(view).toContain('listProjectTaskEvidence');
  expect(view).toContain('listProjectTaskBlockers');
  expect(view).toContain('listProjectTaskEvents');
  expect(view).toContain('listProjectTaskSessionLinks');
  expect(view).toContain('requestProjectTaskCompletion');
  expect(view).toContain('createProjectTask');
  expect(view).not.toContain('globalThis.fetch');
  expect(view).not.toContain('authenticatedFetch');
  expect(view).not.toContain('backendApi');
});

test('the task center has a direct Delegate contract instead of routing through chat', () => {
  expect(view).toContain('Delegate a task');
  expect(view).toContain("origin: 'web.delegate'");
  expect(view).toContain("status: 'todo'");
  expect(view).toContain("review_policy: { mode: 'human' }");
  expect(view).toContain("kind: 'artifact'");
  expect(view).toContain('The cloud coordinator claims the task');
});

test('the review surface exposes onboarding, evidence, blockers, and lineage', () => {
  expect(view).toContain('Coworker readiness');
  expect(view).toContain('Submitted evidence');
  expect(view).toContain('Verification contract');
  expect(view).toContain('Reminder {relativeTime(blocker.next_reminder_at)}');
  expect(view).toContain('Event timeline');
  expect(view).toContain('Session lineage');
  expect(view).toContain('Verify and close');
});

test('readiness and verification do not turn unknown state into success', () => {
  expect(view).toContain('const toolsReady = servicesQuery.isError ? null : hasConnectors');
  expect(view).toContain('Connector status is unavailable.');
  expect(view).toContain("tasks.filter((task) => taskMatchesFilter(task, 'open'))");
  expect(view).toContain('allOpenBlockersQuery.isSuccess');
  expect(view).toContain('Coordinator configuration');
  expect(view).not.toContain('The cloud coworker identity is active.');
  expect(view).toContain('candidateDigestForReview(task, evidence, eventsQuery.data ?? [])');
  expect(view).toContain('orderSessionLineage(sessions)');
});
