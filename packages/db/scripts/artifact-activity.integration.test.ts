import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import pg from 'pg';

const databaseUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)('artifact activity migration', () => {
  const client = new pg.Client({ connectionString: databaseUrl });
  let accountId: string;
  let projectId: string;
  let driveId: string;
  let artifactId: string;
  let sessionId: string;
  let userId: string;
  let externalId: string;

  beforeAll(async () => { await client.connect(); });
  afterAll(async () => { await client.end(); });
  beforeEach(async () => {
    await client.query('BEGIN');
    userId = crypto.randomUUID();
    sessionId = crypto.randomUUID();
    externalId = `sandbox-test-${crypto.randomUUID()}`;
    const { rows: [account] } = await client.query("INSERT INTO kortix.accounts(name) VALUES ('Artifact activity test') RETURNING account_id");
    accountId = account.account_id;
    const { rows: [project] } = await client.query("INSERT INTO kortix.projects(account_id, name, repo_url) VALUES ($1, 'Artifact activity test', 'https://example.test/activity.git') RETURNING project_id", [accountId]);
    projectId = project.project_id;
    const { rows: [drive] } = await client.query("INSERT INTO kortix.drives(account_id, project_id, kind, name, platinum_volume_name) VALUES ($1, $2, 'project', 'Activity test drive', $3) RETURNING drive_id", [accountId, projectId, `test-activity-${crypto.randomUUID()}`]);
    driveId = drive.drive_id;
    const { rows: [artifact] } = await client.query("INSERT INTO kortix.artifacts(project_id, account_id, drive_id, root, entry, folder, title, type, created_by_user_id) VALUES ($1, $2, $3, 'test.md', 'test.md', false, 'Activity test', 'doc', $4) RETURNING artifact_id", [projectId, accountId, driveId, userId]);
    artifactId = artifact.artifact_id;
    await client.query("INSERT INTO kortix.project_sessions(session_id, account_id, project_id, branch_name, sandbox_provider) VALUES ($1, $2, $3, $4, 'platinum')", [sessionId, accountId, projectId, `session/${sessionId}`]);
    await insertSandbox();
  });
  afterEach(async () => { await client.query('ROLLBACK'); });

  async function insertSandbox(external: string | null = null, account = accountId, project = projectId) {
    await client.query("INSERT INTO kortix.session_sandboxes(sandbox_id, session_id, account_id, project_id, provider, external_id) VALUES ($1::uuid, $1::text, $2, $3, 'platinum', $4)", [sessionId, account, project, external]);
  }

  async function activate() {
    await client.query("UPDATE kortix.session_sandboxes SET external_id = $1, status = 'active' WHERE session_id = $2", [externalId, sessionId]);
  }

  async function identities() {
    return (await client.query('SELECT provider, external_id, session_id FROM kortix.session_sandbox_identities WHERE account_id = $1 ORDER BY external_id', [accountId])).rows;
  }

  async function rejectsConstraint(sql: string, values: unknown[], code: string) {
    await client.query('SAVEPOINT rejected_write');
    await expect(client.query(sql, values)).rejects.toMatchObject({ code });
    await client.query('ROLLBACK TO SAVEPOINT rejected_write');
  }

  test('stores user, session and system events while rejecting two simultaneous actors', async () => {
    await client.query("INSERT INTO kortix.artifact_events(artifact_id, project_id, type, actor_user_id) VALUES ($1, $2, 'published', $3)", [artifactId, projectId, userId]);
    await client.query("INSERT INTO kortix.artifact_events(artifact_id, project_id, type, actor_session_id) VALUES ($1, $2, 'replied', $3)", [artifactId, projectId, sessionId]);
    await client.query("INSERT INTO kortix.artifact_events(artifact_id, project_id, type) VALUES ($1, $2, 'system')", [artifactId, projectId]);
    expect((await client.query('SELECT count(*)::int AS n FROM kortix.artifact_events WHERE artifact_id = $1', [artifactId])).rows).toEqual([{ n: 3 }]);
    expect((await client.query("SELECT data FROM kortix.artifact_events WHERE artifact_id = $1 AND type = 'system'", [artifactId])).rows).toEqual([{ data: {} }]);
    await rejectsConstraint("INSERT INTO kortix.artifact_events(artifact_id, project_id, type, actor_user_id, actor_session_id) VALUES ($1, $2, 'published', $3, $4)", [artifactId, projectId, userId, sessionId], '23514');
  });

  test('requires one author per Files commit and deletes receipts with the drive, while unshare deletes only events', async () => {
    for (const [user, session] of [[null, null], [userId, sessionId]]) {
      await rejectsConstraint('INSERT INTO kortix.drive_commit_authors(drive_id, commit_id, author_user_id, author_session_id) VALUES ($1, $2, $3, $4)', [driveId, 'commit-test', user, session], '23514');
    }
    await client.query('INSERT INTO kortix.drive_commit_authors(drive_id, commit_id, author_user_id) VALUES ($1, $2, $3)', [driveId, 'commit-test', userId]);
    await client.query('INSERT INTO kortix.drive_commit_authors(drive_id, commit_id, author_session_id) VALUES ($1, $2, $3)', [driveId, 'commit-agent', sessionId]);
    await rejectsConstraint('INSERT INTO kortix.drive_commit_authors(drive_id, commit_id, author_user_id) VALUES ($1, $2, $3)', [driveId, 'commit-test', userId], '23505');
    await client.query("INSERT INTO kortix.artifact_events(artifact_id, project_id, type) VALUES ($1, $2, 'published')", [artifactId, projectId]);
    await client.query('DELETE FROM kortix.artifacts WHERE artifact_id = $1', [artifactId]);
    expect((await client.query('SELECT count(*)::int AS n FROM kortix.artifact_events WHERE artifact_id = $1', [artifactId])).rows).toEqual([{ n: 0 }]);
    expect((await client.query('SELECT count(*)::int AS n FROM kortix.drive_commit_authors WHERE drive_id = $1', [driveId])).rows).toEqual([{ n: 2 }]);
    await client.query('DELETE FROM kortix.drives WHERE drive_id = $1', [driveId]);
    expect((await client.query('SELECT count(*)::int AS n FROM kortix.drive_commit_authors WHERE drive_id = $1', [driveId])).rows).toEqual([{ n: 0 }]);
  });

  test('retains verified provider IDs across retirement, row replacement and logical session purge, then purges with the project', async () => {
    await activate();
    expect(await identities()).toEqual([{ provider: 'platinum', external_id: externalId, session_id: sessionId }]);
    await client.query("UPDATE kortix.session_sandboxes SET external_id = NULL, status = 'stopped', metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object('ephemeralRetiredExternalId', $1::text) WHERE session_id = $2", [externalId, sessionId]);
    await client.query('DELETE FROM kortix.session_sandboxes WHERE session_id = $1', [sessionId]);
    expect(await identities()).toEqual([{ provider: 'platinum', external_id: externalId, session_id: sessionId }]);
    const replacementId = `${externalId}-replacement`;
    await insertSandbox(replacementId);
    expect(await identities()).toEqual([
      { provider: 'platinum', external_id: externalId, session_id: sessionId },
      { provider: 'platinum', external_id: replacementId, session_id: sessionId },
    ]);
    await client.query('DELETE FROM kortix.project_sessions WHERE session_id = $1', [sessionId]);
    expect(await identities()).toHaveLength(2);
    await client.query('DELETE FROM kortix.projects WHERE project_id = $1', [projectId]);
    expect(await identities()).toEqual([]);
  });

  test('does not treat standalone retirement metadata or mismatched tenant fields as verified provider identity', async () => {
    await client.query("UPDATE kortix.session_sandboxes SET status = 'stopped', metadata = jsonb_build_object('ephemeralRetiredExternalId', $1::text) WHERE session_id = $2", [externalId, sessionId]);
    await client.query('DELETE FROM kortix.session_sandboxes WHERE session_id = $1', [sessionId]);
    expect(await identities()).toEqual([]);
    const { rows: [other] } = await client.query("INSERT INTO kortix.accounts(name) VALUES ('Other activity account') RETURNING account_id");
    const { rows: [project] } = await client.query("INSERT INTO kortix.projects(account_id, name, repo_url) VALUES ($1, 'Other activity project', 'https://example.test/other.git') RETURNING project_id", [other.account_id]);
    await insertSandbox(externalId, other.account_id, project.project_id);
    expect((await client.query('SELECT count(*)::int AS n FROM kortix.session_sandbox_identities WHERE external_id = $1', [externalId])).rows).toEqual([{ n: 0 }]);
  });

  test('does not write identities on heartbeat columns and records a canonical identity update idempotently', async () => {
    await activate();
    await client.query('DELETE FROM kortix.session_sandbox_identities WHERE account_id = $1', [accountId]);
    await client.query('UPDATE kortix.session_sandboxes SET deadline_at = deadline_at, last_used_at = now() WHERE session_id = $1', [sessionId]);
    expect(await identities()).toEqual([]);
    await client.query('UPDATE kortix.session_sandboxes SET external_id = external_id WHERE session_id = $1', [sessionId]);
    await client.query('UPDATE kortix.session_sandboxes SET external_id = external_id WHERE session_id = $1', [sessionId]);
    expect(await identities()).toEqual([{ provider: 'platinum', external_id: externalId, session_id: sessionId }]);
  });
});
