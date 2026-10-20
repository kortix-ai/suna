import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import pg from 'pg';
import { up } from '../migrations/20261020154501000_archived_project_session_tokens.concurrent';

const url = process.env.TEST_DATABASE_URL;
const account = crypto.randomUUID();
const project = crypto.randomUUID();
const other = crypto.randomUUID();
let client: pg.Client;

async function token(projectId: string | null, sessionId: string | null) {
  const id = crypto.randomUUID();
  await client.query(`insert into kortix.account_tokens
    (token_id, account_id, user_id, project_id, session_id, name, public_key, secret_key_hash)
    values ($1::uuid, $2, $3, $4, $5, 'synthetic', $6, 'synthetic-hash')`,
    [id, account, crypto.randomUUID(), projectId, sessionId, `synthetic-${id}`]);
  return id;
}
async function read(id: string) {
  const { rows } = await client.query<{ status: string; revoked_at: Date | null }>(
    'select status, revoked_at from kortix.account_tokens where token_id = $1', [id]);
  return rows[0];
}

describe.skipIf(!url)('project archive revokes session credentials', () => {
  beforeAll(async () => {
    client = new pg.Client({ connectionString: url });
    await client.connect();
    await client.query("insert into kortix.accounts (account_id, name) values ($1, 'synthetic')", [account]);
    for (const id of [project, other]) {
      await client.query(`insert into kortix.projects (project_id, account_id, name, repo_url)
        values ($1, $2, 'synthetic', 'https://example.test/synthetic.git')`, [id, account]);
    }
  });
  afterAll(async () => {
    await client.query('delete from kortix.accounts where account_id = $1', [account]);
    await client.end();
  });
  test('archive revokes every session token, not neighboring or personal tokens', async () => {
    const first = await token(project, 'synthetic-session');
    const second = await token(project, 'synthetic-session');
    const neighbor = await token(other, 'synthetic-other');
    const personal = await token(null, null);
    const operator = await token(project, null);
    await client.query("update kortix.projects set status = 'archived' where project_id = $1", [project]);
    for (const id of [first, second]) {
      expect((await read(id)).status).toBe('revoked');
      expect((await read(id)).revoked_at).toBeInstanceOf(Date);
    }
    for (const id of [neighbor, personal, operator]) expect((await read(id)).status).toBe('active');
  });
  test('late mint and attempted reactivation cannot leave an archived project token active', async () => {
    await client.query("update kortix.projects set status = 'archived' where project_id = $1", [project]);
    const late = await token(project, 'synthetic-late');
    expect((await read(late)).status).toBe('revoked');
    await client.query("update kortix.account_tokens set status = 'active', revoked_at = null where token_id = $1", [late]);
    expect((await read(late)).status).toBe('revoked');
    expect((await read(late)).revoked_at).toBeInstanceOf(Date);
  });
  test('token usage updates do not deadlock with an archive holding the project lock', async () => {
    const usage = new pg.Client({ connectionString: url });
    await usage.connect();
    try {
      await client.query("update kortix.projects set status = 'active' where project_id = $1", [project]);
      const id = await token(project, 'synthetic-usage');
      await client.query('begin');
      await client.query('select project_id from kortix.projects where project_id = $1 for no key update', [project]);
      await usage.query("set statement_timeout = '1s'");
      await usage.query('update kortix.account_tokens set last_used_at = now() where token_id = $1', [id]);
      await client.query("update kortix.projects set status = 'archived' where project_id = $1", [project]);
      await client.query('commit');
      expect((await read(id)).status).toBe('revoked');
    } finally {
      await client.query('rollback');
      await usage.end();
    }
  });
  test('historical sweep revokes multiple batches and is idempotent', async () => {
    const admin = new pg.Client({ connectionString: process.env.TEST_DATABASE_SUPERUSER_URL ?? url });
    await admin.connect();
    try {
      // Reproduce rows written before the lifecycle guard existed.
      await admin.query('alter table kortix.account_tokens disable trigger guard_archived_project_session_token');
      await client.query(`insert into kortix.account_tokens
        (account_id, user_id, project_id, session_id, name, public_key, secret_key_hash)
        select $1, $2, $3, 'synthetic-historical', 'synthetic', gen_random_uuid()::text, 'synthetic-hash'
        from generate_series(1, 1001)`, [account, crypto.randomUUID(), project]);
    } finally {
      await admin.query('alter table kortix.account_tokens enable trigger guard_archived_project_session_token');
      await admin.end();
    }
    const migration = { noTransaction: () => {}, db: { query: (sql: string) => client.query(sql) } };
    await up(migration);
    const count = async () => (await client.query<{ count: string }>(
      "select count(*) from kortix.account_tokens where project_id = $1 and session_id = 'synthetic-historical' and status = 'revoked' and revoked_at is not null", [project])).rows[0].count;
    expect(await count()).toBe('1001');
    await up(migration);
    expect(await count()).toBe('1001');
  });

});
