import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import pg from 'pg';

const databaseUrl = process.env.TEST_DATABASE_URL;
describe.skipIf(!databaseUrl)('artifact comment notification schema', () => {
  const db = new pg.Client({ connectionString: databaseUrl });
  let accountId: string;
  let projectId: string;
  let artifactId: string;
  let threadId: string;
  const userId = crypto.randomUUID();
  beforeAll(async () => { await db.connect(); });
  afterAll(async () => { await db.end(); });
  beforeEach(async () => {
    await db.query('BEGIN');
    accountId = (await db.query("INSERT INTO kortix.accounts(name) VALUES ('Comment routing schema') RETURNING account_id")).rows[0].account_id;
    projectId = (await db.query("INSERT INTO kortix.projects(account_id,name,repo_url) VALUES ($1,'Comment routing schema','https://example.test/comments.git') RETURNING project_id", [accountId])).rows[0].project_id;
    const driveId = (await db.query("INSERT INTO kortix.drives(account_id,project_id,kind,name,platinum_volume_name) VALUES ($1,$2,'project','Routing schema',$3) RETURNING drive_id", [accountId, projectId, `schema-${crypto.randomUUID()}`])).rows[0].drive_id;
    artifactId = (await db.query("INSERT INTO kortix.artifacts(account_id,project_id,drive_id,root,entry,folder,title,type,created_by_user_id) VALUES ($1,$2,$3,'/schema','index.md',true,'Routing schema','doc',$4) RETURNING artifact_id", [accountId, projectId, driveId, userId])).rows[0].artifact_id;
    threadId = (await db.query("INSERT INTO kortix.artifact_comment_threads(artifact_id,project_id,anchor,anchor_version,created_by_user_id) VALUES ($1,$2,'{\"type\":\"none\",\"version\":\"v1\"}','v1',$3) RETURNING thread_id", [artifactId, projectId, userId])).rows[0].thread_id;
  });
  afterEach(async () => { await db.query('ROLLBACK'); });

  async function notification(kind: string, artifact: string | null = artifactId, thread: string | null = threadId) {
    return db.query('INSERT INTO kortix.notifications(user_id,account_id,project_id,kind,title,artifact_id,artifact_thread_id) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING notification_id', [userId, accountId, projectId, kind, 'Artifact comment', artifact, thread]);
  }
  async function rejects(write: () => Promise<unknown>, code: string) {
    await db.query('SAVEPOINT rejected');
    await expect(write()).rejects.toMatchObject({ code });
    await db.query('ROLLBACK TO SAVEPOINT rejected');
  }

  test('accepts the new notification kind and preserves old kinds with nullable Artifact targets', async () => {
    await notification('artifact_comment');
    await notification('turn_done', null, null);
    expect((await db.query('SELECT kind,artifact_id,artifact_thread_id FROM kortix.notifications WHERE account_id=$1 ORDER BY kind', [accountId])).rows).toEqual([
      { kind: 'artifact_comment', artifact_id: artifactId, artifact_thread_id: threadId },
      { kind: 'turn_done', artifact_id: null, artifact_thread_id: null },
    ]);
    await rejects(() => notification('unknown_kind'), '23514');
  });

  test('rejects missing targets and erases only the notifications whose Artifact or thread is deleted', async () => {
    await rejects(() => notification('artifact_comment', crypto.randomUUID()), '23503');
    await rejects(() => notification('artifact_comment', artifactId, crypto.randomUUID()), '23503');
    await notification('artifact_comment');
    await notification('shared', artifactId, null);
    await notification('turn_done', null, null);
    await db.query('DELETE FROM kortix.artifact_comment_threads WHERE thread_id=$1', [threadId]);
    expect((await db.query('SELECT kind FROM kortix.notifications WHERE account_id=$1 ORDER BY kind', [accountId])).rows).toEqual([{ kind: 'shared' }, { kind: 'turn_done' }]);
    await db.query('DELETE FROM kortix.artifacts WHERE artifact_id=$1', [artifactId]);
    expect((await db.query('SELECT kind FROM kortix.notifications WHERE account_id=$1', [accountId])).rows).toEqual([{ kind: 'turn_done' }]);
  });

  test('retains an optional delivery error without changing the loop-guard state vocabulary', async () => {
    expect((await db.query('SELECT agent_error FROM kortix.artifact_comment_threads WHERE thread_id=$1', [threadId])).rows[0].agent_error).toBeNull();
    await db.query("UPDATE kortix.artifact_comment_threads SET agent_state='paused',agent_error='Delivery failed. Send this thread again.' WHERE thread_id=$1", [threadId]);
    expect((await db.query('SELECT agent_state,agent_error FROM kortix.artifact_comment_threads WHERE thread_id=$1', [threadId])).rows[0]).toEqual({ agent_state: 'paused', agent_error: 'Delivery failed. Send this thread again.' });
  });

  test('unsharing erases scoped delivery jobs and captured prompts and preserves unrelated work', async () => {
    const scopedJob = (await db.query("INSERT INTO kortix.job_queue(queue,job_key,artifact_id,payload) VALUES ('artifact-comment-agents',$1,$2,'{\"text\":\"Captured feedback\"}') RETURNING job_id", [crypto.randomUUID(), artifactId])).rows[0].job_id;
    const unrelatedJob = (await db.query("INSERT INTO kortix.job_queue(queue,job_key) VALUES ('unrelated',$1) RETURNING job_id", [crypto.randomUUID()])).rows[0].job_id;
    const scopedCommand = (await db.query("INSERT INTO kortix.session_lifecycle_commands(command_type,source,account_id,project_id,artifact_id,payload) VALUES ('create_session','system:artifact-comment',$1,$2,$3,'{\"text\":\"Captured feedback\"}') RETURNING command_id", [accountId, projectId, artifactId])).rows[0].command_id;
    const unrelatedCommand = (await db.query("INSERT INTO kortix.session_lifecycle_commands(command_type,source,account_id,project_id) VALUES ('create_session','ui',$1,$2) RETURNING command_id", [accountId, projectId])).rows[0].command_id;
    await rejects(() => db.query("INSERT INTO kortix.job_queue(queue,job_key,artifact_id) VALUES ('artifact-comment-agents',$1,$2)", [crypto.randomUUID(), crypto.randomUUID()]), '23503');
    await db.query('DELETE FROM kortix.artifacts WHERE artifact_id=$1', [artifactId]);
    expect((await db.query('SELECT job_id FROM kortix.job_queue WHERE job_id=ANY($1::uuid[])', [[scopedJob, unrelatedJob]])).rows).toEqual([{ job_id: unrelatedJob }]);
    expect((await db.query('SELECT command_id FROM kortix.session_lifecycle_commands WHERE command_id=ANY($1::uuid[])', [[scopedCommand, unrelatedCommand]])).rows).toEqual([{ command_id: unrelatedCommand }]);
  });
});
