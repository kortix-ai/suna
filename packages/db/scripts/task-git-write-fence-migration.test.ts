import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

const migrations = join(import.meta.dir, '..', 'migrations');

describe('task Git write fence migrations', () => {
  test('adds the paired request lease before validating it in a later migration', async () => {
    const add = await Bun.file(
      join(migrations, '20260807032927916_task_git_write_fence.sql'),
    ).text();
    const requiresWorker = await Bun.file(
      join(migrations, '20260807033625172_task_git_write_requires_doing_worker.sql'),
    ).text();
    const validate = await Bun.file(
      join(migrations, '20260807050001000_validate_task_git_write_fence.sql'),
    ).text();
    expect(add).toContain('ADD COLUMN "git_write_request_id" text');
    expect(add).toContain('ADD COLUMN "git_write_lease_expires_at" timestamp with time zone');
    expect(add).toContain('project_tasks_git_write_lease_pair');
    expect(add).toContain('project_tasks_git_write_lease_within_worker_deadline');
    expect(add.match(/\) NOT VALID;/g)).toHaveLength(2);
    expect(requiresWorker).toContain('project_tasks_git_write_requires_doing_worker');
    expect(requiresWorker).toContain("status\" = 'doing'");
    expect(requiresWorker).toContain('NOT VALID');
    expect(validate).toContain('VALIDATE CONSTRAINT "project_tasks_git_write_lease_pair"');
    expect(validate).toContain(
      'VALIDATE CONSTRAINT "project_tasks_git_write_lease_within_worker_deadline"',
    );
    expect(validate).toContain(
      'VALIDATE CONSTRAINT "project_tasks_git_write_requires_doing_worker"',
    );
  });

  test('upgrades expiry into confirmed settlement plus remote reconciliation', async () => {
    const migration = await Bun.file(
      join(migrations, '20260807051915174_task_git_write_confirmed_settlement.sql'),
    ).text();
    expect(migration).toContain('ADD COLUMN git_write_state varchar(16)');
    expect(migration).toContain("git_write_state IN ('live', 'settled')");
    expect(migration).toContain('IN (0, 2, 6)');
    expect(migration).toContain("git_write_ref = 'refs/heads/' || liveness_worker_session_id");
    expect(migration).toContain("git_write_new_oid !~ '^0+$'");
    expect(migration).toContain(
      'DROP CONSTRAINT IF EXISTS project_tasks_git_write_lease_within_worker_deadline',
    );
    const validate = await Bun.file(
      join(migrations, '20260807060001000_validate_task_git_write_confirmed_settlement.sql'),
    ).text();
    const concurrentIndex = await Bun.file(
      join(migrations, '20260807060002000_task_git_write_reconcile_index.concurrent.ts'),
    ).text();
    expect(validate).toContain('VALIDATE CONSTRAINT project_tasks_git_write_complete');
    expect(concurrentIndex).toContain(
      'create index concurrently if not exists idx_project_tasks_git_write_reconcile',
    );
    expect(concurrentIndex).toContain('pgm.noTransaction()');
  });
});
