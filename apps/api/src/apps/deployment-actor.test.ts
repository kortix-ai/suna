import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';

const ROUTES = readFileSync(join(import.meta.dir, 'routes.ts'), 'utf8');
/** Machines are created in machines.ts (one per process group and scale). */
const MACHINES = readFileSync(join(import.meta.dir, 'machines.ts'), 'utf8');
const WORKER = readFileSync(
  join(import.meta.dir, 'deployment-worker.ts'),
  'utf8',
);

describe('App deployment actor attribution', () => {
  test('persists the deploying caller on each immutable deployment', () => {
    expect(ROUTES).toContain('createdBy: loaded.userId');
    expect(ROUTES).toContain('created_by: row.createdBy');
    expect(ROUTES).toContain('sourceSessionId: callerKortixSessionId(c)');
    expect(ROUTES).toContain('actorType: appDeploymentActorType(c)');
    expect(ROUTES).toContain('source_session_id: row.sourceSessionId');
    expect(ROUTES).toContain('actor_type: row.actorType');
  });

  test('kicks the worker immediately after the deployment transaction commits', () => {
    expect(ROUTES).toContain('triggerAppDeploymentWorker();');
    expect(WORKER).toContain('export function triggerAppDeploymentWorker(): void');
  });

  test('resolves personal secret overrides for the deploying caller', () => {
    expect(WORKER).toContain(
      'listResolvedProjectSecrets(\n    context.app.projectId,\n    context.deployment.createdBy,\n  )',
    );
    expect(WORKER).not.toContain(
      'context.artifact.createdBy ?? context.app.createdBy',
    );
  });

  test('attributes the runtime and compute session to the deploying caller', () => {
    expect(MACHINES).toContain('userId: deployment.createdBy');
    expect(MACHINES).toContain('actorUserId: deployment.createdBy');
    expect(MACHINES).not.toContain('actorUserId: app.createdBy');
  });
});
