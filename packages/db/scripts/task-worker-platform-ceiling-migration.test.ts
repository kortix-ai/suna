import { expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { TASK_WORKER_PLATFORM_CEILINGS } from '../src/schema/kortix';

const migrationsDirectory = join(import.meta.dir, '..', 'migrations');

function migrationWithSlug(slug: string): string {
  const filename = readdirSync(migrationsDirectory).find((candidate) =>
    candidate.endsWith(`_${slug}.sql`)
  );
  expect(filename).toBeDefined();
  return readFileSync(join(migrationsDirectory, filename!), 'utf8');
}

test('worker platform ceiling migration literals match the server constants', () => {
  const expand = migrationWithSlug('add_task_worker_platform_ceiling');
  for (const [field, maximum] of Object.entries(TASK_WORKER_PLATFORM_CEILINGS)) {
    expect(expand).toContain(`->>'${field}')::numeric <= ${maximum}`);
  }
  expect(expand).toContain(
    'ADD CONSTRAINT "project_tasks_liveness_contract_platform_ceiling"',
  );
  expect(expand).toContain('NOT VALID');

  const validate = migrationWithSlug('validate_task_worker_platform_ceiling');
  expect(validate).toContain(
    'VALIDATE CONSTRAINT "project_tasks_liveness_contract_platform_ceiling"',
  );
});
