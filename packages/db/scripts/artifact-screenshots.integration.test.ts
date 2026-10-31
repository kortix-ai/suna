import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import pg from 'pg';

const url = process.env.TEST_DATABASE_URL;
describe.skipIf(!url)('private screenshot receipts and deletion cascades', () => {
  const db = new pg.Client({ connectionString: url });
  let account: string, project: string, artifact: string, thread: string;
  const author = crypto.randomUUID();
  beforeAll(async () => { await db.connect(); });
  afterAll(async () => { await db.end(); });
  beforeEach(async () => {
    await db.query('BEGIN');
    account = (await db.query("INSERT INTO kortix.accounts(name) VALUES ('Screenshot receipt') RETURNING account_id")).rows[0].account_id;
    project = (await db.query("INSERT INTO kortix.projects(account_id,name,repo_url) VALUES ($1,'Screenshot receipt','https://example.test/receipt.git') RETURNING project_id", [account])).rows[0].project_id;
    const drive = (await db.query("INSERT INTO kortix.drives(account_id,project_id,kind,name,platinum_volume_name) VALUES ($1,$2,'project','Screenshot receipt',$3) RETURNING drive_id", [account, project, `receipt-${crypto.randomUUID()}`])).rows[0].drive_id;
    artifact = (await db.query("INSERT INTO kortix.artifacts(account_id,project_id,drive_id,root,entry,folder,title,type,created_by_user_id) VALUES ($1,$2,$3,'/receipt','index.html',true,'Screenshot receipt','html',$4) RETURNING artifact_id", [account, project, drive, author])).rows[0].artifact_id;
    thread = (await db.query("INSERT INTO kortix.artifact_comment_threads(artifact_id,project_id,anchor,anchor_version,created_by_user_id) VALUES ($1,$2,'{\"type\":\"none\",\"version\":\"v1\"}','v1',$3) RETURNING thread_id", [artifact, project, author])).rows[0].thread_id;
  });
  afterEach(async () => { await db.query('ROLLBACK'); });
  async function attachment() {
    const id = crypto.randomUUID(), key = `${project}/artifact-comments/${id}.png`;
    await db.query('INSERT INTO kortix.artifact_comment_screenshot_objects(object_key,project_id) VALUES ($1,$2)', [key, project]);
    await db.query("INSERT INTO kortix.artifact_comments(comment_id,thread_id,author_user_id,body,screenshot_key) VALUES ($1,$2,$3,'Attached',$4)", [id, thread, author, key]);
    await db.query("UPDATE kortix.artifact_comment_screenshot_objects SET state='attached',comment_id=$2 WHERE object_key=$1", [key, id]);
    return { id, key };
  }
  async function receipt(key: string) { return (await db.query('SELECT state,comment_id,next_attempt_at <= clock_timestamp() AS due FROM kortix.artifact_comment_screenshot_objects WHERE object_key=$1', [key])).rows[0]; }
  test('soft comment deletion records the object before redaction and keeps unrelated images attached', async () => {
    const first = await attachment(), second = await attachment();
    await db.query("UPDATE kortix.artifact_comments SET body='',marks='[]',screenshot_key=NULL,deleted_at=now() WHERE comment_id=$1", [first.id]);
    expect(await receipt(first.key)).toEqual({ state: 'deleting', comment_id: first.id, due: true });
    expect(await receipt(second.key)).toEqual({ state: 'attached', comment_id: second.id, due: false });
  });
  for (const scope of ['comment', 'artifact', 'project', 'account']) {
    test(`${scope} cascade retains a due object deletion receipt after its source is gone`, async () => {
      const saved = await attachment();
      const table = { comment: ['artifact_comments', 'comment_id', saved.id], artifact: ['artifacts', 'artifact_id', artifact], project: ['projects', 'project_id', project], account: ['accounts', 'account_id', account] }[scope]!;
      await db.query(`DELETE FROM kortix.${table[0]} WHERE ${table[1]}=$1`, [table[2]]);
      expect(await receipt(saved.key)).toEqual({ state: 'deleting', comment_id: null, due: true });
    });
  }
  test('an uncertain unreferenced upload retains an expiring receipt while attached keys remain protected', async () => {
    const attached = await attachment(), pending = `${project}/artifact-comments/${crypto.randomUUID()}.webp`;
    await db.query('INSERT INTO kortix.artifact_comment_screenshot_objects(object_key,project_id) VALUES ($1,$2)', [pending, project]);
    expect(await receipt(pending)).toEqual({ state: 'uploading', comment_id: null, due: false });
    expect(await receipt(attached.key)).toEqual({ state: 'attached', comment_id: attached.id, due: false });
    expect((await db.query("UPDATE kortix.artifact_comment_screenshot_objects SET state='deleting' WHERE object_key=$1 AND state='uploading' RETURNING object_key", [attached.key])).rows).toEqual([]);
  });
});
