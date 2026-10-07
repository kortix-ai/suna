/**
 * Integration test (real local PostgreSQL): the `db` phase of the Suna
 * migration (`dbStep` in apps/api/src/projects/suna-migration/suna-migration-phases.ts).
 *
 * dbStep had no test at all (the phase header marks it DRAFT, never run end
 * to end). This characterization pins the contract the phase exists for,
 * read back as raw rows — not through the writer's own mapping:
 *   - every migrated session row carries its legacy opencode session id in
 *     project_sessions.opencode_session_id — the column the drizzle table
 *     exposes as the `runtimeSessionId` property and the on-open runtime
 *     rehydrate reads — one per migrated session;
 *   - the rehydrate metadata carries the same id, a titled legacy thread
 *     keeps its title in metadata.name, a titleless one writes none, and the
 *     row is `completed` (a migrated thread never ran a turn here);
 *   - the project row (legacy_migration source pointer) and the managed git
 *     connection are written by the same transaction.
 */
import { describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { db } from '../shared/db';
import { removeSeeded, seedAccount } from './helpers/integration-fixtures';
import { dbStep } from '../projects/suna-migration/suna-migration-phases';
import type { SunaMigrationContext } from '../projects/suna-migration/suna-migration-runner';

const rows = (result: unknown) => ((result as { rows?: unknown[] }).rows ?? result) as Record<string, unknown>[];

interface LegacySessionMetadata {
  name?: string;
  legacy_migration?: {
    run_id?: string;
    source_sandbox_id?: string;
    rehydrate?: { opencode_session_id?: string };
  };
}

describe('dbStep (suna migration db phase)', () => {
  test('writes the opencode session id per migrated session, with rehydrate metadata, project and git connection', async () => {
    const specs = [
      { slug: 'alpha-thread', title: 'Alpha legacy thread', opencodeSessionId: 'oc-alpha', messageCount: 3 },
      // A legacy thread with no title: the insert must not write metadata.name.
      { slug: 'beta-thread', title: '', opencodeSessionId: 'oc-beta', messageCount: 0 },
    ];
    const accountId = await seedAccount('suna-mig-db-step');
    const projectId = crypto.randomUUID();
    const repoUrl = 'https://example.test/suna-mig-db-step/repo.git';
    const ctx: SunaMigrationContext = {
      database: db,
      migrationId: crypto.randomUUID(),
      runId: `run_${crypto.randomUUID()}`,
      accountId,
      plan: {},
      progress: {
        project_id: projectId,
        repo_url: repoUrl,
        repo_owner: 'suna-mig-db-step',
        repo_name: 'repo',
        default_branch: 'main',
        provider: 'github',
        sessions: specs,
      },
      // The checkpoint/heartbeat store is the runner's concern (its own
      // table), not the phase's; the phase under test only calls them.
      checkpoint: async () => {},
      heartbeat: async () => {},
      log: () => {},
    };
    try {
      await dbStep(ctx);

      const sessionRows = rows(await db.execute(sql`
        select session_id, branch_name, status, opencode_session_id, metadata
          from kortix.project_sessions where project_id = ${projectId}::uuid`));
      expect(sessionRows).toHaveLength(2);
      // THE assertion: the legacy opencode id lands in the column the drizzle
      // table exposes as `runtimeSessionId` and the runtime reads, for every
      // migrated session.
      expect(sessionRows.map((r) => r.opencode_session_id).sort()).toEqual(['oc-alpha', 'oc-beta']);
      for (const spec of specs) {
        const row = sessionRows.find((r) => r.opencode_session_id === spec.opencodeSessionId);
        expect(row).toBeDefined();
        expect(row?.branch_name).toBe(spec.slug);
        expect(row?.status).toBe('completed');
        const meta = (row?.metadata ?? {}) as LegacySessionMetadata;
        expect(meta.legacy_migration?.rehydrate?.opencode_session_id).toBe(spec.opencodeSessionId);
        expect(meta.legacy_migration?.run_id).toBe(ctx.runId);
        expect(meta.legacy_migration?.source_sandbox_id).toBe(projectId);
        if (spec.title) expect(meta.name).toBe(spec.title);
        else expect(meta.name).toBeUndefined();
      }

      const [project] = rows(await db.execute(sql`
        select name, metadata from kortix.projects where project_id = ${projectId}::uuid`));
      expect(project).toBeTruthy();
      expect(project.name).toBe('Legacy (Suna) projects');
      const projectMeta = project.metadata as {
        suna_migration?: { run_id?: string; sessions?: number };
        legacy_migration?: { source_sandbox_id?: string };
      };
      expect(projectMeta.legacy_migration?.source_sandbox_id).toBe(projectId);
      expect(projectMeta.suna_migration?.run_id).toBe(ctx.runId);
      expect(projectMeta.suna_migration?.sessions).toBe(2);

      const [connection] = rows(await db.execute(sql`
        select repo_url, managed, status from kortix.project_git_connections
         where project_id = ${projectId}::uuid`));
      expect(connection).toBeTruthy();
      expect(connection.repo_url).toBe(repoUrl);
      expect(connection.managed).toBe(true);
      expect(connection.status).toBe('connected');
    } finally {
      await removeSeeded([{ account_id: accountId, project_id: projectId }]);
    }
  });
});
