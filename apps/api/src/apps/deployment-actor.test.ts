import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';

const ROUTES = readFileSync(join(import.meta.dir, 'routes.ts'), 'utf8');
const WORKER = readFileSync(
  join(import.meta.dir, 'deployment-worker.ts'),
  'utf8',
);

describe('App deployment actor attribution', () => {
  test('persists the deploying caller on each immutable deployment', () => {
    expect(ROUTES).toContain('createdBy: loaded.userId');
    expect(ROUTES).toContain('created_by: row.createdBy');
  });

  test('resolves personal secret overrides for the deploying caller', () => {
    expect(WORKER).toContain(
      'listResolvedProjectSecrets(\n      context.app.projectId,\n      context.deployment.createdBy,\n    )',
    );
    expect(WORKER).not.toContain(
      'context.artifact.createdBy ?? context.app.createdBy',
    );
  });

  test('attributes the runtime and compute session to the deploying caller', () => {
    expect(WORKER).toContain('userId: context.deployment.createdBy');
    expect(WORKER).toContain('actorUserId: context.deployment.createdBy');
    expect(WORKER).not.toContain('actorUserId: context.app.createdBy');
  });
});
