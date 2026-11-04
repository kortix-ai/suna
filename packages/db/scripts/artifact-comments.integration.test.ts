import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import pg from 'pg';

const databaseUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)('artifact comments migration', () => {
  const client = new pg.Client({ connectionString: databaseUrl });
  let artifactId: string;
  let projectId: string;
  let userId: string;
  let threadId: string;

  beforeAll(async () => { await client.connect(); });
  afterAll(async () => { await client.end(); });
  beforeEach(async () => {
    await client.query('BEGIN');
    userId = crypto.randomUUID();
    const { rows: [account] } = await client.query("INSERT INTO kortix.accounts(name) VALUES ('Comment migration test') RETURNING account_id");
    const { rows: [project] } = await client.query("INSERT INTO kortix.projects(account_id, name, repo_url) VALUES ($1, 'Comment migration test', 'https://example.test/repo.git') RETURNING project_id", [account.account_id]);
    projectId = project.project_id;
    const { rows: [drive] } = await client.query("INSERT INTO kortix.drives(account_id, project_id, kind, name, platinum_volume_name) VALUES ($1, $2, 'project', 'Comment test drive', $3) RETURNING drive_id", [account.account_id, projectId, `test-comments-${crypto.randomUUID()}`]);
    const { rows: [artifact] } = await client.query("INSERT INTO kortix.artifacts(project_id, account_id, drive_id, root, entry, folder, title, type, created_by_user_id) VALUES ($1, $2, $3, 'test.md', 'test.md', false, 'Comment test', 'doc', $4) RETURNING artifact_id", [projectId, account.account_id, drive.drive_id, userId]);
    artifactId = artifact.artifact_id;
    const { rows: [thread] } = await client.query("INSERT INTO kortix.artifact_comment_threads(artifact_id, project_id, anchor, anchor_version, created_by_user_id) VALUES ($1, $2, '{\"type\":\"none\",\"version\":\"v1\"}', 'v1', $3) RETURNING thread_id", [artifactId, projectId, userId]);
    threadId = thread.thread_id;
  });
  afterEach(async () => { await client.query('ROLLBACK'); });

  async function rejectsConstraint(sql: string, values: unknown[], code: string) {
    await client.query('SAVEPOINT rejected_write');
    await expect(client.query(sql, values)).rejects.toMatchObject({ code });
    await client.query('ROLLBACK TO SAVEPOINT rejected_write');
  }

  test('requires exactly one user or session author for threads and comments', async () => {
    for (const [user, session] of [[null, null], [userId, 'session-test']] as const) {
      await rejectsConstraint("INSERT INTO kortix.artifact_comment_threads(artifact_id, project_id, anchor, anchor_version, created_by_user_id, created_by_session_id) VALUES ($1, $2, '{}', 'v1', $3, $4)", [artifactId, projectId, user, session], '23514');
      await rejectsConstraint('INSERT INTO kortix.artifact_comments(thread_id, author_user_id, author_session_id, body) VALUES ($1, $2, $3, $4)', [threadId, user, session, 'Test body'], '23514');
    }
    const { rows } = await client.query('INSERT INTO kortix.artifact_comments(thread_id, author_session_id, body) VALUES ($1, $2, $3) RETURNING author_user_id, author_session_id, mentions, marks', [threadId, 'session-test', 'Agent question']);
    expect(rows).toEqual([{ author_user_id: null, author_session_id: 'session-test', mentions: [], marks: [] }]);
    expect((await client.query('SELECT status, agent_state FROM kortix.artifact_comment_threads WHERE thread_id = $1', [threadId])).rows).toEqual([{ status: 'open', agent_state: 'none' }]);
  });

  test('enforces body length and enum values in PostgreSQL', async () => {
    for (const body of ['', 'x'.repeat(10001)]) {
      await rejectsConstraint('INSERT INTO kortix.artifact_comments(thread_id, author_user_id, body) VALUES ($1, $2, $3)', [threadId, userId, body], '23514');
    }
    expect((await client.query('INSERT INTO kortix.artifact_comments(thread_id, author_user_id, body) VALUES ($1, $2, $3) RETURNING char_length(body) AS length', [threadId, userId, 'x'.repeat(10000)])).rows).toEqual([{ length: 10000 }]);
    expect((await client.query("UPDATE kortix.artifact_comments SET body = '', deleted_at = now() WHERE thread_id = $1 RETURNING body, deleted_at IS NOT NULL AS deleted", [threadId])).rows).toEqual([{ body: '', deleted: true }]);
    await rejectsConstraint('UPDATE kortix.artifact_comment_threads SET status = $1 WHERE thread_id = $2', ['deleted', threadId], '23514');
    await rejectsConstraint('UPDATE kortix.artifact_comment_threads SET agent_state = $1 WHERE thread_id = $2', ['running', threadId], '23514');
  });

  test('artifact deletion cascades through threads, comments and write limits', async () => {
    await client.query('INSERT INTO kortix.artifact_comments(thread_id, author_user_id, body) VALUES ($1, $2, $3)', [threadId, userId, 'Test body']);
    await client.query('INSERT INTO kortix.artifact_comment_write_limits(artifact_id, actor_key, writes) VALUES ($1, $2, 1)', [artifactId, `user:${userId}`]);
    await client.query('DELETE FROM kortix.artifacts WHERE artifact_id = $1', [artifactId]);
    expect((await client.query('SELECT count(*)::int AS n FROM kortix.artifact_comment_threads WHERE artifact_id = $1', [artifactId])).rows).toEqual([{ n: 0 }]);
    expect((await client.query('SELECT count(*)::int AS n FROM kortix.artifact_comments WHERE thread_id = $1', [threadId])).rows).toEqual([{ n: 0 }]);
    expect((await client.query('SELECT count(*)::int AS n FROM kortix.artifact_comment_write_limits WHERE artifact_id = $1', [artifactId])).rows).toEqual([{ n: 0 }]);
  });

  test('persists one nonnegative write counter per artifact and actor', async () => {
    const key = `user:${userId}`;
    await client.query('INSERT INTO kortix.artifact_comment_write_limits(artifact_id, actor_key, writes) VALUES ($1, $2, 60)', [artifactId, key]);
    await rejectsConstraint('INSERT INTO kortix.artifact_comment_write_limits(artifact_id, actor_key) VALUES ($1, $2)', [artifactId, key], '23505');
    await rejectsConstraint('UPDATE kortix.artifact_comment_write_limits SET writes = -1 WHERE artifact_id = $1 AND actor_key = $2', [artifactId, key], '23514');
    expect((await client.query('SELECT writes FROM kortix.artifact_comment_write_limits WHERE artifact_id = $1 AND actor_key = $2', [artifactId, key])).rows).toEqual([{ writes: 60 }]);
  });

  test('seeds the comment permission for built-in project members and managers only', async () => {
    expect((await client.query("SELECT implies FROM kortix.permissions WHERE action = 'project.artifact.comment'")).rows).toEqual([{ implies: ['project.artifact.read'] }]);
    expect((await client.query("SELECT r.key FROM kortix.iam_roles r JOIN kortix.role_permissions rp ON rp.role_id = r.role_id WHERE rp.action = 'project.artifact.comment' AND r.account_id IS NULL AND r.scope_type = 'project' ORDER BY r.key")).rows).toEqual([{ key: 'manager' }, { key: 'member' }]);
  });
});
