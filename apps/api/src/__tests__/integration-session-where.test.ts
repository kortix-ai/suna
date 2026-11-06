/**
 * Integration test (real local DB): the one read behind a turn's
 * "## Where you are" block (`sessionWhereTurn`). It names the space a
 * session is filed in, the surface it started from, the person who started
 * it (by name, never email) and its parent session; a session in no space
 * says so.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { accounts, projectSessions, projectSpaces, projects } from '@kortix/db';
import { eq, sql } from 'drizzle-orm';
import { sessionWhereTurn } from '../projects/lib/session-where';
import { db } from '../shared/db';

const ACCOUNT = crypto.randomUUID();
const PROJECT = crypto.randomUUID();
const PRIYA = crypto.randomUUID();
const ENG = crypto.randomUUID();
const DM = crypto.randomUUID();
const THREAD = crypto.randomUUID();
const CHILD = crypto.randomUUID();
const DM_THREAD = crypto.randomUUID();
const LOOSE = crypto.randomUUID();

beforeAll(async () => {
  await db.execute(sql`
    insert into auth.users (id, email, instance_id, aud, role, raw_user_meta_data)
    values (${PRIYA}::uuid, 'priya.where@example.test', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', '{"full_name":"Priya Rao"}'::jsonb)`);
  await db.insert(accounts).values({ accountId: ACCOUNT, name: 'session-where' });
  await db.insert(projects).values({ projectId: PROJECT, accountId: ACCOUNT, name: 'Where', repoUrl: 'https://example.test/w.git', metadata: {} });
  await db.insert(projectSpaces).values([
    { spaceId: ENG, accountId: ACCOUNT, projectId: PROJECT, kind: 'channel', slug: `eng-${ENG.slice(0, 6)}`, name: 'Engineering', createdBy: PRIYA },
    { spaceId: DM, accountId: ACCOUNT, projectId: PROJECT, kind: 'dm', name: 'mykortix', dmUserId: PRIYA, dmAgentName: 'mykortix', createdBy: PRIYA },
  ]);
  const base = { accountId: ACCOUNT, projectId: PROJECT, agentName: 'mykortix', visibility: 'project' } as const;
  await db.insert(projectSessions).values([
    { ...base, sessionId: THREAD, branchName: THREAD, createdBy: PRIYA, spaceId: ENG, metadata: { source: 'ui', custom_name: 'Ship the launch page' } },
    { ...base, sessionId: CHILD, branchName: CHILD, createdBy: PRIYA, spaceId: ENG, parentSessionId: THREAD, metadata: { source: 'agent' } },
    { ...base, sessionId: DM_THREAD, branchName: DM_THREAD, createdBy: PRIYA, spaceId: DM, metadata: { source: 'cli' } },
    { ...base, sessionId: LOOSE, branchName: LOOSE, createdBy: null, metadata: { source: 'trigger:cron', trigger_slug: 'daily-report' } },
  ]);
});

afterAll(async () => {
  await db.delete(projects).where(eq(projects.accountId, ACCOUNT));
  await db.delete(accounts).where(eq(accounts.accountId, ACCOUNT));
  await db.execute(sql`delete from auth.users where id = ${PRIYA}::uuid`);
});

describe('sessionWhereTurn', () => {
  test('a channel thread: the channel with its name and id, the surface, the person by name', async () => {
    const where = await sessionWhereTurn(PROJECT, THREAD);
    expect(where!.space).toEqual({ kind: 'channel', dmAgent: null });
    expect(where!.system).toBe(
      ['## Where you are', `- Space: #eng-${ENG.slice(0, 6)} ("Engineering"), space ${ENG}`, '- Started from: the web app', '- Started by: Priya Rao'].join('\n'),
    );
    expect(where!.system).not.toContain('@');
  });

  test('a spawned session names its parent by title and id', async () => {
    const where = await sessionWhereTurn(PROJECT, CHILD);
    expect(where!.system).toContain('- Started from: another session');
    expect(where!.system).toContain(`- Parent session: "Ship the launch page", id ${THREAD}`);
  });

  test('a DM thread names the DM and its agent', async () => {
    const where = await sessionWhereTurn(PROJECT, DM_THREAD);
    expect(where!.space).toEqual({ kind: 'dm', dmAgent: 'mykortix' });
    expect(where!.system).toContain(`- Space: the person's personal space (private: only they and you), space ${DM}`);
  });

  test('a session in no space, started by a cron trigger; a session of another project is null', async () => {
    const where = await sessionWhereTurn(PROJECT, LOOSE);
    expect(where!.space).toBeNull();
    expect(where!.system).toBe(
      ['## Where you are', '- Started from: a scheduled trigger (daily-report)', '- Started by: no person (an automation)'].join('\n'),
    );
    expect(await sessionWhereTurn(crypto.randomUUID(), THREAD)).toBeNull();
  });
});
