import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PgDialect } from 'drizzle-orm/pg-core';
import { getTableConfig } from 'drizzle-orm/pg-core';
import {
  projectTaskBlockers,
  projectTaskEvents,
  projectTaskEvidence,
  projectTaskMessages,
  projectTaskRefinementProposals,
  projectTaskSessionLinks,
  projectTasks,
} from './kortix';

const names = (table: unknown) =>
  getTableConfig(table as Parameters<typeof getTableConfig>[0]).columns.map(
    (column) => column.name,
  );

describe('AI coworker V1 task control plane', () => {
  test('stores a versioned outcome and verification contract on the durable task', () => {
    expect(names(projectTasks)).toEqual(
      expect.arrayContaining([
        'intent',
        'constraints',
        'out_of_scope',
        'contract_revision',
        'verification_requirements',
        'review_policy',
        'control_plane_version',
        'completed_at',
      ]),
    );
  });

  test('allows task-first rows without a Git-authored goal', () => {
    const goalSlug = getTableConfig(projectTasks).columns.find(
      (column) => column.name === 'goal_slug',
    );
    expect(goalSlug?.notNull).toBe(false);

    const migration = readFileSync(
      join(
        import.meta.dir,
        '..',
        '..',
        'migrations',
        '20260809030000000_ai_coworker_task_control_plane_v1.sql',
      ),
      'utf8',
    );
    expect(migration).toContain('ALTER COLUMN goal_slug DROP NOT NULL');
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS control_plane_version integer');

    const repairMigration = readFileSync(
      join(
        import.meta.dir,
        '..',
        '..',
        'migrations',
        '20260809030200000_repair_goal_less_task_contract.sql',
      ),
      'utf8',
    );
    expect(repairMigration).toContain('ALTER COLUMN goal_slug DROP NOT NULL');
  });

  test('stores immutable evidence, typed blockers, events, messages, and session links', () => {
    expect(names(projectTaskEvidence)).toEqual(
      expect.arrayContaining(['evidence_id', 'contract_revision', 'candidate_digest', 'state']),
    );
    expect(names(projectTaskBlockers)).toEqual(
      expect.arrayContaining(['blocker_id', 'category', 'requested_action', 'next_reminder_at']),
    );
    expect(names(projectTaskEvents)).toContain('event_type');
    expect(names(projectTaskMessages)).toEqual(
      expect.arrayContaining(['message_id', 'sender_session_id', 'recipient_session_id', 'status']),
    );
    expect(names(projectTaskSessionLinks)).toEqual(
      expect.arrayContaining(['task_id', 'session_id', 'role', 'parent_session_id']),
    );
    const openDigestIndex = getTableConfig(projectTaskBlockers).indexes.find(
      (candidate) => candidate.config.name === 'idx_project_task_blockers_open_digest_unique',
    );
    expect(openDigestIndex?.config.unique).toBe(true);
    if (!openDigestIndex?.config.where) throw new Error('missing open blocker index predicate');
    expect(new PgDialect().sqlToQuery(openDigestIndex.config.where).sql).toContain("= 'open'");
  });

  test('stores scoped refinement proposals with rollback state', () => {
    expect(names(projectTaskRefinementProposals)).toEqual(
      expect.arrayContaining(['proposal_id', 'scope', 'base_revision', 'patch', 'rollback_patch']),
    );
  });

  test('reserves coordinator ownership across doing and review', () => {
    const indexes = getTableConfig(projectTasks).indexes;
    for (const name of [
      'idx_project_tasks_live_claim_session',
      'idx_project_tasks_live_liveness_coordinator',
    ]) {
      const index = indexes.find((candidate) => candidate.config.name === name);
      expect(index).toBeDefined();
      if (!index?.config.where) throw new Error(`missing predicate for ${name}`);
      const where = new PgDialect().sqlToQuery(index.config.where).sql;
      expect(where).toContain("in ('doing', 'review')");
    }
  });

  test('refreshes the durable coordinator link when a task is reclaimed', () => {
    const migration = readFileSync(
      join(
        import.meta.dir,
        '..',
        '..',
        'migrations',
        '20260809030000000_ai_coworker_task_control_plane_v1.sql',
      ),
      'utf8',
    );
    const claimIndexMigration = readFileSync(
      join(
        import.meta.dir,
        '..',
        '..',
        'migrations',
        '20260809030100000_task_live_claim_session_index.concurrent.ts',
      ),
      'utf8',
    );
    const coordinatorIndexMigration = readFileSync(
      join(
        import.meta.dir,
        '..',
        '..',
        'migrations',
        '20260809030101000_task_live_coordinator_index.concurrent.ts',
      ),
      'utf8',
    );
    expect(migration).toContain('ON CONFLICT (task_id, session_id) DO UPDATE');
    expect(migration).toContain('created_at = EXCLUDED.created_at');
    expect(claimIndexMigration).toContain("WHERE status IN ('doing', 'review')");
    expect(coordinatorIndexMigration).toContain("WHERE status IN ('doing', 'review')");
  });

  test('migrates the reserved coordinator identity and project flag to AGI', () => {
    const migration = readFileSync(
      join(
        import.meta.dir,
        '..',
        '..',
        'migrations',
        '20260809030300000_rename_meta_coordinator_to_agi.sql',
      ),
      'utf8',
    );
    expect(migration).toContain("jsonb_set(metadata, '{experimental,agi}'");
    expect(migration).toContain("metadata #- '{experimental,meta_agent}'");
    expect(migration).toContain("SET agent_name = 'agi'");
    expect(migration).toContain("'{pending_prompt,agent}'");
    expect(migration).toContain("'{runtimeArtifact,sandboxSlug}'");
    expect(migration).toContain("SET assignee_agent = 'agi'");
    expect(migration).toContain("payload #>> '{body,agent_name}' = 'meta'");
    expect(migration).toContain("payload - 'platformMetaGoalPush'");
    expect(migration).toContain("'{platformAgiGoalPush}'");
    expect(migration).toContain("jsonb_set(agent_grant, '{agent}', '\"agi\"'::jsonb)");
  });
});
