import { afterAll, beforeAll, expect, mock, test } from 'bun:test';
import { accounts, projects, projectSecrets } from '@kortix/db';
import { eq, sql as drizzleSql } from 'drizzle-orm';
import postgres from 'postgres';
import { db } from '../shared/db';
import { mintSetupLink } from './token';

const propagated: string[] = [];
mock.module('../projects/lib/sandbox-env-sync', () => ({
  propagateProjectSecretsToActiveSandboxes: async (id: string) => { propagated.push(id); },
}));
const { setupLinksPublicApp } = await import('./public-app');
const accountId = crypto.randomUUID();
const projectId = crypto.randomUUID();
const sql = postgres(process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? '', { max: 1 });
let token: string;

beforeAll(async () => {
  await db.insert(accounts).values({ accountId, name: 'Intake lifecycle test' });
  await db.insert(projects).values({ projectId, accountId, name: 'Intake lifecycle test', repoUrl: 'https://example.test/test.git' });
  token = mintSetupLink(projectId, { kind: 'secret', fields: [{ name: 'TEST_KEY' }], scope: 'runtime', uid: null, sid: null }).token;
});
afterAll(async () => {
  await db.delete(accounts).where(eq(accounts.accountId, accountId));
  await sql.end();
});
// A link is single use per key, so every submission mints its own link.
async function submit(value: string) {
  const fresh = mintSetupLink(projectId, { kind: 'secret', fields: [{ name: 'TEST_KEY' }], scope: 'runtime', uid: null, sid: null }).token;
  await Bun.sleep(5);
  return setupLinksPublicApp.request(`/secret/${fresh}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ values: { TEST_KEY: value } }),
  });
}

test('active intake works; archive rejects the page and cannot overwrite the value', async () => {
  expect((await setupLinksPublicApp.request(`/secret/${token}`)).status).toBe(200);
  expect((await submit('synthetic-before')).status).toBe(200);
  const before = await db.select().from(projectSecrets).where(eq(projectSecrets.projectId, projectId));
  expect(before).toHaveLength(1);
  await db.update(projects).set({ status: 'archived' }).where(eq(projects.projectId, projectId));
  expect((await setupLinksPublicApp.request(`/secret/${token}`)).status).toBe(404);
  expect((await submit('synthetic-after')).status).toBe(404);
  expect(await db.select().from(projectSecrets).where(eq(projectSecrets.projectId, projectId))).toEqual(before);
  expect(propagated).toEqual([projectId]);
});

test('an uncommitted archive blocks submission, which rejects after archive commits', async () => {
  await db.update(projects).set({ status: 'active' }).where(eq(projects.projectId, projectId));
  const before = await db.select().from(projectSecrets).where(eq(projectSecrets.projectId, projectId));
  let submission: Promise<Response> | undefined;
  try {
    await sql.begin(async transaction => {
      const [holder] = await transaction`select pg_backend_pid() as pid`;
      await transaction`update kortix.projects set status = 'archived' where project_id = ${projectId}`;
      submission = submit('concurrent-value');
      const deadline = Date.now() + 5000;
      let blocked = false;
      while (Date.now() < deadline) {
        const result = await db.execute<{ blocked: boolean }>(
          drizzleSql`select exists(select 1 from pg_stat_activity where ${holder.pid} = any(pg_blocking_pids(pid))) as blocked`,
        );
        blocked = result[0]?.blocked === true;
        if (blocked) break;
        await Bun.sleep(10);
      }
      expect(blocked).toBe(true);
    });
  } finally {
    if (submission) await submission;
  }
  if (!submission) throw new Error('Submission was not started');
  expect((await submission).status).toBe(404);
  expect(await db.select().from(projectSecrets).where(eq(projectSecrets.projectId, projectId))).toEqual(before);
});

test('submission holds the project lock until its secret write commits', async () => {
  await db.update(projects).set({ status: 'active' }).where(eq(projects.projectId, projectId));
  const control = postgres(process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? '', { max: 1 });
  const observer = postgres(process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? '', { max: 1 });
  let submission: Promise<Response> | undefined;
  let archive: Promise<unknown> | undefined;
  let response: Response | undefined;
  try {
    await sql`create function kortix.intake_test_pause() returns trigger language plpgsql as $$
      begin perform pg_advisory_xact_lock(991); return new; end $$`;
    await sql`create trigger intake_test_pause before insert on kortix.project_secrets
      for each row execute function kortix.intake_test_pause()`;
    await control`select pg_advisory_lock(991)`;
    const [holder] = await control`select pg_backend_pid() as pid`;
    submission = submit('submission-first');
    const deadline = Date.now() + 5000;
    let writerPid: number | undefined;
    while (Date.now() < deadline) {
      const rows = await observer`select pid from pg_stat_activity where ${holder.pid} = any(pg_blocking_pids(pid))`;
      writerPid = rows[0]?.pid;
      if (writerPid) break;
      await Bun.sleep(10);
    }
    if (!writerPid) throw new Error('Secret write did not reach the pause trigger');
    archive = sql`update kortix.projects set status = 'archived' where project_id = ${projectId}`.execute();
    let blocked = false;
    while (Date.now() < deadline) {
      const rows = await observer`select exists(select 1 from pg_stat_activity where ${writerPid} = any(pg_blocking_pids(pid))) as blocked`;
      blocked = rows[0]?.blocked === true;
      if (blocked) break;
      await Bun.sleep(10);
    }
    expect(blocked).toBe(true);
  } finally {
    await control`select pg_advisory_unlock(991)`;
    try {
      try {
        if (submission) response = await submission;
      } finally {
        if (archive) await archive;
      }
    } finally {
      try {
        await sql`drop trigger if exists intake_test_pause on kortix.project_secrets`;
        await sql`drop function if exists kortix.intake_test_pause()`;
      } finally {
        await control.end();
        await observer.end();
      }
    }
  }
  expect(response?.status).toBe(200);
  expect((await setupLinksPublicApp.request(`/secret/${token}`)).status).toBe(404);
  expect((await submit('after-archive')).status).toBe(404);
});
