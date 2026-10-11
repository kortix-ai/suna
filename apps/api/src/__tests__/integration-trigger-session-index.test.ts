/**
 * Integration test (real local PostgreSQL, fully migrated): the keyed-trigger
 * session lookup is served by `idx_project_sessions_trigger_key` instead of a
 * walk over every session of the project.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { accounts, projects } from '@kortix/db';
import { eq, sql } from 'drizzle-orm';
import { db } from '../shared/db';

const ACCOUNT = crypto.randomUUID();
const PROJECT = crypto.randomUUID();

beforeAll(async () => {
  await db.insert(accounts).values({ accountId: ACCOUNT, name: 'trigger-index-test' });
  await db.insert(projects).values({ projectId: PROJECT, accountId: ACCOUNT, name: 'p', repoUrl: 'https://example.com/p.git' });
  // 3000 ordinary sessions and 20 keyed ones for two triggers.
  await db.execute(sql`
    INSERT INTO kortix.project_sessions (session_id, account_id, project_id, branch_name, created_by, visibility, metadata)
    SELECT 'ordinary-' || g, ${ACCOUNT}::uuid, ${PROJECT}::uuid, 'ordinary-' || g, ${ACCOUNT}::uuid, 'project',
           CASE WHEN g <= 20 THEN jsonb_build_object('trigger_slug', 'slug-' || (g % 2), 'trigger_kind', 'git', 'trigger_session_key', 'chat-' || g) ELSE '{}'::jsonb END
    FROM generate_series(1, 3000) g
  `);
  await db.execute(sql`ANALYZE kortix.project_sessions`);
});

afterAll(async () => {
  await db.delete(projects).where(eq(projects.accountId, ACCOUNT));
  await db.delete(accounts).where(eq(accounts.accountId, ACCOUNT));
});

test('the keyed lookup plans an index scan on the trigger-key index', async () => {
  const rows = (await db.execute(sql`
    EXPLAIN SELECT session_id FROM kortix.project_sessions
    WHERE project_id = ${PROJECT}::uuid AND status <> 'failed'
      AND metadata ->> 'trigger_slug' = 'slug-1' AND metadata ->> 'trigger_kind' = 'git'
      AND metadata ->> 'trigger_session_key' = 'chat-7'
    ORDER BY created_at DESC LIMIT 1
  `)) as unknown as Array<Record<string, string>>;
  const plan = rows.map((row) => Object.values(row)[0]).join('\n');
  expect(plan).toContain('idx_project_sessions_trigger_key');
});
